/** 모션 위에 덧입히는 절차적 레이어 (순수 TS). */
import { clamp, damp, quatFromEulerDeg, type Quat } from "./math.ts";

/** 숨쉬기: 上半身을 3.6초 주기로 ±1.1° 앞뒤로. 들숨이 날숨보다 조금 짧다. */
// Node 타입 제거 모드(테스트)는 생성자 매개변수 속성을 지원하지 않아 필드를 따로 둔다.
export class Breathing {
  private readonly periodSeconds: number;
  private readonly amplitudeDeg: number;

  constructor(periodSeconds = 3.6, amplitudeDeg = 1.1) {
    this.periodSeconds = periodSeconds;
    this.amplitudeDeg = amplitudeDeg;
  }

  chest(nowSeconds: number, out: Quat): Quat {
    const phase = (nowSeconds / this.periodSeconds) % 1;
    // 0~0.42 들숨(뒤로 살짝 젖힘), 나머지 날숨
    const wave = phase < 0.42 ? Math.sin((phase / 0.42) * Math.PI * 0.5) : Math.cos(((phase - 0.42) / 0.58) * Math.PI * 0.5);
    // 上半身 X+ = 뒤로 젖힘
    return quatFromEulerDeg(this.amplitudeDeg * wave, 0, 0, out);
  }
}

/**
 * 시선 목표: 머리 기준 커서 위치 (모델 로컬 단위). x+ = 모델의 왼쪽(화면 오른쪽), y+ = 위.
 * 커서는 화면 평면에 있으므로 얼굴 앞 depth만큼 떨어져 있다고 보고 각도를 낸다.
 */
export interface GazeTarget {
  dx: number;
  dy: number;
}

export interface GazeAngles {
  /** 도. Y+ = 모델의 오른쪽(화면 왼쪽) */
  yaw: number;
  /** 도. X+ = 위 */
  pitch: number;
  eyes: { yaw: number; pitch: number } | null;
}

export class LookAt {
  private yaw = 0;
  private pitch = 0;
  private eyeYaw = 0;
  private eyePitch = 0;

  private readonly hasEyes: boolean;
  private readonly depth: number;
  private readonly maxYaw: number;
  private readonly maxPitch: number;

  constructor(hasEyes: boolean, depth = 18, maxYaw = 35, maxPitch = 20) {
    this.hasEyes = hasEyes;
    this.depth = depth;
    this.maxYaw = maxYaw;
    this.maxPitch = maxPitch;
  }

  update(target: GazeTarget | null, dtSeconds: number): GazeAngles {
    let yawTarget = 0;
    let pitchTarget = 0;
    let eyeYawTarget = 0;
    let eyePitchTarget = 0;
    if (target) {
      const rawYaw = (-Math.atan2(target.dx, this.depth) * 180) / Math.PI;
      const rawPitch = (Math.atan2(target.dy, Math.hypot(target.dx, this.depth)) * 180) / Math.PI;
      yawTarget = clamp(rawYaw, -this.maxYaw, this.maxYaw);
      pitchTarget = clamp(rawPitch, -this.maxPitch * 0.7, this.maxPitch);
      // 고개로 못 따라가는 나머지를 눈이 조금 더 따라간다.
      eyeYawTarget = clamp((rawYaw - yawTarget) * 0.5 + yawTarget * 0.25, -12, 12);
      eyePitchTarget = clamp((rawPitch - pitchTarget) * 0.5 + pitchTarget * 0.2, -8, 8);
    }
    // 따라갈 때는 빠르게, 놓으면 천천히 정면으로
    const halfLife = target ? 0.12 : 0.4;
    this.yaw = damp(this.yaw, yawTarget, halfLife, dtSeconds);
    this.pitch = damp(this.pitch, pitchTarget, halfLife, dtSeconds);
    this.eyeYaw = damp(this.eyeYaw, eyeYawTarget, halfLife * 0.5, dtSeconds);
    this.eyePitch = damp(this.eyePitch, eyePitchTarget, halfLife * 0.5, dtSeconds);
    return {
      yaw: this.yaw,
      pitch: this.pitch,
      eyes: this.hasEyes ? { yaw: this.eyeYaw, pitch: this.eyePitch } : null,
    };
  }
}

/**
 * 매달려 흔들릴 때 팔·다리·머리가 몸보다 늦게 따라가는 2차 움직임.
 *
 * 몸(진자)의 각속도가 바뀌면 관성 때문에 팔다리는 잠깐 제자리에 남는다 → 몸 기준으로 반대쪽으로 꺾인다.
 * 이 상대 각도를 감쇠 스프링으로 풀어 제자리로 돌아오게 한다. 결과는 도, 화면 반시계 +.
 */
export class SwingLag {
  private angle = 0;
  private velocity = 0;
  private lastRoll: number | null = null;
  private lastRate = 0;

  private readonly hz: number;
  private readonly damping: number;
  private readonly maxDeg: number;

  constructor(hz = 1.2, damping = 0.28, maxDeg = 20) {
    this.hz = hz;
    this.damping = damping;
    this.maxDeg = maxDeg;
  }

  /** roll: 몸 기울기(라디안, 화면 반시계 +). null이면 흔들림이 없다 (스프링만 가라앉음). */
  update(roll: number | null, dtSeconds: number): number {
    if (dtSeconds <= 0) return this.angle;
    if (roll !== null && this.lastRoll !== null) {
      const rate = ((roll - this.lastRoll) / dtSeconds) * (180 / Math.PI);
      // 몸 각속도가 바뀐 만큼 팔다리는 반대로 (관성)
      this.velocity -= rate - this.lastRate;
      this.lastRate = rate;
    } else {
      this.lastRate = 0;
    }
    this.lastRoll = roll;

    const omega = 2 * Math.PI * this.hz;
    const steps = Math.max(1, Math.ceil(dtSeconds * 240));
    const h = dtSeconds / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity += (-omega * omega * this.angle - 2 * this.damping * omega * this.velocity) * h;
      this.angle += this.velocity * h;
    }
    if (Math.abs(this.angle) > this.maxDeg) {
      this.angle = clamp(this.angle, -this.maxDeg, this.maxDeg);
      this.velocity *= -0.3;
    }
    return this.angle;
  }
}
