/** 모션 위에 덧입히는 절차적 레이어 (순수 TS). */
import { clamp, damp, quatFromEulerDeg, type Quat } from "./math.ts";

/** 숨쉬기: 上半身을 3.6초 주기로 ±1.1° 앞뒤로. 들숨이 날숨보다 조금 짧다. */
export class Breathing {
  constructor(
    private readonly periodSeconds = 3.6,
    private readonly amplitudeDeg = 1.1,
  ) {}

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

  constructor(
    private readonly hasEyes: boolean,
    private readonly depth = 18,
    private readonly maxYaw = 35,
    private readonly maxPitch = 20,
  ) {}

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
