import "@babylonjs/core/Shaders/default.fragment";
import "@babylonjs/core/Shaders/default.vertex";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { SdefInjector } from "babylon-mmd/esm/Loader/sdefInjector";
import { diag, onCursor, onWindows, setPlatformRate, type CursorEvent, type ModelListing, type StageInfo } from "../ipc";
import { createMmdWorld, loadCharacter, type LoadedCharacter, type MmdWorld } from "../mmd/loadModel";
import { Behavior, rotateCss, type Arena } from "../behavior/behavior.ts";
import { attachPointer } from "../behavior/interaction";
import { computeLedges, type Ledge, type WindowRect } from "../behavior/platforms.ts";
import { idle, motionByName } from "../motion/clips/index.ts";
import { isPassingFrame, WALK_SPEED_UNITS } from "../motion/clips/walk.ts";
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
/** 창 발판: 머리 위 여유(키 배수)와 최소 구간 너비(키 배수) */
const LEDGE = { headroom: 1.1, minWidth: 0.45 };
/**
 * 물리(머리카락·옷)가 보는 캐릭터 이동량 비율.
 * 화면에서는 끌기·던지기로 초당 수천 px(키 16인 모델에 초당 190 단위 = 사람으로 치면 초속 18m)를 움직여
 * 치마·머리카락 강체가 뒤집히고 폭주했다. 월드 위치는 화면 위치의 이 비율만 쓰고, 카메라를 같은 만큼
 * 옮겨 화면에는 그대로 보이게 한다. 관성으로 펄럭이는 느낌은 남는다. 회전(흔들림·몸 방향)은 그대로.
 */
