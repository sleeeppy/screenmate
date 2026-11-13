import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import "babylon-mmd/esm/Loader/mmdModelLoader";
import "babylon-mmd/esm/Loader/mmdOutlineRenderer";
import { MmdStandardMaterial } from "babylon-mmd/esm/Loader/mmdStandardMaterial";
import type { MmdModelMetadata } from "babylon-mmd/esm/Loader/mmdModelMetadata";
import "babylon-mmd/esm/Loader/pmdLoader";
import "babylon-mmd/esm/Loader/pmxLoader";
import { MmdWasmInstanceTypeSPR } from "babylon-mmd/esm/Runtime/Optimized/InstanceType/singlePhysicsRelease";
import { GetMmdWasmInstance } from "babylon-mmd/esm/Runtime/Optimized/mmdWasmInstance";
import { MultiPhysicsRuntime } from "babylon-mmd/esm/Runtime/Optimized/Physics/Bind/Impl/multiPhysicsRuntime";
import { MmdBulletPhysics } from "babylon-mmd/esm/Runtime/Optimized/Physics/mmdBulletPhysics";
import type { MmdModel } from "babylon-mmd/esm/Runtime/mmdModel";
import { MmdRuntime } from "babylon-mmd/esm/Runtime/mmdRuntime";
import { MmdStandardMaterialProxy } from "babylon-mmd/esm/Runtime/mmdStandardMaterialProxy";
import { mateUrl, type ModelListing } from "../ipc";
import { MotionDriver, type DriverInputs } from "../motion/driver";
import { createProceduralSlot } from "../motion/proceduralSlot";
import { calibrate, type Calibration } from "./calibration";
import { resolveMorphs, type ResolvedMorphs } from "./morphMap";
import { presetOverrides } from "./presets";
import { applyOverrides, readOverrides } from "./profile";

/** 장면당 하나: MMD 런타임과 Bullet 물리 */
export interface MmdWorld {
  runtime: MmdRuntime;
  physics: MultiPhysicsRuntime;
}

export async function createMmdWorld(scene: Scene): Promise<MmdWorld> {
  const wasm = await GetMmdWasmInstance(new MmdWasmInstanceTypeSPR());
  const physics = new MultiPhysicsRuntime(wasm);
  physics.setGravity(new Vector3(0, -98, 0));
  // 실제 경과 시간으로 1/120초 고정 스텝을 돌린다. 렌더 fps(72·29)와 무관하게 물리 속도가 같다.
  // 1/60이면 Sour 치마(가벼운 강체 112개를 ±1° 조인트로 묶음)가 서 있기만 해도 프레임마다 최대 0.7 단위씩
  // 튀었다. 1/120에서 최대 0.17로 줄었다 (1/240은 더 나아지지 않음). 렌더가 0.1초까지 밀려도 따라가도록 12스텝.
  physics.useDeltaForWorldStep = true;
  physics.fixedTimeStep = 1 / 120;
  physics.maxSubSteps = 12;
  physics.register(scene);

  const runtime = new MmdRuntime(scene, new MmdBulletPhysics(physics));
  runtime.register(scene);
  void runtime.playAnimation();
  return { runtime, physics };
}

export interface LoadedCharacter {
  entry: ModelListing;
  mesh: Mesh;
  model: MmdModel;
  /** 덮어쓰기까지 반영된 값 */
  calibration: Calibration;
  morphs: ResolvedMorphs;
  /** 프로필 `computed`에 저장할 자동 계산 값 */
  computedCalibration: Calibration;
  computedMorphs: ResolvedMorphs;
  morphNames: string[];
  loadMs: number;
  /** 모션 재생기 */
  motion: MotionDriver;
  resetPhysics(): void;
  /** 텍스처를 모두 읽고 재질 셰이더를 컴파일하면 풀린다 */
  ready: Promise<void>;
  /** 메시 보이기/숨기기 (숨겨도 애니메이션·물리는 계속 돈다) */
  setVisible(visible: boolean): void;
  /** 윤곽선 두께 배율 (모델 edgeSize 기준). 프로필 overrides.edgeScale이 곱해진다. */
  setOutlineScale(scale: number): void;
  dispose(): void;
}

/**
 * @param place 런타임 모델(물리 강체)을 만들기 직전에 메시를 최종 위치에 놓는 콜백.
 *   원점에서 만든 뒤 옮기면 강체가 원점 기준으로 초기화되어 치마 등이 끌려간다.
 */
