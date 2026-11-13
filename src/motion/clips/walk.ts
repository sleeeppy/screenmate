import { defineMotion, k } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/**
 * 걷기 한 주기 (1초, 두 걸음). 제자리에서 발만 앞뒤로 움직이고, 몸은 M4에서 실제로 이동한다.
 *
 * 모델 앞쪽 = -z. 디딤발은 0→15프레임 동안 일정한 속도로 뒤로 미끄러진다.
 * 그 속도(보폭 2·STRIDE / 0.5초)로 몸을 앞으로 옮기면 발이 바닥에 붙어 보인다.
 *   걷기 속도 = 4·STRIDE·legScale 모델 단위/초  → WALK_SPEED_UNITS 참고
 */
export const STRIDE = 1.6;
export const WALK_SPEED_UNITS = 4 * STRIDE;
const LIFT = 0.9;
const SWING = 14;

export default defineMotion({
  name: "walk",
  label: "걷기",
  loop: true,
  length: 30,
  fadeIn: 0.2,
  bones: {
    // 왼발: 0 앞 착지 → 15 뒤 → 띄워서 앞으로
    左足ＩＫ: [
      k(0, { pz: -STRIDE }),
      k(15, { pz: STRIDE, ease: "linear" }),
      k(19, { pz: STRIDE * 0.6, py: LIFT * 0.75, ease: "out" }),
      k(23, { pz: -STRIDE * 0.2, py: LIFT }),
      k(27, { pz: -STRIDE * 0.85, py: LIFT * 0.4 }),
      k(30, { pz: -STRIDE, ease: "in" }),
    ],
    // 오른발: 반 주기 늦게
    右足ＩＫ: [
      k(0, { pz: STRIDE }),
      k(4, { pz: STRIDE * 0.6, py: LIFT * 0.75, ease: "out" }),
      k(8, { pz: -STRIDE * 0.2, py: LIFT }),
      k(12, { pz: -STRIDE * 0.85, py: LIFT * 0.4 }),
      k(15, { pz: -STRIDE, ease: "in" }),
      k(30, { pz: STRIDE, ease: "linear" }),
    ],
    // 착지 때 낮고 한 발로 설 때 높다
    センター: [
      k(0, { py: -0.28 }),
      k(8, { py: 0.08 }),
      k(15, { py: -0.28 }),
      k(23, { py: 0.08 }),
      k(30, { py: -0.28 }),
    ],
    下半身: [k(0, { ry: 4 }), k(15, { ry: -4 }), k(30, { ry: 4 })],
    上半身: [k(0, { rx: -3, ry: -3 }), k(15, { rx: -3, ry: 3 }), k(30, { rx: -3, ry: -3 })],
    首: [k(0, { ry: 2 }), k(15, { ry: -2 }), k(30, { ry: 2 })],
    // 팔은 반대쪽 다리와 같이 앞으로
    左腕: [
      k(0, { rz: -ARM_RELAX + 2, rx: ARM_FORWARD - SWING }),
      k(15, { rz: -ARM_RELAX + 2, rx: ARM_FORWARD + SWING }),
      k(30, { rz: -ARM_RELAX + 2, rx: ARM_FORWARD - SWING }),
    ],
    右腕: [
      k(0, { rz: ARM_RELAX - 2, rx: ARM_FORWARD + SWING }),
      k(15, { rz: ARM_RELAX - 2, rx: ARM_FORWARD - SWING }),
      k(30, { rz: ARM_RELAX - 2, rx: ARM_FORWARD + SWING }),
    ],
    左ひじ: [k(0, { ry: ELBOW_RELAX + 6 }), k(15, { ry: ELBOW_RELAX + 14 }), k(30, { ry: ELBOW_RELAX + 6 })],
    右ひじ: [k(0, { ry: -ELBOW_RELAX - 14 }), k(15, { ry: -ELBOW_RELAX - 6 }), k(30, { ry: -ELBOW_RELAX - 14 })],
  },
});