const PHYSICS_TRAVEL = 0.15;
/** 기준점이 가슴 ↔ 잡은 점으로 바뀔 때 물리 위치가 튀지 않게 발 기준 오프셋을 이 반감기(초)로 옮긴다 */
const PIVOT_BLEND = 0.12;
/** 걸터앉았을 때 캔버스 상자 (키 배수): 발 기준점 아래로 다리가 0.4배쯤 내려간다 */
// 일어서는 모션 끝에서 선 머리까지 들어가도록 위로도 넉넉하게 (발 위 키 1.25배)
const SEAT_EDGE_BOX = { widthRatio: 1.35, heightRatio: 1.75, footPadRatio: 0.5 };
/** 새 모델을 보여 주기 전에 물리가 자리 잡도록 숨겨 두는 시간 */
const REVEAL_DELAY_MS = 350;
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
  /** 보이는 창 (앞 → 뒤)과 거기서 계산한 발판 */
  private windows: WindowRect[] = [];
  private ledges: Ledge[] = [];
  private platformFast = false;
  /** 발 → 물리 기준점 (CSS px, 부드럽게 따라감). null이면 다음 프레임에 바로 맞춘다. */
  private pivotOffset: { x: number; y: number } | null = null;
  private activeUntil = 0;

  /** 캐릭터 키(頭 본 높이) CSS px */
  heightPx = 260;
  /** 행동: 발 위치·몸 방향·기울기를 정한다 */
  readonly behavior: Behavior;
  private motionName = "idle";
  /** 미리보기 중인 모션 (자율 행동이면 null) / 다음 재생을 섞지 않고 바로 시작할지 */
  private previewName: string | null = null;
  private snapNextClip = false;
  private lastFrame = 0;
  /** 성능 측정용: 커서를 무시하고 대기 fps로 고정 (`--bench-idle`) */
  benchIdle = false;
  /** 검증용: 발판이 잡히면 가장 넓은 창 위에서 한 번 떨어뜨린다 (`--drop-on-window`) */
  dropOnWindow = false;
  /** 검증용: 가상 커서로 목 근처를 잡고 좌우로 흔든다 (`--demo-hang`) */
  demoHang = false;
  private demoStart = 0;
  private demoGrabY = 0;

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
      canStopWalking: () => {
        const motion = this.character?.motion;
        const frame = motion?.currentFrame ?? null;
        return motion?.current?.name !== "walk" || frame === null || isPassingFrame(frame);
      },
    }, Math.random, { variety: true });
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

    void onWindows((windows) => {
      this.windows = windows;
      this.updateLedges();
    });
    void onCursor((event) => {
      this.cursor = event.near && !this.benchIdle ? event : null;
      // 커서가 다가오는 것도 입력이다 (오래 입력이 없으면 졸고, 다가오면 깬다)
      if (this.cursor) this.behavior.noteActivity();
    });
    window.addEventListener("resize", () => this.engine.resize());
    this.startLoop();
  }

  updateInfo(info: StageInfo): void {
    this.info = info;
    this.space.stageHeight = info.height;
    this.pivotOffset = null;
    this.updateLedges();
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
    this.pivotOffset = null;
    this.updateLedges();
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
      // 강체가 만들어지기 전에 최종 위치에 둔다. 위치와 물리 기준점 모두 새 모델의 배율로 계산해야 한다
      // (예전엔 기준점을 이전 모델 배율로 구해 첫 프레임에 순간이동 → 리본·넥타이가 화면을 가로질러 늘어났다).
      const space = new StageSpace(this.space.stageHeight, this.heightPx / calibration.headY);
      const { feet } = this.behavior;
      const world = space.toWorld(feet.x, feet.y);
      this.pivotOffset = null;
      const offset = this.targetPivotOffset();
      const pivot = space.toWorld(feet.x + offset.x, feet.y + offset.y);
      mesh.position.set(world.x + pivot.x * (PHYSICS_TRAVEL - 1), world.y + pivot.y * (PHYSICS_TRAVEL - 1), 0);
      mesh.rotation.set(0, this.behavior.facing, this.behavior.roll);
    }, {
      gaze: () => this.gazeTarget(),
      sway: () => (this.behavior.airborne ? this.behavior.roll : null),
    });
    if (token !== this.loadToken) {
      loaded.dispose();
      return null;
    }
    this.character?.dispose();
    this.character = loaded;
    this.hit.release();
    // 텍스처·셰이더가 준비되고 물리가 자리 잡을 때까지 숨긴다 (텍스처가 하나씩 뜨고 치마·머리카락이 쏟아지는 걸 안 보이게).
    loaded.setVisible(false);
    this.syncCharacter();
    loaded.mesh.computeWorldMatrix(true);
    loaded.resetPhysics();
    void Promise.all([loaded.ready, new Promise((resolve) => window.setTimeout(resolve, REVEAL_DELAY_MS))]).then(() => {
      if (this.character === loaded) {
        loaded.setVisible(true);
        // 미리보기 중이면 보이는 순간부터 다시 재생한다 (숨겨 둔 동안 앞부분이 지나가지 않게)
        if (this.behavior.paused && this.previewName) {
          // 미리보기 로직(앉기 → 반복 등)을 그대로 다시 타고, 섞지 않고 첫 프레임부터
          this.snapNextClip = true;
          this.behavior.preview(this.previewName);
        }
        this.wake();
      }
    });
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
      this.previewName = null;
      this.behavior.resume();
    } else {
      this.previewName = (motionByName(name) ?? idle).name;
      this.behavior.preview(this.previewName);
    }
    this.onMotionChanged?.();
  }

  /** 행동이 고른 모션을 재생한다. 한 번짜리 모션은 끝나면 onFinished (없으면 idle). */
  private playClip(name: string, onFinished?: () => void): void {
    const motion = motionByName(name) ?? idle;
    this.motionName = motion.name;
    const immediate = this.snapNextClip;
    this.snapNextClip = false;
    this.character?.motion.play(motion, {
      restart: true,
      immediate,
      onFinished: motion.loop ? undefined : () => (onFinished ? onFinished() : this.playClip("idle")),
    });
    this.wake();
    if (this.character) {
      const { x, y } = this.behavior.feet;
      diag(
        `motion ${motion.name} state=${this.behavior.state} feet=${Math.round(x)},${Math.round(y)} ` +
          `ledge=${this.behavior.onLedge} ledges=${this.ledges.length}`,
      );
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
    return { ...this.baseArena(), ledges: this.ledges };
  }

  private baseArena(): Arena {
    const area = this.info.workArea;
    return { ground: area.y + area.height, left: area.x, right: area.x + area.width, top: area.y };
  }

  /** 창 목록·화면·캐릭터 키가 바뀌면 발판을 다시 계산한다. */
  private updateLedges(): void {
    const { top, ground, left, right } = this.baseArena();
    this.ledges = computeLedges(this.windows, {
      top,
      ground,
      left,
      right,
      headroom: this.heightPx * LEDGE.headroom,
      minWidth: this.heightPx * LEDGE.minWidth,
    });
    if (this.dropOnWindow && this.character && this.ledges.length > 0) {
      this.dropOnWindow = false;
      const widest = this.ledges.reduce((best, ledge) =>
        ledge.right - ledge.left > best.right - best.left ? ledge : best,
      );
      this.behavior.dropFrom({ x: (widest.left + widest.right) / 2, y: widest.y - this.heightPx * 0.8 });
      diag(`drop-on-window window=${widest.id} y=${Math.round(widest.y)} x=${Math.round(widest.left)}..${Math.round(widest.right)}`);
    }
  }

  /**
   * 검증용 가상 드래그: 3초 주기로 좌우 크게 흔들다(1.2초 주기) 멈췄다를 반복한다.
   * 실제 마우스를 움직이지 않고 행동의 grab/drag만 부른다.
   */
  private driveDemoHang(now: number): void {
    if (!this.character) return;
    const area = this.info.workArea;
    const centerX = area.x + area.width / 2;
    const holdY = area.y + area.height - this.heightPx * 1.6;
    if (this.behavior.state !== "held") {
      const { x, y } = this.behavior.feet;
      this.demoGrabY = y - this.heightPx * 0.92;
      this.behavior.grab({ x, y: this.demoGrabY }, now);
      this.demoStart = now;
      return;
    }
    const t = (now - this.demoStart) / 1000;
    const cycle = t % 6;
    // 처음 1초는 들어 올리기, 1~4초 흔들기, 4~6초 멈춰서 흔들림이 가라앉는지
    const lift = Math.min(1, t);
    const swing = cycle >= 1 && cycle < 4 ? Math.sin(((cycle - 1) / 1.2) * Math.PI * 2) : 0;
    const y = this.demoGrabY + (holdY - this.demoGrabY) * lift;
    this.behavior.drag({ x: centerX + 220 * swing, y }, now);
  }

  /** 물리 기준점 (월드 단위). 발 + 부드럽게 따라가는 오프셋. */
  private physicsPivot(): { x: number; y: number } {
    const { feet } = this.behavior;
    const offset = this.pivotOffset ?? this.targetPivotOffset();
    return this.space.toWorld(feet.x + offset.x, feet.y + offset.y);
  }

  private targetPivotOffset(): { x: number; y: number } {
    const { pivot, feet } = this.behavior;
    return { x: pivot.x - feet.x, y: pivot.y - feet.y };
  }

  private blendPivot(dt: number): void {
    const target = this.targetPivotOffset();
    if (!this.pivotOffset) {
      this.pivotOffset = target;
      return;
    }
    const keep = Math.pow(0.5, dt / PIVOT_BLEND);
    this.pivotOffset = {
      x: target.x + (this.pivotOffset.x - target.x) * keep,
      y: target.y + (this.pivotOffset.y - target.y) * keep,
    };
  }

  /** 창 위에 있을 때만 Rust 창 폴링을 빠르게 */
  private syncPlatformRate(): void {
    const fast = this.behavior.onLedge;
    if (fast !== this.platformFast) {
      this.platformFast = fast;
      const { x, y } = this.behavior.feet;
      diag(`ledge ${fast ? "on" : "off"} state=${this.behavior.state} feet=${Math.round(x)},${Math.round(y)}`);
      void setPlatformRate(fast).catch(() => {});
    }
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
    // 메시는 물리용 위치(PHYSICS_TRAVEL)에 있으므로 화면 기준 발 위치로 계산한다.
    const head = this.space.toWorld(this.behavior.feet.x, this.behavior.feet.y);
    // 몸을 돌리고 있으면 화면 가로 거리가 모델 로컬 x로는 cos만큼 줄어든다.
    return {
      dx: (world.x - head.x) * Math.cos(this.behavior.facing),
      // 앉으면 머리가 낮다 (behavior.headHeight)
      dy: world.y - (head.y + this.behavior.headHeight / this.space.pixelsPerUnit),
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
    // 몸이 매달린 기준점(behavior.pivot)의 이동만 줄이고, 그 점을 중심으로 한 회전은 그대로 둔다.
    const pivot = this.physicsPivot();
    const offset = { x: pivot.x * (PHYSICS_TRAVEL - 1), y: pivot.y * (PHYSICS_TRAVEL - 1) };
    character.mesh.position.set(world.x + offset.x, world.y + offset.y, 0);
    character.mesh.rotation.set(0, facing, roll);
    let rect;
    if (this.behavior.airborne) {
      const center = rotateCss({ x: 0, y: -this.heightPx * FREE_BOX.center }, roll);
      rect = this.box.around(feet.x + center.x, feet.y + center.y, this.heightPx * FREE_BOX.size);
    } else if (this.behavior.seat === "edge") {
      // 걸터앉으면 다리가 테두리 아래로 내려간다. 앉는 동안(0.5초) 선 머리도 잘리지 않게 위아래 모두 넉넉히.
      rect = this.box.update(feet.x, feet.y, this.heightPx, SEAT_EDGE_BOX);
    } else {
      rect = this.box.update(feet.x, feet.y, this.heightPx);
    }
    aimAtBox(this.camera, rect, this.space, offset);
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
      if (this.demoHang) this.driveDemoHang(now);
      this.behavior.update(dt, this.arena());
      this.blendPivot(dt);
      this.syncPlatformRate();
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
