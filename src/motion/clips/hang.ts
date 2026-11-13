import { defineMotion, k } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX } from "./pose.ts";

/**
 * 들려서 매달린 자세. 다리 IK를 끄고 다리를 직접 굽혀 축 늘어뜨린다.
 *
 * 카메라가 정면 직교라 앞뒤(X축) 굽힘은 화면에서 거의 안 보인다. 그래서
 * - 무릎은 안쪽으로 모으고 종아리는 바깥으로 벌려(Z축) 힘 빠진 X자 다리로 보이게 하고,
 * - 골반·가슴을 천천히 반대로 비틀어(Y축) 굽힌 무릎이 옆에서 살짝 드러나게 한다.
 * 좌우 다리는 서로 다른 주기로 엇갈려 흔들린다. 드래그 방향 흔들림과 팔다리가 늦게 따라오는
 * 2차 움직임은 행동(진자)과 절차적 레이어(SwingLag)가 더한다.
 */
export default defineMotion({
  name: "hang",
  label: "매달리기",
  loop: true,
  length: 90,
  fadeIn: 0.2,
  legIk: false,
  bones: {
    下半身: [k(0, { rx: 3, ry: 6 }), k(45, { rx: -1, ry: -6 }), k(90, { rx: 3, ry: 6 })],
    上半身: [k(0, { rx: -4, ry: -3 }), k(45, { rx: -2, ry: 3 }), k(90, { rx: -4, ry: -3 })],
    首: [k(0, { rx: -9, rz: 4 }), k(45, { rx: -6, rz: -3 }), k(90, { rx: -9, rz: 4 })],
    // 어깨가 들린 채 팔은 힘없이 아래로
    左腕: [
      k(0, { rz: -ARM_RELAX - 6, rx: ARM_FORWARD + 4 }),
      k(45, { rz: -ARM_RELAX - 3, rx: ARM_FORWARD + 9 }),
      k(90, { rz: -ARM_RELAX - 6, rx: ARM_FORWARD + 4 }),
    ],
    右腕: [
      k(0, { rz: ARM_RELAX + 3, rx: ARM_FORWARD + 9 }),
      k(45, { rz: ARM_RELAX + 6, rx: ARM_FORWARD + 4 }),
      k(90, { rz: ARM_RELAX + 3, rx: ARM_FORWARD + 9 }),
    ],
    左ひじ: [k(0, { ry: 10 }), k(45, { ry: 16 }), k(90, { ry: 10 })],
    右ひじ: [k(0, { ry: -16 }), k(45, { ry: -10 }), k(90, { ry: -16 })],
    // 허벅지는 안쪽으로(左 Z- / 右 Z+), 종아리는 바깥으로, 발끝은 아래로
    左足: [k(0, { rx: 14, rz: -4 }), k(30, { rx: 6, rz: -2 }), k(60, { rx: 18, rz: -5 }), k(90, { rx: 14, rz: -4 })],
    右足: [k(0, { rx: 5, rz: 3 }), k(40, { rx: 16, rz: 5 }), k(70, { rx: 8, rz: 2 }), k(90, { rx: 5, rz: 3 })],
    左ひざ: [k(0, { rx: -30, rz: 9 }), k(30, { rx: -18, rz: 6 }), k(60, { rx: -36, rz: 10 }), k(90, { rx: -30, rz: 9 })],
    右ひざ: [k(0, { rx: -14, rz: -6 }), k(40, { rx: -34, rz: -10 }), k(70, { rx: -20, rz: -7 }), k(90, { rx: -14, rz: -6 })],
    左足首: [k(0, { rx: -22, ry: 8 }), k(90, { rx: -22, ry: 8 })],
    右足首: [k(0, { rx: -18, ry: -8 }), k(90, { rx: -18, ry: -8 })],
  },
  morphs: {
    trouble: [k(0, { w: 0.55 }), k(90, { w: 0.55 })],
  },
});
