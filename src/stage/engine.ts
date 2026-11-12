import "@babylonjs/core/Shaders/default.fragment";
import "@babylonjs/core/Shaders/default.vertex";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { SdefInjector } from "babylon-mmd/esm/Loader/sdefInjector";
import { diag, onCursor, type CursorEvent, type ModelListing, type StageInfo } from "../ipc";
import { createMmdWorld, loadCharacter, type LoadedCharacter, type MmdWorld } from "../mmd/loadModel";
import { idle, motionByName } from "../motion/clips/index.ts";
import type { GazeTarget } from "../motion/layers";
import { aimAtBox, createStageCamera } from "./camera";
import { FollowBox } from "./followBox";
import { FramePacer, type Activity } from "./framePacer";
import { HitTester } from "./hitTest";
import { StageSpace } from "./space";

/** 모델을 바꾸거나 텔레포트한 뒤 물리가 가라앉을 때까지 활성 fps를 유지하는 시간 */
const SETTLE_MS = 2500;
/** 걷기 미리보기 때 몸 방향: 화면 오른쪽(+x)으로 걷는 3/4 측면 */
const WALK_PREVIEW_FACING = (-70 * Math.PI) / 180;
const LIGHT = { direction: [0.55, -0.8, 0.75] as [number, number, number], key: 0.78, fill: 0.18 };
/** 키 260px일 때 윤곽선 배율 (모델 edgeSize 기준) */
const OUTLINE_SCALE = 0.45;
/** 업로드할 텍스처의 최대 한 변 길이 */
const MAX_TEXTURE_SIZE = 1024;

export class Stage {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly camera;
  private readonly box: FollowBox;
  private readonly hit: HitTester;
  private readonly pacer = new FramePacer();
  private readonly space: StageSpace;
  private world: MmdWorld | null = null;
  private character: LoadedCharacter | null = null;
  private cursor: CursorEvent | null = null;
  private loadToken = 0;
  private activeUntil = 0;

