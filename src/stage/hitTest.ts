import type { Engine } from "@babylonjs/core/Engines/engine";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { FollowBox } from "./followBox";

const HIT_ALPHA = 16;
const MISS_FRAMES = 2;

/**
 * 커서 아래 픽셀의 알파값으로 캐릭터 위인지 판정하고 클릭 통과를 켜고 끈다.
 * 기본은 통과(아래 창이 클릭을 받음). 캐릭터 픽셀 위에서만 입력을 받는다.
 */
export class HitTester {
  private readonly appWindow = getCurrentWindow();
  private ignoring = true;
  private pressed = false;
  private misses = 0;
  private pending = false;

  constructor(
    private readonly engine: Engine,
    private readonly canvas: HTMLCanvasElement,
    private readonly box: FollowBox,
  ) {
    window.addEventListener("pointerdown", () => {
      this.pressed = true;
    });
    const release = () => {
      this.pressed = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }

  get capturing(): boolean {
    return !this.ignoring;
  }

  /** scene.render() 직후에 호출한다 (같은 프레임 버퍼를 읽어야 함). */
  sample(cursor: { x: number; y: number } | null): void {
    if (this.pressed || this.pending) {
      return;
    }
    if (!cursor || !this.box.contains(cursor.x, cursor.y)) {
      this.noteMiss();
      return;
    }
    const { rect } = this.box;
    const ratioX = this.canvas.width / Math.max(1, rect.width);
    const ratioY = this.canvas.height / Math.max(1, rect.height);
    const x = clamp(Math.floor((cursor.x - rect.x) * ratioX), 0, this.canvas.width - 1);
    const yFromTop = Math.floor((cursor.y - rect.y) * ratioY);
    const y = clamp(this.canvas.height - 1 - yFromTop, 0, this.canvas.height - 1);

    this.pending = true;
    void this.engine
      .readPixels(x, y, 1, 1, true, true)
      .then((buffer) => {
        this.pending = false;
        if (alphaOf(buffer) > HIT_ALPHA) {
          this.misses = 0;
          this.setIgnoring(false);
        } else {
          this.noteMiss();
        }
      })
      .catch(() => {
        this.pending = false;
      });
  }

  /** 모델 교체 등으로 캐릭터가 사라졌을 때 */
  release(): void {
    this.misses = MISS_FRAMES;
    this.setIgnoring(true);
  }

  private noteMiss(): void {
    if (this.pressed) {
      return;
    }
    this.misses += 1;
    if (this.misses >= MISS_FRAMES) {
      this.setIgnoring(true);
    }
  }

  private setIgnoring(next: boolean): void {
    if (next === this.ignoring) {
      return;
    }
    this.ignoring = next;
    void this.appWindow.setIgnoreCursorEvents(next);
  }
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(max, Math.max(min, value));
}

function alphaOf(buffer: ArrayBufferView): number {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return bytes[3] ?? 0;
}
