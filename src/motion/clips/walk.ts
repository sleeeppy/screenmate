import { defineMotion, k, type Key, type KeyValues } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/**
 * 걷기 한 주기 (1초, 두 걸음). 제자리에서 발만 앞뒤로 움직이고, 몸은 행동(behavior.ts)이 실제로 옮긴다.
 *
 * 키를 손으로 몇 개 찍는 대신 주기 함수를 매 프레임 샘플링한다 (선형 보간 → 매끄러운 곡선).
 *
 * 모델 앞쪽 = -z, 왼쪽 = +x. 한 발의 주기(30프레임) = 디딤 STANCE + 흔들기 나머지.
 * - 디딤: 발이 일정한 속도로 뒤로 미끄러진다. 그 속도로 몸을 앞으로 옮기면 발이 바닥에 붙어 보인다.
 *   → 걷기 속도 = 2·STRIDE / (STANCE/30) 모델 단위/초 (WALK_SPEED_UNITS)
 * - 디딤 시작: 뒤꿈치로 닿아 발끝이 들려 있다가 평평해진다.
 * - 디딤 끝: 뒤꿈치가 들리며 발끝으로 민다 (발목 높이가 발끝 회전만큼 올라감).
 * - 흔들기: 발을 들어 앞으로, 끝에서 발끝을 들어 다음 뒤꿈치 착지를 준비한다.
 * 다리 길이(약 9.3)에 비해 센터는 다리가 거의 펴질 만큼만 낮춘다. 더 낮추면 무릎이 내내 굽은 종종걸음이 된다.
 */
const LENGTH = 30;
/** 한 발이 바닥에 있는 프레임 (나머지는 흔들기). 0~2, 15~17이 두 발 모두 닿는 구간이다. */
const STANCE = 17;
export const STRIDE = 2.2;
export const WALK_SPEED_UNITS = (2 * STRIDE) / (STANCE / 30);
/** 흔들 때 발을 드는 높이 (흔들기 앞쪽이 가장 높다: 발을 일찍 들고 내려오며 뻗는다) */
const LIFT = 1.45;
/** 발목에서 발끝 볼까지 길이 (발끝으로 밀 때 발목이 올라가는 양 계산) */
const FOOT = 1.8;
/** 뒤꿈치 착지 때 발끝을 드는 각도 / 밀 때 발끝을 내리는 각도 */
const HEEL_STRIKE = 12;
const TOE_OFF = 24;
/** 밀기 시작 (디딤 끝 몇 프레임 전) */
const PUSH = 5;
/** 팔은 다리보다 2프레임 늦게 따라간다 */
const ARM_LAG = 2;
const ARM_SWING = 22;

const TAU = Math.PI * 2;
/** 흔들기 들어 올림 곡선 sin(πs)(1.3 - 0.6s)의 최댓값 (정규화용) */
const LIFT_PEAK = (() => {
  let peak = 0;
  for (let s = 0; s <= 1; s += 0.001) peak = Math.max(peak, Math.sin(Math.PI * s) * (1.3 - 0.6 * s));
  return peak;
})();
const smooth = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const round = (value: number) => Math.round(value * 1e5) / 1e5;

/** 매 프레임 샘플링한 키 (선형). 0과 LENGTH는 같은 값이라 반복 이음매가 없다. */
function sample(fn: (frame: number) => KeyValues): Key[] {
  const keys: Key[] = [];
  for (let frame = 0; frame <= LENGTH; frame++) {
    const values = fn(frame % LENGTH);
    const rounded: KeyValues = { ease: "linear" };
    for (const [axis, value] of Object.entries(values)) {
      if (typeof value === "number") (rounded as Record<string, number>)[axis] = round(value);
    }
    keys.push(k(frame, rounded));
  }
  return keys;
}

