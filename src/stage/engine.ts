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
import { aimAtBox, createStageCamera } from "./camera";
import { FollowBox } from "./followBox";
import { FramePacer } from "./framePacer";
import { HitTester } from "./hitTest";
import { StageSpace } from "./space";

/** 모델을 바꾸거나 텔레포트한 뒤 물리가 가라앉을 때까지 활성 fps를 유지하는 시간 */
const SETTLE_MS = 2500;
/** 업로드할 텍스처의 최대 한 변 길이 */
const MAX_TEXTURE_SIZE = 1024;

export class Stage {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly camera;
  private readonly box: FollowBox;
  private readonly hit: HitTester;
  private readonly pacer = new FramePacer(60, 30);
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
    // babylon-mmd 권장 조명 (MMD 기본 시점 기준). 툰 텍스처가 없는 옛 PMD가 하얗게 날아가지 않는다.
    this.scene.ambientColor = new Color3(0.5, 0.5, 0.5);
    const fill = new HemisphericLight("fill", new Vector3(0, 1, 0), this.scene);
    fill.intensity = 0.3;
    fill.specular.set(0, 0, 0);
    fill.groundColor.set(1, 1, 1);
    const key = new DirectionalLight("key", new Vector3(0.5, -1, 1), this.scene);
    key.intensity = 0.7;

    this.space = new StageSpace(info.height, 1);
    this.box = new FollowBox(canvas, () => this.engine.resize());
    this.hit = new HitTester(this.engine, canvas, this.box);
    this.placeOnGround();

    void onCursor((event) => {
      this.cursor = event.near ? event : null;
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
    this.character?.mesh.computeWorldMatrix(true);
    this.character?.resetPhysics();
    this.wake();
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
    });
    if (token !== this.loadToken) {
      loaded.dispose();
      return null;
    }
    this.character?.dispose();
    this.character = loaded;
    this.hit.release();
    this.syncCharacter();
    this.wake();
    return loaded;
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
      const active = this.cursor !== null || this.hit.capturing || now < this.activeUntil;
      // 캐릭터가 없으면 그릴 것도 없다 (vsync 간격 측정만 계속)
      if (!this.pacer.tick(now, active) || !this.character) {
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
            `active=${active} hz=${this.pacer.refreshRate} canvas=${this.canvas.width}x${this.canvas.height}`,
        );
        frames = 0;
        renderMs = 0;
        stamp = now;
      }
    };
    requestAnimationFrame(loop);
  }
}
