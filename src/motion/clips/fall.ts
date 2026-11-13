import { defineMotion, k } from "../dsl.ts";

/** 떨어지는 중. 팔을 위로 들고 허우적, 다리는 번갈아 굽힌다. */
const ARM_UP = 50;

export default defineMotion({
  name: "fall",
  label: "떨어지기",
  loop: true,
  length: 16,
  fadeIn: 0.12,
  legIk: false,
  bones: {
    上半身: [k(0, { rx: 5 }), k(8, { rx: 3 }), k(16, { rx: 5 })],
    首: [k(0, { rx: 6 }), k(16, { rx: 6 })],
    左腕: [k(0, { rz: ARM_UP + 12 }), k(8, { rz: ARM_UP - 10, rx: 10 }), k(16, { rz: ARM_UP + 12 })],
    右腕: [k(0, { rz: -ARM_UP + 10, rx: 10 }), k(8, { rz: -ARM_UP - 12 }), k(16, { rz: -ARM_UP + 10, rx: 10 })],
    左ひじ: [k(0, { ry: 20 }), k(8, { ry: 35 }), k(16, { ry: 20 })],
    右ひじ: [k(0, { ry: -35 }), k(8, { ry: -20 }), k(16, { ry: -35 })],
    左足: [k(0, { rx: 22 }), k(8, { rx: 6 }), k(16, { rx: 22 })],
    右足: [k(0, { rx: 6 }), k(8, { rx: 22 }), k(16, { rx: 6 })],
    左ひざ: [k(0, { rx: -40 }), k(8, { rx: -15 }), k(16, { rx: -40 })],
    右ひざ: [k(0, { rx: -15 }), k(8, { rx: -40 }), k(16, { rx: -15 })],
    左足首: [k(0, { rx: -10 }), k(16, { rx: -10 })],
    右足首: [k(0, { rx: -10 }), k(16, { rx: -10 })],
  },
  morphs: {
    surprise: [k(0, { w: 1 }), k(16, { w: 1 })],
    mouthA: [k(0, { w: 0.5 }), k(8, { w: 0.35 }), k(16, { w: 0.5 })],
  },
});
