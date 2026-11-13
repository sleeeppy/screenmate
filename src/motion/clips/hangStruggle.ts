import { defineMotion, k } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX } from "./pose.ts";

/**
 * 들린 채 버둥거리기 (0.8초 반복, 다리 IK 끔). 오래 들고 있거나 세게 흔들면 hang 대신 재생한다.
 * 다리를 번갈아 차고(허벅지 앞뒤·무릎 굽혔다 폄), 팔을 위아래로 휘젓고, 고개를 젓는다.
 */
const L = 24;
export default defineMotion({
  name: "hang_struggle",
  label: "버둥거리기",
  loop: true,
  length: L,
  fadeIn: 0.15,
  legIk: false,
  bones: {
    下半身: [k(0, { rz: 4 }), k(12, { rz: -4 }), k(L, { rz: 4 })],
    上半身: [k(0, { rx: -4, rz: -2 }), k(12, { rx: -2, rz: 2 }), k(L, { rx: -4, rz: -2 })],
    首: [k(0, { rx: -6, rz: 8 }), k(6, { rx: -4, rz: 0 }), k(12, { rx: -6, rz: -8 }), k(18, { rx: -4, rz: 0 }), k(L, { rx: -6, rz: 8 })],
    左腕: [
      k(0, { rz: -ARM_RELAX + 30, rx: ARM_FORWARD + 10 }),
      k(12, { rz: -ARM_RELAX + 5, rx: ARM_FORWARD + 25 }),
      k(L, { rz: -ARM_RELAX + 30, rx: ARM_FORWARD + 10 }),
    ],
    右腕: [
      k(0, { rz: ARM_RELAX - 5, rx: ARM_FORWARD + 25 }),
      k(12, { rz: ARM_RELAX - 30, rx: ARM_FORWARD + 10 }),
      k(L, { rz: ARM_RELAX - 5, rx: ARM_FORWARD + 25 }),
    ],
    左ひじ: [k(0, { ry: 30 }), k(12, { ry: 55 }), k(L, { ry: 30 })],
    右ひじ: [k(0, { ry: -55 }), k(12, { ry: -30 }), k(L, { ry: -55 })],
    // 다리: 한쪽이 앞으로 차는 동안 다른 쪽은 무릎을 접는다
    左足: [k(0, { rx: 32 }), k(12, { rx: -6 }), k(L, { rx: 32 })],
    右足: [k(0, { rx: -6 }), k(12, { rx: 32 }), k(L, { rx: -6 })],
    左ひざ: [k(0, { rx: -12 }), k(6, { rx: -45 }), k(12, { rx: -70 }), k(18, { rx: -30 }), k(L, { rx: -12 })],
    右ひざ: [k(0, { rx: -70 }), k(6, { rx: -30 }), k(12, { rx: -12 }), k(18, { rx: -45 }), k(L, { rx: -70 })],
    左足首: [k(0, { rx: -25 }), k(12, { rx: -10 }), k(L, { rx: -25 })],
    右足首: [k(0, { rx: -10 }), k(12, { rx: -25 }), k(L, { rx: -10 })],
  },
  morphs: {
    trouble: [k(0, { w: 0.9 }), k(L, { w: 0.9 })],
    mouthA: [k(0, { w: 0.3 }), k(12, { w: 0.55 }), k(L, { w: 0.3 })],
  },
});