/** 한 발 (offset: 이 발의 디딤이 시작하는 프레임) */
function foot(offset: number) {
  return sample((frame) => {
    const f = (((frame - offset) % LENGTH) + LENGTH) % LENGTH;
    if (f <= STANCE) {
      const pz = -STRIDE + (2 * STRIDE * f) / STANCE;
      // 착지 직후 3프레임 동안 발끝이 내려와 평평해진다
      const strike = f < 3 ? HEEL_STRIKE * (1 - smooth(f / 3)) : 0;
      // 디딤 끝에서 뒤꿈치를 들어 발끝으로 민다
      const t = f > STANCE - PUSH ? (f - (STANCE - PUSH)) / PUSH : 0;
      const push = TOE_OFF * smooth(t);
      // 발목 높이는 점점 빠르게 올라가 흔들기 시작의 들어 올림 속도와 이어진다
      const pushLift = FOOT * Math.sin((TOE_OFF * Math.PI) / 180) * t * t;
      return { pz, py: pushLift, rx: strike - push };
    }
    const s = (f - STANCE) / (LENGTH - STANCE);
    // 앞뒤: 디딤 끝·착지 순간의 발 속도가 디딤 속도와 같아야 걸음마다 끊기지 않는다.
    // (예전엔 흔들기 양 끝 속도가 0이라 발을 뗄 때·디딜 때 발이 한 번씩 멈칫했다.)
    // 3차 에르미트: 시작 STRIDE → 끝 -STRIDE, 양 끝 기울기 = 디딤 속도(+z, 뒤로).
    const swingFrames = LENGTH - STANCE;
    const tangent = ((2 * STRIDE) / STANCE) * swingFrames;
    const s2 = s * s;
    const s3 = s2 * s;
    const pz =
      (2 * s3 - 3 * s2 + 1) * STRIDE + (s3 - 2 * s2 + s) * tangent + (-2 * s3 + 3 * s2) * -STRIDE + (s3 - s2) * tangent;
    // 위아래: 앞쪽(40%)이 가장 높고 끝으로 갈수록 뻗어 내린다. 양 끝 기울기가 유한해 발을 뗄 때 튀지 않는다.
    const lift = (Math.sin(Math.PI * s) * (1.3 - 0.6 * s)) / LIFT_PEAK;
    const pushLift = FOOT * Math.sin((TOE_OFF * Math.PI) / 180) * (1 - smooth(s));
    // 들어 올림은 처음 30% 동안 조금 덜 가파르게 시작해 밀기 끝의 상승 속도와 맞춘다
    const ease = 0.55 + 0.45 * smooth(Math.min(1, s / 0.3));
    const py = pushLift + LIFT * lift * ease;
    // 발끝: 밀던 각도에서 앞으로 가며 들어 올려 착지 준비
    const rx = lerp(-TOE_OFF, HEEL_STRIKE, smooth(Math.min(1, s * 1.25)));
    return { pz, py, rx };
  });
}

/**
 * 두 발이 몸 아래에서 엇갈리는 프레임 근처인지 (디딤 한가운데: 8.5, 23.5).
 * 여기서 서 있기로 바꾸면 디딤발은 이미 몸 아래에 있고 들린 발만 내려놓으면 된다.
 */
export function isPassingFrame(frame: number): boolean {
  const f = ((frame % LENGTH) + LENGTH) % LENGTH;
  return Math.min(Math.abs(f - 8.5), Math.abs(f - 23.5)) <= 1.5;
}

/** 왼발 디딤 한가운데(8프레임)에서 1, 오른발 디딤 한가운데(23)에서 -1 */
const stanceSide = (frame: number) => Math.sin((TAU * (frame - 0.5)) / LENGTH);
/** 왼발이 앞(0프레임)에서 1, 오른발이 앞(15)에서 -1 */
const leftForward = (frame: number) => Math.cos((TAU * frame) / LENGTH);
/** 두 발이 모두 닿을 때(1, 16) 가장 낮고 디딤 한가운데에서 가장 높다 */
const bob = (frame: number) => Math.cos((TAU * 2 * (frame - 1)) / LENGTH);
/** 왼팔이 앞으로 갈수록 1 (오른발이 앞일 때) */
const leftArmForward = (frame: number) => -Math.cos((TAU * (frame - ARM_LAG)) / LENGTH);

export default defineMotion({
  name: "walk",
  label: "걷기",
  loop: true,
  length: LENGTH,
  fadeIn: 0.2,
  bones: {
    左足ＩＫ: foot(0),
    右足ＩＫ: foot(15),
    // 위아래 반동 + 디딤발 쪽으로 무게 이동
    // KNEE_SOFT 0.1이 더해져 실제로는 디딤 한가운데 -0.05(디딤 다리가 거의 펴짐) ~ 두 발 디딤 -0.26.
    // 디딤 다리는 펴고 흔드는 다리만 굽혀야 걷는 것처럼 보인다. 더 낮추면 무릎을 굽힌 채 살금살금 걷는다.
    センター: sample((frame) => ({ py: -0.055 - 0.105 * bob(frame), px: 0.12 * stanceSide(frame) })),
    // 골반: 앞으로 나온 다리 쪽이 앞으로 돌고, 흔드는 다리 쪽이 살짝 처진다
    下半身: sample((frame) => ({ ry: 6 * leftForward(frame), rz: 2.5 * stanceSide(frame) })),
    // 가슴은 골반과 반대로 돌고, 살짝 앞으로 기운다
    上半身: sample((frame) => ({ rx: -4, ry: -3.5 * leftForward(frame), rz: -1.2 * stanceSide(frame) })),
    // 머리는 거의 흔들리지 않게 가슴 회전을 되돌리고 시선을 살짝 든다
    首: sample((frame) => ({ rx: 6, ry: 2.5 * leftForward(frame), rz: 0.8 * stanceSide(frame) })),
    // 팔은 반대쪽 다리와 같이 앞으로. 앞으로 갈 때 팔꿈치를 더 굽힌다.
    左腕: sample((frame) => ({ rz: -ARM_RELAX + 3, rx: ARM_FORWARD + ARM_SWING * leftArmForward(frame) })),
    右腕: sample((frame) => ({ rz: ARM_RELAX - 3, rx: ARM_FORWARD - ARM_SWING * leftArmForward(frame) })),
    左ひじ: sample((frame) => ({ ry: ELBOW_RELAX + 6 + 12 * smooth((leftArmForward(frame) + 1) / 2) })),
    右ひじ: sample((frame) => ({ ry: -ELBOW_RELAX - 6 - 12 * smooth((1 - leftArmForward(frame)) / 2) })),
  },
});
