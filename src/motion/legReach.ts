import type { Quat, Vec3 } from "./math.ts";

/**
 * 두 마디 다리(허벅지·종아리)가 엉덩이에서 거리 distance인 점에 닿으려면 무릎을 얼마나 굽혀야 하는지 (라디안).
 * 순수 TS (Node 테스트).
 *
 * 다리 IK(CCD)는 매 프레임 곧게 편 다리에서 시작한다. 다리가 곧으면 무릎→발목과 무릎→목표가 한 줄이라
 * 회전축이 0이 되어 무릎을 못 굽히고, 몸이 살짝 기울어 있으면 반사(limit) 처리로 지나치게 굽혀
 * 발목이 목표 위에 뜬다. 이 각도만큼 미리 굽혀 두면 CCD는 그 근처에서 조금만 고친다.
 */
export function kneeBendForReach(thigh: number, shin: number, distance: number, minimumRad = (2 * Math.PI) / 180): number {
  if (thigh <= 0 || shin <= 0) return 0;
  const cos = (thigh * thigh + shin * shin - distance * distance) / (2 * thigh * shin);
  // 무릎 안쪽 각 (곧으면 π). 굽힘 = π - 안쪽 각
  const inner = Math.acos(Math.max(-1, Math.min(1, cos)));
  return Math.max(minimumRad, Math.PI - inner);
}


/** 쿼터니언으로 벡터 회전 (q v q⁻¹) */
export function rotateVec(q: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 (q.xyz × v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export function quatConjugate(q: Readonly<Quat>): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** from 방향을 to 방향으로 돌리는 최단 회전 */
export function quatFromTo(from: Readonly<Vec3>, to: Readonly<Vec3>): Quat {
  const fl = Math.hypot(from[0], from[1], from[2]);
  const tl = Math.hypot(to[0], to[1], to[2]);
  if (fl === 0 || tl === 0) return [0, 0, 0, 1];
  const a: Vec3 = [from[0] / fl, from[1] / fl, from[2] / fl];
  const b: Vec3 = [to[0] / tl, to[1] / tl, to[2] / tl];
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot < -0.999999) {
    // 정반대: a에 수직인 아무 축으로 180°
    const axis: Vec3 = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]];
    const l = Math.hypot(axis[0], axis[1], axis[2]);
    return [axis[0] / l, axis[1] / l, axis[2] / l, 0];
  }
  const q: Quat = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + dot];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * 두 마디 다리 IK를 해석적으로 푼다 (코사인 법칙). CCD 대신 쓴다.
 *
 * CCD는 목표가 다리 연장선 위에 있으면(서 있을 때 거의 늘 그렇다) 각 관절 방향이 이미 맞아
 * 남은 거리를 줄이지 못하고 무릎을 덜/더 굽힌 채 멈춘다 → 발목이 목표 위에 뜨거나, 무릎 각도 제한의
 * 반사 처리 때 순간 바닥 아래로 튄다 (서 있을 때 발이 내려갔다 올라오던 문제).
 *
 * @param target 엉덩이(足)에서 목표(발목 IK)까지, 足의 부모 공간 벡터
 * @param thigh 기본 자세에서 足 → ひざ 벡터, shin ひざ → 足首 벡터 (MMD 기본 자세는 회전이 없어 그대로 지역 벡터)
 * @returns 足·ひざ 지역 회전. 무릎은 X축으로만 뒤로 굽힌다 (X-).
 */
/** 무릎을 이보다 펴지 않는다 (완전히 편 무릎은 부자연스럽고 방향이 불안정) */
const MIN_BEND = (2 * Math.PI) / 180;

export function solveLeg(target: Readonly<Vec3>, thigh: Readonly<Vec3>, shin: Readonly<Vec3>): { hip: Quat; knee: Quat } {
  const d = Math.hypot(target[0], target[1], target[2]);
  // 기본 자세의 허벅지·종아리가 정확히 한 줄이 아니라서(모델마다 몇 도) 코사인 법칙 대신
  // 실제 도달 거리로 이분 탐색한다. 굽힐수록 도달 거리가 줄어든다.
  const reachFor = (bend: number, out?: Vec3): number => {
    const bentShin = rotateVec([-Math.sin(bend / 2), 0, 0, Math.cos(bend / 2)], shin);
    const reach: Vec3 = [thigh[0] + bentShin[0], thigh[1] + bentShin[1], thigh[2] + bentShin[2]];
    if (out) out.splice(0, 3, ...reach);
    return Math.hypot(reach[0], reach[1], reach[2]);
  };
  let low = MIN_BEND;
  let high = Math.PI * 0.95;
  let bend = MIN_BEND;
  if (reachFor(low) > d) {
    for (let step = 0; step < 40; step++) {
      const middle = (low + high) / 2;
      if (reachFor(middle) > d) low = middle;
      else high = middle;
    }
    bend = (low + high) / 2;
  }
  const reach: Vec3 = [0, 0, 0];
  reachFor(bend, reach);
  return { hip: quatFromTo(reach, target), knee: [-Math.sin(bend / 2), 0, 0, Math.cos(bend / 2)] };
}