export async function loadCharacter(
  world: MmdWorld,
  scene: Scene,
  entry: ModelListing,
  place: (mesh: Mesh, calibration: Calibration) => void,
  inputs: DriverInputs,
): Promise<LoadedCharacter> {
  const started = performance.now();
  const url = mateUrl(`models/${entry.file}`);
  // 재질 알파는 babylon-mmd 기본 처리(텍스처 알파 평가)를 그대로 쓴다.
  // 불투명 판정 재질은 출력 알파가 1이고, 오려낸 재질만 블렌딩하며 대상 알파를 보존한다
  // (ALPHA_COMBINE: 알파 채널은 ONE, ONE). 그래서 투명 창에서도 구멍이 생기지 않는다.
  const container = await LoadAssetContainerAsync(url, scene, {
    pluginExtension: `.${entry.format}`,
    pluginOptions: { mmdmodel: { loggingEnabled: false } },
  });
  container.addAllToScene();
  const mesh = container.meshes[0] as Mesh;
  mesh.computeWorldMatrix(true);

  // babylon-mmd는 스켈레톤을 루트가 아니라 자식 메시와 메타데이터에 붙인다.
  const skeleton = (mesh.metadata as MmdModelMetadata | null)?.skeleton ?? container.skeletons[0] ?? null;
  if (!skeleton) {
    container.dispose();
    throw new Error(`${entry.name}: 스켈레톤이 없습니다`);
  }
  // createMmdModel이 메타데이터를 정리하기 전에 모프 이름을 읽어 둔다.
  const morphNames = ((mesh.metadata as MmdModelMetadata | null)?.morphs ?? []).map((morph) => morph.name);
  const computedCalibration = calibrate(skeleton);
  const computedMorphs = resolveMorphs(morphNames);
  const overrides = { ...presetOverrides(entry.id), ...readOverrides(entry.profile) };
  const { calibration, morphs } = applyOverrides(computedCalibration, computedMorphs, overrides);

  // 재질 프록시가 생성 시점 값을 기준으로 재질 모프를 되돌리므로 런타임 모델보다 먼저 바꾼다.
  if (overrides.ambientScale !== undefined && overrides.ambientScale !== 1) {
    for (const material of container.materials) {
      if (material instanceof MmdStandardMaterial) material.ambientColor.scaleInPlace(overrides.ambientScale);
    }
  }

  place(mesh, calibration);
  mesh.computeWorldMatrix(true);
  const model = world.runtime.createMmdModel(mesh, {
    materialProxyConstructor: MmdStandardMaterialProxy,
    buildPhysics: overrides.physics ?? true,
  });
  let driver: MotionDriver | null = null;
  const slot = createProceduralSlot((runtimeModel) => {
    driver = new MotionDriver(runtimeModel, calibration, morphs, inputs);
    return driver;
  });
  model.setRuntimeAnimation(model.createRuntimeAnimation(slot));
  if (!driver) {
    container.dispose();
    throw new Error(`${entry.name}: 모션 드라이버를 만들지 못했습니다`);
  }

  // 윤곽선 기본 두께(모델이 정한 edgeSize)를 기억해 두고 화면 크기에 맞춰 줄인다.
  const outlines = container.materials
    .filter((material): material is MmdStandardMaterial => material instanceof MmdStandardMaterial)
    .filter((material) => material.renderOutline)
    .map((material) => ({ material, base: material.outlineWidth }));
  const edgeScale = overrides.edgeScale ?? 1;

  return {
    entry,
    mesh,
    model,
    calibration,
    morphs,
    computedCalibration,
    computedMorphs,
    morphNames,
    loadMs: Math.round(performance.now() - started),
    motion: driver,
    resetPhysics: () => model.initializePhysics(),
    ready: whenReady(container.textures, container.meshes),
    setVisible: (visible) => {
      for (const part of container.meshes) part.isVisible = visible;
    },
    setOutlineScale: (scale) => {
      for (const { material, base } of outlines) material.outlineWidth = base * scale * edgeScale;
    },
    dispose: () => {
      world.runtime.destroyMmdModel(model);
      container.dispose();
    },
  };
}

/** 텍스처를 모두 읽고, 메시마다 재질 셰이더를 미리 컴파일한다 (실패해도 너무 오래 숨기지 않게 2초 상한). */
function whenReady(textures: BaseTexture[], meshes: AbstractMesh[]): Promise<void> {
  const textured = new Promise<void>((resolve) => BaseTexture.WhenAllReady(textures, () => resolve()));
  const compiled = textured.then(() =>
    Promise.all(
      meshes.map((part) => (part.material ? part.material.forceCompilationAsync(part).catch(() => {}) : Promise.resolve())),
    ).then(() => {}),
  );
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, 2000));
  return Promise.race([compiled, timeout]);
}
