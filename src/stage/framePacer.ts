/**
 * 화면 주사율의 정수 배수 간격으로만 그려서 프레임 간격을 고르게 유지한다.
 * 144Hz에서 활성 60fps 목표 → 2 vsync마다 (72fps), 대기 30fps 목표 → 5 vsync마다 (28.8fps).
 * 60Hz에서는 각각 60fps, 30fps.
 */
export class FramePacer {
  private vsyncMs = 1000 / 60;
  private samples: number[] = [];
  private lastTick = 0;
  private sinceRender = 0;

  constructor(
    private readonly activeFps = 60,
    private readonly idleFps = 30,
  ) {}

  /** requestAnimationFrame마다 호출. 이번 vsync에 그려야 하면 true. */
  tick(now: number, active: boolean): boolean {
    if (this.lastTick > 0) {
      this.sample(now - this.lastTick);
    }
    this.lastTick = now;
    this.sinceRender += 1;
    const hz = 1000 / this.vsyncMs;
    const divisor = Math.max(1, Math.round(hz / (active ? this.activeFps : this.idleFps)));
    if (this.sinceRender < divisor) {
      return false;
    }
    this.sinceRender = 0;
    return true;
  }

  get refreshRate(): number {
    return Math.round(1000 / this.vsyncMs);
  }

  private sample(delta: number): void {
    // 탭 숨김 등으로 생긴 긴 간격은 무시
    if (delta <= 2 || delta > 50) {
      return;
    }
    this.samples.push(delta);
    if (this.samples.length >= 60) {
      const sorted = [...this.samples].sort((a, b) => a - b);
      this.vsyncMs = sorted[Math.floor(sorted.length / 2)];
      this.samples = [];
    }
  }
}