  /** 캐릭터 키(頭 본 높이) CSS px */
  heightPx = 260;
  /** 발 위치 CSS px (M4에서 행동 시스템이 움직인다) */
  feet = { x: 0, y: 0 };
  /** 몸 방향 (라디안, 0 = 정면). Y+ 회전은 모델의 오른쪽(화면 왼쪽)으로 돈다. */
  facing = 0;
  private motionName = "idle";
  /** 성능 측정용: 커서를 무시하고 대기 fps로 고정 (`--bench-idle`) */
  benchIdle = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private info: StageInfo,
  ) {
    // premultipliedAlpha: 투명 배경 위에 SRC_ALPHA 블렌딩한 결과(rgb·a, a)는 곧 premultiplied 값이다.
    // 그래야 머리카락 끝 같은 반투명 가장자리가 바탕화면과 어둡게 테 두르지 않고 섞인다.
    this.engine = new Engine(
      canvas,
      true,
      { alpha: true, premultipliedAlpha: true, antialias: true, stencil: true, adaptToDeviceRatio: true },
      true,
    );
    SdefInjector.OverrideEngineCreateEffect(this.engine);
    // 캐릭터는 화면에서 400~500px 크기라 2048 텍스처는 과하다. 이 값보다 큰 텍스처는 올릴 때
    // 2:1로 줄인다 (2048→1024는 정확한 박스 필터라 손실이 거의 없음). GPU 메모리를 크게 줄인다.
    this.engine.getCaps().maxTextureSize = Math.min(this.engine.getCaps().maxTextureSize, MAX_TEXTURE_SIZE);

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.scene.skipPointerMovePicking = true;
    this.camera = createStageCamera(this.scene);
    // 조명: 빛을 화면 왼쪽 위 비스듬히(모델 기준 오른쪽 위 앞)에서 넣어 툰 음영 경계가 보이게 한다.
    // 정면 빛은 MMD와 밝기는 같지만 그림자 쪽이 안 생겨 옛 PMD가 납작하고 하얗게 보였다.
    // 보조광(반구광)은 평평하게 만드는 쪽이라 약하게.
    this.scene.ambientColor = new Color3(0.5, 0.5, 0.5);
    const fill = new HemisphericLight("fill", new Vector3(0, 1, 0), this.scene);
    fill.intensity = LIGHT.fill;
    fill.specular.set(0, 0, 0);
    fill.groundColor.set(1, 1, 1);
    const key = new DirectionalLight("key", new Vector3(...LIGHT.direction), this.scene);
    key.intensity = LIGHT.key;

    this.space = new StageSpace(info.height, 1);
    this.box = new FollowBox(canvas, () => this.engine.resize());
    this.hit = new HitTester(this.engine, canvas, this.box);
    this.placeOnGround();

    void onCursor((event) => {
      this.cursor = event.near && !this.benchIdle ? event : null;
    });
    window.addEventListener("resize", () => this.engine.resize());
    this.startLoop();
  }

  updateInfo(info: StageInfo): void {
    this.info = info;
    this.space.stageHeight = info.height;
    this.placeOnGround();
    this.syncCharacter();
    this.character?.mesh.computeWorldMatrix(true);
    this.character?.resetPhysics();
  }

  setHeight(heightPx: number): void {
    if (Math.abs(heightPx - this.heightPx) < 0.5) {
      return;
    }
    this.heightPx = heightPx;
    // 월드 배율이 바뀌면 같은 화면 위치라도 월드 좌표가 달라진다 = 순간이동.
    // 새 위치를 반영한 뒤 강체를 다시 놓는다.
    this.syncCharacter();
    this.applyOutline();
    this.character?.mesh.computeWorldMatrix(true);
    this.character?.resetPhysics();
    this.wake();
  }

  /**
   * 윤곽선은 화면 픽셀 기준 두께(edgeSize × 약 2px)라서 캐릭터가 작을수록 상대적으로 두꺼워 보인다.
   * MMD처럼 캐릭터가 화면을 채울 때의 비율에 맞춰 키에 비례해 줄인다.
   */
  private applyOutline(): void {
    this.character?.setOutlineScale(OUTLINE_SCALE * (this.heightPx / 260));
  }

  /** 모델을 불러온다. 연속 호출되면 마지막 요청만 반영한다. */
  async load(entry: ModelListing): Promise<LoadedCharacter | null> {
    const token = ++this.loadToken;
    this.world ??= await createMmdWorld(this.scene);
    const loaded = await loadCharacter(this.world, this.scene, entry, (mesh, calibration) => {
      // 강체가 만들어지기 전에 최종 위치에 둔다.
      const world = new StageSpace(this.space.stageHeight, this.heightPx / calibration.headY).toWorld(
        this.feet.x,
        this.feet.y,
      );
      mesh.position.set(world.x, world.y, 0);
      mesh.rotation.y = this.facing;
    }, { gaze: () => this.gazeTarget() });
    if (token !== this.loadToken) {
      loaded.dispose();
      return null;
    }
    this.character?.dispose();
    this.character = loaded;
    this.hit.release();
    this.syncCharacter();
    this.applyOutline();
    this.playMotion(this.motionName);
    this.wake();
    // 모델 간 자세 차이 확인용: 모션이 자리 잡은 뒤 실제 팔 각도를 남긴다.
    window.setTimeout(() => {
      if (this.character === loaded) diag(`pose ${loaded.entry.id} ${armAngles(loaded)}`);
    }, 3000);
    return loaded;
  }

  /**
   * 모션 재생. 한 번 재생하는 모션(착지 등)은 끝나면 idle로 돌아간다.
   * 걷기는 정면에서 보면 다리가 앞뒤로만 움직여 안 보이므로 몸을 옆으로 돌린다 (M4에서 이동 방향으로).
   */
  playMotion(name: string): void {
    const motion = motionByName(name) ?? idle;
    const changed = motion.name !== this.motionName;
    this.motionName = motion.name;
    this.facing = motion.name === "walk" ? WALK_PREVIEW_FACING : 0;
    this.character?.motion.play(motion, {
      restart: true,
      onFinished: motion.loop ? undefined : () => this.playMotion("idle"),
    });
    this.wake();
    if (this.character) diag(`motion ${motion.name}`);
    if (changed) this.onMotionChanged?.();
  }

  get currentMotion(): string {
    return this.motionName;
  }

  /** 모션이 바뀌었을 때 (트레이 체크 표시 갱신용) */
  onMotionChanged: (() => void) | null = null;

  /** 커서를 머리 기준 모델 로컬 좌표로. 커서가 멀면 null (정면 응시). */
  private gazeTarget(): GazeTarget | null {
    const character = this.character;
    const cursor = this.cursor;
    if (!character || !cursor) {
      return null;
    }
    const world = this.space.toWorld(cursor.x, cursor.y);
    const head = character.mesh.position;
    // 몸을 돌리고 있으면 화면 가로 거리가 모델 로컬 x로는 cos만큼 줄어든다.
    return {
      dx: (world.x - head.x) * Math.cos(this.facing),
      dy: world.y - (head.y + character.calibration.headY),
    };
  }

  unload(): void {
    this.loadToken += 1;
    this.character?.dispose();
    this.character = null;
    this.hit.release();
  }

  private placeOnGround(): void {
    const area = this.info.workArea;
    this.feet = { x: area.x + area.width / 2, y: area.y + area.height };
  }

  private wake(): void {
    this.activeUntil = performance.now() + SETTLE_MS;
  }

  /** 발 위치·배율을 월드와 카메라·캔버스에 반영한다. */
  private syncCharacter(): void {
    const character = this.character;
    if (!character) {
      return;
    }
    this.space.pixelsPerUnit = this.heightPx / character.calibration.headY;
    const world = this.space.toWorld(this.feet.x, this.feet.y);
    character.mesh.position.set(world.x, world.y, 0);
    character.mesh.rotation.y = this.facing;
    const rect = this.box.update(this.feet.x, this.feet.y, this.heightPx);
    aimAtBox(this.camera, rect, this.space);
  }

  /**
   * engine.runRenderLoop()은 쓰지 않는다. 그 루프는 그리지 않는 vsync에도 beginFrame()을 불러
   * 델타 시간이 한 vsync(144Hz면 6.9ms)로 잡히고, 2~5 vsync마다 그리면 물리·애니메이션이
   * 그만큼 느려진다. 실제로 그리는 프레임에서만 beginFrame()을 불러 델타를 맞춘다.
   */
  private startLoop(): void {
    let frames = 0;
    let renderMs = 0;
    let stamp = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      const activity: Activity =
        this.hit.capturing || now < this.activeUntil ? "interact" : this.cursor !== null ? "near" : "idle";
      // 캐릭터가 없으면 그릴 것도 없다 (vsync 간격 측정만 계속)
      if (!this.pacer.tick(now, activity) || !this.character) {
        return;
      }
      this.syncCharacter();
      const before = performance.now();
      this.engine.beginFrame();
      this.scene.render();
      this.engine.endFrame();
      renderMs += performance.now() - before;
      this.hit.sample(this.cursor);
      frames += 1;
      if (now - stamp >= 5000) {
        const seconds = (now - stamp) / 1000;
        diag(
          `fps=${(frames / seconds).toFixed(1)} render=${(renderMs / Math.max(1, frames)).toFixed(2)}ms ` +
            `activity=${activity} hz=${this.pacer.refreshRate} canvas=${this.canvas.width}x${this.canvas.height} motion=${this.motionName}`,
        );
        frames = 0;
        renderMs = 0;
        stamp = now;
      }
    };
    requestAnimationFrame(loop);
  }
}

/** 현재 자세의 팔 각도 (수평에서 아래로, 도). 모델 간 모션 결과 비교용. */
function armAngles(character: LoadedCharacter): string {
  const position = (name: string) => {
    const bone = character.model.runtimeBones.find((candidate) => candidate.name === name);
    return bone ? bone.getWorldTranslationToRef(new Vector3()) : null;
  };
  const angle = (side: "左" | "右") => {
    const shoulder = position(`${side}腕`);
    const elbow = position(`${side}ひじ`);
    if (!shoulder || !elbow) return "?";
    const dx = Math.hypot(elbow.x - shoulder.x, elbow.z - shoulder.z);
    return ((Math.atan2(shoulder.y - elbow.y, dx) * 180) / Math.PI).toFixed(1);
  };
  return `armDown=${angle("左")}/${angle("右")}`;
}
