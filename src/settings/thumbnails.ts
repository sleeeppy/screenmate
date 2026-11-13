/**
 * 설정 창 모델 카드 썸네일 만들기.
 *
 * 화면 위 캐릭터는 건드리지 않고, 설정 창 안의 보이지 않는 캔버스에 모델을 하나씩 불러와
 * 서 있기 자세로 살짝 돌려 세운 뒤 투명 배경으로 찍는다. 넉넉히 찍고 캐릭터 둘레(불투명 픽셀)에
 * 맞춰 자르므로 리본·머리카락 끝이 잘리지 않는다. 한 번 찍은 그림에서 세 가지를 저장한다:
 * 전신(오른쪽 미리보기), 머리~허벅지(카드), 옷 색(카드 배경).
 */
import "@babylonjs/core/Shaders/default.fragment";
import "@babylonjs/core/Shaders/default.vertex";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { SdefInjector } from "babylon-mmd/esm/Loader/sdefInjector";
import { diag, saveThumbnail, type ModelListing, type ModelLook } from "../ipc";
import { createMmdWorld, loadCharacter } from "../mmd/loadModel";
import { idle } from "../motion/clips/index.ts";

/** 찍는 캔버스 (3:4). 캐릭터 둘레를 찾아 잘라 쓰므로 넉넉하게 */
const RENDER_WIDTH = 900;
const RENDER_HEIGHT = 1200;
/** 저장 크기: 전신, 카드(머리~허벅지) 모두 3:4 */
const FULL_WIDTH = 600;
const FULL_HEIGHT = 800;
const CARD_WIDTH = 480;
const CARD_HEIGHT = 640;
/** 모션·물리(머리카락·치마)가 자리 잡을 때까지 그리는 프레임 수 */
const SETTLE_FRAMES = 50;
/** 살짝 돌려 세운다 (정면보다 입체감이 산다) */
const TURN = -0.28;
/** 이 값보다 진한 픽셀을 캐릭터로 본다 */
const ALPHA_CUTOFF = 12;

let running: Promise<void> | null = null;
/** 이 창에서 이미 찍어 본 모델. 저장이 실패하거나 목록에 안 잡혀도 계속 다시 찍지 않게 */
const attempted = new Set<string>();

/** 썸네일이 없는 모델 */
export function needsThumbnail(model: ModelListing): boolean {
  return !model.thumbnail || !model.portrait || !model.look;
}

/**
 * 썸네일이 없는 모델들을 차례로 찍는다. 하나 시작할 때마다 onProgress(끝난 수, 전체).
 * 이미 돌고 있으면 그걸 기다린다.
 */
export function makeMissingThumbnails(
  models: readonly ModelListing[],
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  if (running) return running;
  const missing = models.filter((model) => needsThumbnail(model) && !attempted.has(model.id));
  if (missing.length === 0) return Promise.resolve();
  for (const model of missing) attempted.add(model.id);
  running = run(missing, onProgress).finally(() => {
    running = null;
  });
  return running;
}

