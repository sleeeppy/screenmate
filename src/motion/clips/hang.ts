import { defineMotion, k } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX } from "./pose.ts";

/**
 * 들려서 매달린 자세. 다리 IK를 끄고 허벅지·무릎·발목을 직접 굽혀 축 늘어뜨린다.
 * 좌우 다리가 살짝 엇갈려 천천히 흔들린다. 드래그 방향 흔들림은 물리와 M4 진자 레이어가 더한다.
 */
export default defineMotion({
  name: "hang",
  label: "매달리기",
  loop: true,
  length: 60,
  fadeIn: 0.2,
  legIk: false,
  bones: {
    下半身: [k(0, { rx: 2 }), k(30, { rx: -2 }), k(60, { rx: 2 })],
    上半身: [k(0, { rx: -3 }), k(30, { rx: -2 }), k(60, { rx: -3 })],
    首: [k(0, { rx: -8, rz: 3 }), k(30, { rx: -6, rz: -2 }), k(60, { rx: -8, rz: 3 })],
    左腕: [
      k(0, { rz: -ARM_RELAX - 8, rx: ARM_FORWARD + 4 }),
      k(30, { rz: -ARM_RELAX - 6, rx: ARM_FORWARD + 8 }),
      k(60, { rz: -ARM_RELAX - 8, rx: ARM_FORWARD + 4 }),
    ],
    右腕: [
      k(0, { rz: ARM_RELAX + 6, rx: ARM_FORWARD + 8 }),
      k(30, { rz: ARM_RELAX + 8, rx: ARM_FORWARD + 4 }),
      k(60, { rz: ARM_RELAX + 6, rx: ARM_FORWARD + 8 }),
    ],
    左ひじ: [k(0, { ry: 8 }), k(60, { ry: 8 })],
    右ひじ: [k(0, { ry: -8 }), k(60, { ry: -8 })],
    左足: [k(0, { rx: 10, rz: 2 }), k(30, { rx: 4, rz: 2 }), k(60, { rx: 10, rz: 2 })],
    右足: [k(0, { rx: 3, rz: -2 }), k(30, { rx: 9, rz: -2 }), k(60, { rx: 3, rz: -2 })],
    左ひざ: [k(0, { rx: -22 }), k(30, { rx: -12 }), k(60, { rx: -22 })],
    右ひざ: [k(0, { rx: -10 }), k(30, { rx: -20 }), k(60, { rx: -10 })],
    左足首: [k(0, { rx: -18 }), k(60, { rx: -18 })],
    右足首: [k(0, { rx: -15 }), k(60, { rx: -15 })],
  },
  morphs: {
    trouble: [k(0, { w: 0.55 }), k(60, { w: 0.55 })],
  },
});
