/** 그리기 단계. 단계별 목표 fps는 FRAME_RATES */
export type Activity = "interact" | "near" | "idle";

/**
 * 단계별 목표 fps. 실제 fps는 주사율의 정수 분의 1로 맞춘다.
 *   144Hz: interact 72 · near 48 · idle 28.8,   60Hz: 60 · 60 · 30
 */
export const FRAME_RATES: Record<Activity, number> = {
  /** 캐릭터 위에 커서, 클릭·드래그, 모션 전환 직후 */
  interact: 60,
  /** 근처 커서를 눈으로만 따라갈 때 */
  near: 45,
  idle: 30,
};

/**
 * 화면 주사율의 정수 배수 간격으로만 그려서 프레임 간격을 고르게 유지한다.
 */
export class FramePacer {
  private vsyncMs = 1000 / 60;
  private samples: number[] = [];
  private lastTick = 0;
  private sinceRender = 0;

  /** requestAnimationFrame마다 호출. 이번 vsync에 그려야 하면 true. */
  tick(now: number, activity: Activity): boolean {
    if (this.lastTick > 0) {
      this.sample(now - this.lastTick);
    }
    this.lastTick = now;
    this.sinceRender += 1;
    const hz = 1000 / this.vsyncMs;
    const divisor = Math.max(1, Math.round(hz / FRAME_RATES[activity]));
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
