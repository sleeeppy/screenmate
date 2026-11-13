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
/** 흔들 때 발을 드는 높이 */
const LIFT = 1.1;
/** 발목에서 발끝 볼까지 길이 (발끝으로 밀 때 발목이 올라가는 양 계산) */
const FOOT = 1.8;
/** 뒤꿈치 착지 때 발끝을 드는 각도 / 밀 때 발끝을 내리는 각도 */
const HEEL_STRIKE = 12;
const TOE_OFF = 24;
/** 밀기 시작 (디딤 끝 몇 프레임 전) */
const PUSH = 5;
/** 팔은 다리보다 2프레임 늦게 따라간다 */
const ARM_LAG = 2;
const ARM_SWING = 18;

const TAU = Math.PI * 2;
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
      const push = f > STANCE - PUSH ? TOE_OFF * smooth((f - (STANCE - PUSH)) / PUSH) : 0;
      return { pz, py: FOOT * Math.sin((push * Math.PI) / 180), rx: strike - push };
    }
    const s = (f - STANCE) / (LENGTH - STANCE);
    const pz = STRIDE - 2 * STRIDE * smooth(s);
    const pushLift = FOOT * Math.sin((TOE_OFF * Math.PI) / 180) * (1 - s);
    const py = pushLift + LIFT * Math.sin(Math.PI * s) * (1 - 0.3 * s);
    // 발끝: 밀던 각도에서 앞으로 가며 들어 올려 착지 준비
    const rx = lerp(-TOE_OFF, HEEL_STRIKE, smooth(Math.min(1, s * 1.25)));
    return { pz, py, rx };
  });
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
    // (KNEE_SOFT 0.1이 더해져 실제로는 -0.08 ~ -0.28)
    センター: sample((frame) => ({ py: -0.08 - 0.1 * bob(frame), px: 0.12 * stanceSide(frame) })),
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