async function run(models: readonly ModelListing[], onProgress: (done: number, total: number) => void): Promise<void> {
  diag(`thumbnails start ${models.length}`);
  const canvas = document.createElement("canvas");
  canvas.width = RENDER_WIDTH;
  canvas.height = RENDER_HEIGHT;
  // preserveDrawingBuffer: 그린 직후 캔버스에서 그대로 픽셀을 읽는다 (렌더 타깃 스크린샷은 렌더 루프를 기다려 여기선 멈췄다)
  const engine = new Engine(
    canvas,
    true,
    { alpha: true, premultipliedAlpha: true, antialias: true, stencil: true, preserveDrawingBuffer: true },
    false,
  );
  SdefInjector.OverrideEngineCreateEffect(engine);
  engine.getCaps().maxTextureSize = Math.min(engine.getCaps().maxTextureSize, 1024);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 0);
  // 조명은 화면 캐릭터(stage/engine.ts)와 같게
  scene.ambientColor = new Color3(0.5, 0.5, 0.5);
  const fill = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
  fill.intensity = 0.18;
  fill.specular.set(0, 0, 0);
  fill.groundColor.set(1, 1, 1);
  const key = new DirectionalLight("key", new Vector3(0.55, -0.8, 0.75), scene);
  key.intensity = 0.78;
  const camera = new FreeCamera("thumb", new Vector3(0, 8, -200), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.1;
  camera.maxZ = 1000;

  const reader = document.createElement("canvas");
  reader.width = RENDER_WIDTH;
  reader.height = RENDER_HEIGHT;
  const readContext = reader.getContext("2d", { willReadFrequently: true })!;

  try {
    const world = await createMmdWorld(scene).catch((error) => {
      diag(`thumbnails world-failed ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
    diag("thumbnails world-ready");
    for (const [index, entry] of models.entries()) {
      onProgress(index, models.length);
      try {
        diag(`thumbnails loading ${entry.id}`);
        const loaded = await loadCharacter(
          world,
          scene,
          entry,
          (mesh) => {
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, TURN, 0);
          },
          { gaze: () => null, sway: () => null },
        );
        loaded.motion.play(idle, { restart: true, immediate: true });
        await loaded.ready;
        diag(`thumbnails ready ${entry.id}`);

        const headY = loaded.calibration.headY;
        // 처음엔 머리 위를 넉넉히 잡고, 캐릭터가 가장자리에 닿으면 넓혀 다시 찍는다
        let frame: Frame = { top: headY * 1.5, bottom: -1 };
        let box: Box | null = null;
        let pixels: ImageData | null = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          aim(camera, frame);
          loaded.setOutlineScale(outlineScale(frame, headY));
          const frames = attempt === 0 ? SETTLE_FRAMES : 4;
          for (let step = 0; step < frames; step++) {
            scene.render();
            await nextFrame();
          }
          scene.render();
          readContext.clearRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
          readContext.drawImage(canvas, 0, 0);
          pixels = readContext.getImageData(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
          box = opaqueBox(pixels);
          if (!box || !touchesEdge(box)) break;
          const span = frame.top - frame.bottom;
          frame = { top: frame.top + span * 0.25, bottom: frame.bottom - span * 0.05 };
          diag(`thumbnails reframe ${entry.id} ${attempt + 1}`);
        }
        if (!box || !pixels) throw new Error("nothing rendered");

        const toPixelY = (worldY: number) => ((frame.top - worldY) / (frame.top - frame.bottom)) * RENDER_HEIGHT;
        const look = lookOf(pixels, box, toPixelY(headY * 0.86), toPixelY(headY * 0.98));
        const full = crop(canvas, fullRegion(box), FULL_WIDTH, FULL_HEIGHT);
        const card = crop(canvas, cardRegion(pixels, box, toPixelY(headY), toPixelY(headY * 0.45)), CARD_WIDTH, CARD_HEIGHT);

        // 전신을 마지막에: Rust가 그때 목록을 다시 보낸다
        await saveThumbnail(entry.id, "card", await pngBytes(card));
        await saveThumbnail(entry.id, "look", new TextEncoder().encode(JSON.stringify(look)).buffer as ArrayBuffer);
        await saveThumbnail(entry.id, "full", await pngBytes(full));
        loaded.dispose();
        diag(`thumbnails saved ${entry.id} ${JSON.stringify(look)}`);
      } catch (error) {
        diag(`thumbnails failed ${entry.id}: ${error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error)}`);
      }
    }
    onProgress(models.length, models.length);
  } finally {
    scene.dispose();
    engine.dispose();
  }
}

// ------------------------------------------------------------------ 카메라

/** 찍을 세로 범위 (모델 단위). 가로는 3:4로 따라간다 */
interface Frame {
  top: number;
  bottom: number;
}

function aim(camera: FreeCamera, frame: Frame): void {
  const half = (frame.top - frame.bottom) / 2;
  const center = (frame.top + frame.bottom) / 2;
  camera.position.set(0, center, -200);
  camera.setTarget(new Vector3(0, center, 0));
  camera.orthoTop = half;
  camera.orthoBottom = -half;
  camera.orthoLeft = -half * (RENDER_WIDTH / RENDER_HEIGHT);
  camera.orthoRight = half * (RENDER_WIDTH / RENDER_HEIGHT);
}

/** 윤곽선은 화면 픽셀 두께라, 화면 캐릭터(키 260px 기준 0.45)와 같은 비율이 되게 줄인다 */
function outlineScale(frame: Frame, headY: number): number {
  const characterPixels = ((headY * 1.12) / (frame.top - frame.bottom)) * RENDER_HEIGHT;
  return 0.45 * (characterPixels / 260) * 0.7;
}

// ------------------------------------------------------------------ 자르기

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function opaqueBox(pixels: ImageData): Box | null {
  const { width, height, data } = pixels;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] <= ALPHA_CUTOFF) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      bottom = y;
    }
  }
  return right < 0 ? null : { left, top, right, bottom };
}

function touchesEdge(box: Box): boolean {
  return box.top <= 2 || box.left <= 2 || box.right >= RENDER_WIDTH - 3 || box.bottom >= RENDER_HEIGHT - 3;
}

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 전신: 캐릭터 둘레에 여백을 두고 3:4로. 발이 아래쪽 같은 자리에 오게 맞춘다 */
function fullRegion(box: Box): Region {
  const height = box.bottom - box.top;
  const pad = height * 0.06;
  let regionHeight = height + pad * 2;
  let regionWidth = regionHeight * (FULL_WIDTH / FULL_HEIGHT);
  const needWidth = box.right - box.left + pad * 2;
  if (needWidth > regionWidth) {
    regionWidth = needWidth;
    regionHeight = regionWidth * (FULL_HEIGHT / FULL_WIDTH);
  }
  return {
    x: (box.left + box.right) / 2 - regionWidth / 2,
    y: box.bottom + pad * 0.6 - regionHeight,
    width: regionWidth,
    height: regionHeight,
  };
}

/**
 * 카드: 머리카락 끝부터 허벅지쯤까지 3:4로. 가로 가운데는 머리(얼굴) 쪽 불투명 픽셀의 평균.
 * headPixelY: 머리 뼈 높이, bottomPixelY: 아래 끝.
 */
function cardRegion(pixels: ImageData, box: Box, headPixelY: number, bottomPixelY: number): Region {
  const { width, data } = pixels;
  let sum = 0;
  let count = 0;
  const lastRow = Math.min(Math.round(headPixelY), box.bottom);
  for (let y = box.top; y <= lastRow; y++) {
    const row = y * width * 4;
    for (let x = box.left; x <= box.right; x++) {
      if (data[row + x * 4 + 3] > ALPHA_CUTOFF) {
        sum += x;
        count++;
      }
    }
  }
  const centerX = count > 0 ? sum / count : (box.left + box.right) / 2;
  const span = Math.max(bottomPixelY - box.top, (box.bottom - box.top) * 0.4);
  const regionHeight = span * 1.05;
  const regionWidth = regionHeight * (CARD_WIDTH / CARD_HEIGHT);
  return { x: centerX - regionWidth / 2, y: box.top - regionHeight * 0.05, width: regionWidth, height: regionHeight };
}

/** region을 width×height 캔버스에 옮긴다. 원본 밖은 투명 (원본 사각형을 넘겨 자르면 Safari가 아무것도 안 그린다) */
function crop(source: HTMLCanvasElement, region: Region, width: number, height: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const context = out.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  const scale = width / region.width;
  context.drawImage(source, -region.x * scale, -region.y * scale, source.width * scale, source.height * scale);
  return out;
}

async function pngBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("toBlob failed"))), "image/png"),
  );
  return blob.arrayBuffer();
}

// ------------------------------------------------------------------ 모델 색

/**
 * 옷(목 아래)과 머리카락에서 눈에 띄는 색 두 개와 옷의 밝기를 뽑는다. 피부색은 뺀다.
 * outfitTop: 이 픽셀 행부터 아래를 옷으로, hairBottom: 이 행까지를 머리카락으로 본다.
 */
function lookOf(pixels: ImageData, box: Box, outfitTop: number, hairBottom: number): ModelLook {
  const BINS = 36;
  const outfit = new Float64Array(BINS);
  const hair = new Float64Array(BINS);
  let clothes = 0;
  let dark = 0;
  let light = 0;
  const { width, data } = pixels;
  for (let y = box.top; y <= box.bottom; y += 2) {
    const row = y * width * 4;
    for (let x = box.left; x <= box.right; x += 2) {
      const i = row + x * 4;
      const alpha = data[i + 3];
      if (alpha <= 200) continue;
      const [h, s, v] = hsv(data[i], data[i + 1], data[i + 2]);
      if (isSkin(h, s, v)) continue;
      const weight = s > 0.3 && v > 0.25 ? s * v : 0;
      if (y >= outfitTop) {
        clothes++;
        if (v < 0.32) dark++;
        else if (v > 0.8 && s < 0.2) light++;
        outfit[Math.floor(h / 10) % BINS] += weight;
      } else if (y <= hairBottom) {
        hair[Math.floor(h / 10) % BINS] += weight;
      }
    }
  }
  const smooth = (bins: Float64Array) =>
    bins.map((value, index) => value + 0.5 * (bins[(index + BINS - 1) % BINS] + bins[(index + 1) % BINS]));
  const outfitSmooth = smooth(outfit);
  const hairSmooth = smooth(hair);
  const total = (bins: Float64Array) => bins.reduce((sum, value) => sum + value, 0);
  // 옷에 색이 거의 없으면(흑백 옷) 머리카락 색을 쓴다
  const primary = total(outfitSmooth) > total(hairSmooth) * 0.15 ? outfitSmooth : hairSmooth;
  const combined = outfitSmooth.map((value, index) => value + hairSmooth[index] * 0.6);
  const peak = (bins: Float64Array, skip?: number) => {
    let best = -1;
    let bestValue = 0;
    bins.forEach((value, index) => {
      if (skip !== undefined && circularDistance(index * 10, skip) < 45) return;
      if (value > bestValue) {
        best = index;
        bestValue = value;
      }
    });
    return { hue: best < 0 ? null : best * 10 + 5, value: bestValue };
  };
  const first = peak(primary);
  const accent = first.hue ?? 215;
  const next = peak(combined, accent);
  const second = next.hue !== null && next.value > first.value * 0.08 ? next.hue : (accent + 40) % 360;
  const tone = clothes > 0 && dark / clothes > 0.42 ? "dark" : clothes > 0 && light / clothes > 0.42 ? "light" : "mid";
  return { accent, second, tone };
}

/** HSV (h 0~360, s·v 0~1). HSL은 아주 밝은 피부색의 채도가 높게 나와 피부를 못 거른다 */
function hsv(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const d = max - min;
  if (d === 0) return [0, 0, max];
  let h: number;
  if (max === red) h = ((green - blue) / d + (green < blue ? 6 : 0)) * 60;
  else if (max === green) h = ((blue - red) / d + 2) * 60;
  else h = ((red - green) / d + 4) * 60;
  return [h, d / max, max];
}

function isSkin(h: number, s: number, v: number): boolean {
  return (h <= 45 || h >= 350) && s >= 0.06 && s <= 0.42 && v > 0.35;
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** 다음 프레임까지 기다린다. requestAnimationFrame은 창이 가려지면 멈추므로 타이머로 (약 60fps) */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 16));
}
