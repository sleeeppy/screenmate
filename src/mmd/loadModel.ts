import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import "babylon-mmd/esm/Loader/mmdModelLoader";
import "babylon-mmd/esm/Loader/mmdOutlineRenderer";
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
import { createProceduralSlot } from "../motion/proceduralSlot";
import { calibrate, type Calibration } from "./calibration";
import { resolveMorphs, type ResolvedMorphs } from "./morphMap";
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
  // 실제 경과 시간으로 1/60초 고정 스텝을 돌린다. 렌더 fps(72·29)와 무관하게 물리 속도가 같다.
  physics.useDeltaForWorldStep = true;
  physics.fixedTimeStep = 1 / 60;
  physics.maxSubSteps = 3;
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
  resetPhysics(): void;
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
  const overrides = readOverrides(entry.profile);
  const { calibration, morphs } = applyOverrides(computedCalibration, computedMorphs, overrides);

  place(mesh, calibration);
  mesh.computeWorldMatrix(true);
  const model = world.runtime.createMmdModel(mesh, {
    materialProxyConstructor: MmdStandardMaterialProxy,
    buildPhysics: overrides.physics ?? true,
  });
  model.setRuntimeAnimation(model.createRuntimeAnimation(createProceduralSlot(morphs)));

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
    resetPhysics: () => model.initializePhysics(),
    dispose: () => {
      world.runtime.destroyMmdModel(model);
      container.dispose();
    },
  };
}
