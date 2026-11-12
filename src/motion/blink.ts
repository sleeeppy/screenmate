/** 자연스러운 눈 깜빡임: 2~6초 랜덤 간격, 가끔 두 번 연속. */
export class Blinker {
  private nextAt: number;
  private startedAt = -1;
  private doubled = false;

  constructor(
    private readonly closeMs = 60,
    private readonly holdMs = 30,
    private readonly openMs = 90,
  ) {
    this.nextAt = performance.now() + 1500;
  }

  /** 현재 시각의 깜빡임 가중치 (0 = 뜸, 1 = 감음) */
  weight(now: number): number {
    if (this.startedAt < 0) {
      if (now < this.nextAt) {
        return 0;
      }
      this.startedAt = now;
    }
    const t = now - this.startedAt;
    if (t < this.closeMs) {
      return easeIn(t / this.closeMs);
    }
    if (t < this.closeMs + this.holdMs) {
      return 1;
    }
    const opening = t - this.closeMs - this.holdMs;
    if (opening < this.openMs) {
      return 1 - easeOut(opening / this.openMs);
    }
    this.startedAt = -1;
    if (!this.doubled && Math.random() < 0.18) {
      this.doubled = true;
      this.nextAt = now + 120;
    } else {
      this.doubled = false;
      this.nextAt = now + 2000 + Math.random() * 4000;
    }
    return 0;
  }
}

const easeIn = (t: number) => t * t;
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
