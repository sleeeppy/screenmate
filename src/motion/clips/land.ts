import { defineMotion, k } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/** 착지 (0.5초, 한 번). 센터를 낮췄다 올리면 발이 IK로 고정돼 있어 무릎이 굽는다. 끝나면 idle로. */
export default defineMotion({
  name: "land",
  label: "착지",
  loop: false,
  length: 15,
  fadeIn: 0.06,
  bones: {
    センター: [k(0, { py: -0.2 }), k(3, { py: -1.8, ease: "snap" }), k(9, { py: -0.6 }), k(15, { py: 0 })],
    上半身: [k(0), k(3, { rx: -9, ease: "snap" }), k(15)],
    首: [k(0), k(4, { rx: -5 }), k(15, { rx: -1.5 })],
    左腕: [
      k(0, { rz: -ARM_RELAX + 14, rx: ARM_FORWARD + 6 }),
      k(4, { rz: -ARM_RELAX + 18, rx: ARM_FORWARD + 10, ease: "snap" }),
      k(15, { rz: -ARM_RELAX, rx: ARM_FORWARD }),
    ],
    右腕: [
      k(0, { rz: ARM_RELAX - 14, rx: ARM_FORWARD + 6 }),
      k(4, { rz: ARM_RELAX - 18, rx: ARM_FORWARD + 10, ease: "snap" }),
      k(15, { rz: ARM_RELAX, rx: ARM_FORWARD }),
    ],
    左ひじ: [k(0, { ry: 20 }), k(15, { ry: ELBOW_RELAX })],
    右ひじ: [k(0, { ry: -20 }), k(15, { ry: -ELBOW_RELAX })],
  },
  morphs: {
    surprise: [k(0, { w: 0.6 }), k(15, { w: 0 })],
  },
});
