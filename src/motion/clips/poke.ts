import { defineMotion, k } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/** 몸을 찌를 때 (0.8초). 깜짝 놀라 몸을 뒤로 빼고 팔을 움찔한다. 센터 Z+ = 뒤 */
export default defineMotion({
  name: "poke",
  label: "찌르기 반응",
  loop: false,
  length: 24,
  fadeIn: 0.05,
  bones: {
    センター: [k(0), k(3, { pz: 0.6, py: 0.04, ease: "snap" }), k(12, { pz: 0.35 }), k(24)],
    上半身: [k(0), k(3, { rx: 9, ease: "snap" }), k(12, { rx: 5 }), k(24)],
    首: [k(0), k(3, { rx: 6, ease: "snap" }), k(24, { rx: -1.5 })],
    左腕: [
      k(0, { rz: -ARM_RELAX, rx: ARM_FORWARD }),
      k(3, { rz: -ARM_RELAX + 20, rx: ARM_FORWARD + 16, ease: "snap" }),
      k(14, { rz: -ARM_RELAX + 12, rx: ARM_FORWARD + 10 }),
      k(24, { rz: -ARM_RELAX, rx: ARM_FORWARD }),
    ],
    右腕: [
      k(0, { rz: ARM_RELAX, rx: ARM_FORWARD }),
      k(3, { rz: ARM_RELAX - 20, rx: ARM_FORWARD + 16, ease: "snap" }),
      k(14, { rz: ARM_RELAX - 12, rx: ARM_FORWARD + 10 }),
      k(24, { rz: ARM_RELAX, rx: ARM_FORWARD }),
    ],
    左ひじ: [k(0, { ry: ELBOW_RELAX }), k(3, { ry: ELBOW_RELAX + 30, ease: "snap" }), k(24, { ry: ELBOW_RELAX })],
    右ひじ: [k(0, { ry: -ELBOW_RELAX }), k(3, { ry: -ELBOW_RELAX - 30, ease: "snap" }), k(24, { ry: -ELBOW_RELAX })],
  },
  morphs: {
    surprise: [k(0, { w: 0 }), k(2, { w: 1 }), k(16, { w: 0.8 }), k(24, { w: 0 })],
    mouthA: [k(0, { w: 0 }), k(2, { w: 0.5 }), k(24, { w: 0 })],
  },
});
