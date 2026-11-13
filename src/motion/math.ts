/**
 * 모션용 순수 수학 (Babylon 의존 없음 → Node에서 테스트·VMD 내보내기 가능).
 *
 * 좌표계는 MMD/Babylon과 같은 왼손 좌표계. 모델은 -z를 바라본다.
 * 오일러각은 MMD 표시 방식과 같은 Yaw(Y)·Pitch(X)·Roll(Z), Babylon RotationYawPitchRoll과 동일.
 *   q = qY · qX · qZ  → 회전은 Z, X, Y 순서로 (부모 공간 기준) 적용된다.
 *
 * 부호 (행렬로 유도, 화면에서 확인):
 *   左腕 Z+ = 팔을 올림,  右腕 Z+ = 팔을 내림
 *   腕 X+  = 내린 팔을 앞으로 흔듦,  上半身 X+ = 뒤로 젖힘
 *   足(허벅지) X+ = 다리를 앞으로,  ひざ X- = 무릎 굽힘,  足首 X- = 발끝 내림
 *   首·頭 Y+ = 모델의 오른쪽(화면 왼쪽)으로 고개 돌림, X+ = 위를 봄
 */

export type Quat = [x: number, y: number, z: number, w: number];
export type Vec3 = [x: number, y: number, z: number];

export const IDENTITY: Readonly<Quat> = [0, 0, 0, 1];
const DEG = Math.PI / 180;

/** Babylon Quaternion.RotationYawPitchRollToRef와 같은 식 */
export function quatFromEulerDeg(xDeg: number, yDeg: number, zDeg: number, out: Quat = [0, 0, 0, 1]): Quat {
  const halfRoll = zDeg * DEG * 0.5;
  const halfPitch = xDeg * DEG * 0.5;
  const halfYaw = yDeg * DEG * 0.5;
  const sinRoll = Math.sin(halfRoll);
  const cosRoll = Math.cos(halfRoll);
  const sinPitch = Math.sin(halfPitch);
  const cosPitch = Math.cos(halfPitch);
  const sinYaw = Math.sin(halfYaw);
  const cosYaw = Math.cos(halfYaw);
  out[0] = cosYaw * sinPitch * cosRoll + sinYaw * cosPitch * sinRoll;
  out[1] = sinYaw * cosPitch * cosRoll - cosYaw * sinPitch * sinRoll;
  out[2] = cosYaw * cosPitch * sinRoll - sinYaw * sinPitch * cosRoll;
  out[3] = cosYaw * cosPitch * cosRoll + sinYaw * sinPitch * sinRoll;
  return out;
}

/** 해밀턴 곱 a·b (b를 먼저 적용한 뒤 a). Babylon Quaternion.multiply와 같다. */
export function quatMul(a: Readonly<Quat>, b: Readonly<Quat>, out: Quat = [0, 0, 0, 1]): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  out[0] = ax * bw + ay * bz - az * by + aw * bx;
  out[1] = -ax * bz + ay * bw + az * bx + aw * by;
  out[2] = ax * by - ay * bx + az * bw + aw * bz;
  out[3] = -ax * bx - ay * by - az * bz + aw * bw;
  return out;
}

export function quatSlerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number, out: Quat = [0, 0, 0, 1]): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa: number;
  let wb: number;
  if (cos > 0.9995) {
    wa = 1 - t;
    wb = t;
  } else {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    wa = Math.sin((1 - t) * angle) / sin;
    wb = Math.sin(t * angle) / sin;
  }
  out[0] = wa * a[0] + wb * bx;
  out[1] = wa * a[1] + wb * by;
  out[2] = wa * a[2] + wb * bz;
  out[3] = wa * a[3] + wb * bw;
  const length = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  out[0] /= length;
  out[1] /= length;
  out[2] /= length;
  out[3] /= length;
  return out;
}

export function quatCopy(from: Readonly<Quat>, out: Quat): Quat {
  out[0] = from[0];
  out[1] = from[1];
  out[2] = from[2];
  out[3] = from[3];
  return out;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 3차 베지어 이징 (CSS cubic-bezier, VMD 보간 곡선과 같은 정의).
 * 제어점 (0,0) (x1,y1) (x2,y2) (1,1), 입력 x → 출력 y.
 */
export function bezierEase(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === y1 && x2 === y2) return x; // 직선
  // x(t) = x 를 이분법으로 푼다 (단조 증가)
  let low = 0;
  let high = 1;
  let t = x;
  for (let i = 0; i < 24; i++) {
    const value = cubic(x1, x2, t);
    if (Math.abs(value - x) < 1e-5) break;
    if (value < x) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return cubic(y1, y2, t);
}

function cubic(p1: number, p2: number, t: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 프레임 독립 지수 감쇠: 매 프레임 current를 target 쪽으로 halfLife마다 절반씩 다가가게 한다. */
export function damp(current: number, target: number, halfLifeSeconds: number, dtSeconds: number): number {
  if (halfLifeSeconds <= 0) return target;
  return target + (current - target) * Math.pow(0.5, dtSeconds / halfLifeSeconds);
}
