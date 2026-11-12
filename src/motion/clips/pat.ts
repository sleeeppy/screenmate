import { defineMotion, k } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/** 머리를 쓰다듬을 때 (1.5초). 고개를 숙여 기울이고 어깨를 살짝 움츠리며 웃는다. */
export default defineMotion({
  name: "pat",
  label: "쓰다듬기 반응",
  loop: false,
  length: 45,
  fadeIn: 0.12,
  bones: {
    上半身: [k(0), k(8, { rx: -3, ease: "out" }), k(30, { rx: -2 }), k(45)],
    首: [
      k(0),
      k(8, { rx: -10, rz: 6, ease: "out" }),
      k(20, { rx: -9, rz: -3 }),
      k(32, { rx: -9, rz: 4 }),
      k(45, { rx: -1.5 }),
    ],
    頭: [k(0), k(10, { rx: -5, rz: 4, ease: "out" }), k(24, { rx: -5, rz: -3 }), k(36, { rx: -4, rz: 3 }), k(45)],
    左肩: [k(0), k(8, { rz: 5, ease: "out" }), k(36, { rz: 4 }), k(45)],
    右肩: [k(0), k(8, { rz: -5, ease: "out" }), k(36, { rz: -4 }), k(45)],
    // 두 손을 몸 앞으로 살짝 모은다
    左腕: [
      k(0, { rz: -ARM_RELAX, rx: ARM_FORWARD }),
      k(10, { rz: -ARM_RELAX + 4, rx: ARM_FORWARD + 14, ry: 8, ease: "out" }),
      k(36, { rz: -ARM_RELAX + 4, rx: ARM_FORWARD + 12, ry: 8 }),
      k(45, { rz: -ARM_RELAX, rx: ARM_FORWARD }),
    ],
    右腕: [
      k(0, { rz: ARM_RELAX, rx: ARM_FORWARD }),
      k(10, { rz: ARM_RELAX - 4, rx: ARM_FORWARD + 14, ry: -8, ease: "out" }),
      k(36, { rz: ARM_RELAX - 4, rx: ARM_FORWARD + 12, ry: -8 }),
      k(45, { rz: ARM_RELAX, rx: ARM_FORWARD }),
    ],
    左ひじ: [k(0, { ry: ELBOW_RELAX }), k(10, { ry: ELBOW_RELAX + 25 }), k(36, { ry: ELBOW_RELAX + 22 }), k(45, { ry: ELBOW_RELAX })],
    右ひじ: [k(0, { ry: -ELBOW_RELAX }), k(10, { ry: -ELBOW_RELAX - 25 }), k(36, { ry: -ELBOW_RELAX - 22 }), k(45, { ry: -ELBOW_RELAX })],
  },
  morphs: {
    smile: [k(0, { w: 0 }), k(6, { w: 1 }), k(38, { w: 1 }), k(45, { w: 0 })],
    shy: [k(0, { w: 0 }), k(10, { w: 0.6 }), k(40, { w: 0.6 }), k(45, { w: 0 })],
  },
});
