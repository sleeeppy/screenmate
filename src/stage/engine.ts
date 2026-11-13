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
import { Behavior, rotateCss, type Arena } from "../behavior/behavior.ts";
import { attachPointer } from "../behavior/interaction";
import { idle, motionByName } from "../motion/clips/index.ts";
import { WALK_SPEED_UNITS } from "../motion/clips/walk.ts";
import type { GazeTarget } from "../motion/layers";
import { aimAtBox, createStageCamera } from "./camera";
import { FollowBox } from "./followBox";
import { FramePacer, type Activity } from "./framePacer";
import { HitTester } from "./hitTest";
import { StageSpace } from "./space";

/** 모델을 바꾸거나 텔레포트한 뒤 물리가 가라앉을 때까지 활성 fps를 유지하는 시간 */
const SETTLE_MS = 2500;
/** 들렸을 때·떨어질 때 캔버스 상자 (키 대비 정사각형 한 변, 중심은 발에서 키 0.72배 위) */
const FREE_BOX = { size: 2.1, center: 0.72 };
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
  /** 행동: 발 위치·몸 방향·기울기를 정한다 */
  readonly behavior: Behavior;
  private motionName = "idle";
  private lastFrame = 0;
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
    // 키보드 입력은 쓰지 않는다. 포커스를 받으면 포커스 링이 그려지므로 아예 못 받게 한다.
    canvas.tabIndex = -1;
    canvas.addEventListener("pointerdown", (event) => event.preventDefault());
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

    const stage = this;
    this.behavior = new Behavior({
      get heightPx() {
        return stage.heightPx;
      },
      get walkSpeedPx() {
        return stage.walkSpeedPx();
      },
      play: (motion, onFinished) => this.playClip(motion, onFinished),
    });
    this.behavior.place(info.workArea.x + info.workArea.width / 2, this.arena());
    attachPointer({
      grab: (point, now) => {
        if (this.character) this.behavior.grab(point, now);
      },
      drag: (point, now) => this.behavior.drag(point, now),
      release: (now) => this.behavior.release(now, this.arena()),
      click: (point) => {
        if (this.character) this.behavior.click(point);
      },
    });

    void onCursor((event) => {
      this.cursor = event.near && !this.benchIdle ? event : null;
    });
    window.addEventListener("resize", () => this.engine.resize());
    this.startLoop();
  }

  updateInfo(info: StageInfo): void {
    this.info = info;
    this.space.stageHeight = info.height;
    this.behavior.fit(this.arena());
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
        this.behavior.feet.x,
        this.behavior.feet.y,
      );
      mesh.position.set(world.x, world.y, 0);
      mesh.rotation.set(0, this.behavior.facing, this.behavior.roll);
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
    this.playClip(this.behavior.paused ? this.motionName : "idle");
    this.wake();
    // 모델 간 자세 차이 확인용: 모션이 자리 잡은 뒤 실제 팔 각도를 남긴다.
    window.setTimeout(() => {
      if (this.character === loaded) diag(`pose ${loaded.entry.id} ${armAngles(loaded)}`);
    }, 3000);
    return loaded;
  }

  /** 미리보기(트레이·--motion): 자율 행동을 멈추고 그 모션만. "auto"면 자율 행동으로 돌아간다. */
  playMotion(name: string): void {
    if (name === "auto") {
      this.behavior.resume();
    } else {
      this.behavior.preview((motionByName(name) ?? idle).name);
    }
    this.onMotionChanged?.();
  }

  /** 행동이 고른 모션을 재생한다. 한 번짜리 모션은 끝나면 onFinished (없으면 idle). */
  private playClip(name: string, onFinished?: () => void): void {
    const motion = motionByName(name) ?? idle;
    this.motionName = motion.name;
    this.character?.motion.play(motion, {
      restart: true,
      onFinished: motion.loop ? undefined : () => (onFinished ? onFinished() : this.playClip("idle")),
    });
    this.wake();
    if (this.character) {
      const { x, y } = this.behavior.feet;
      diag(`motion ${motion.name} state=${this.behavior.state} feet=${Math.round(x)},${Math.round(y)}`);
    }
  }

  /** 발이 미끄러지지 않는 걷기 속도 (px/s, 정면 기준) */
  private walkSpeedPx(): number {
    const character = this.character;
    if (!character) return 0;
    const legScale = character.calibration.legScale > 0 ? character.calibration.legScale : 1;
    return WALK_SPEED_UNITS * legScale * (this.heightPx / character.calibration.headY);
  }

  private arena(): Arena {
    const area = this.info.workArea;
    return { ground: area.y + area.height, left: area.x, right: area.x + area.width, top: area.y };
  }

  /** 트레이 체크 표시: 미리보기 중이면 그 모션, 아니면 자동 */
  get currentMotion(): string {
    return this.behavior.paused ? this.motionName : "auto";
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
      dx: (world.x - head.x) * Math.cos(this.behavior.facing),
      dy: world.y - (head.y + character.calibration.headY),
    };
  }

  unload(): void {
    this.loadToken += 1;
    this.character?.dispose();
    this.character = null;
    this.hit.release();
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
    const { feet, facing, roll } = this.behavior;
    const world = this.space.toWorld(feet.x, feet.y);
    character.mesh.position.set(world.x, world.y, 0);
    character.mesh.rotation.set(0, facing, roll);
    let rect;
    if (this.behavior.airborne) {
      const center = rotateCss({ x: 0, y: -this.heightPx * FREE_BOX.center }, roll);
      rect = this.box.around(feet.x + center.x, feet.y + center.y, this.heightPx * FREE_BOX.size);
    } else {
      rect = this.box.update(feet.x, feet.y, this.heightPx);
    }
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
      const own = this.behavior.activity();
      const activity: Activity =
        this.hit.capturing || now < this.activeUntil || own === "interact"
          ? "interact"
          : this.cursor !== null || own === "near"
            ? "near"
            : "idle";
      // 캐릭터가 없으면 그릴 것도 없다 (vsync 간격 측정만 계속)
      if (!this.pacer.tick(now, activity) || !this.character) {
        if (!this.character) this.lastFrame = 0;
        return;
      }
      const dt = this.lastFrame > 0 ? Math.min(0.1, (now - this.lastFrame) / 1000) : 1 / 60;
      this.lastFrame = now;
      this.behavior.update(dt, this.arena());
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
            `activity=${activity} hz=${this.pacer.refreshRate} canvas=${this.canvas.width}x${this.canvas.height} motion=${this.motionName} state=${this.behavior.state}`,
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
