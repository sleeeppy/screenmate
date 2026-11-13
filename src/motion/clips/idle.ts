import { defineMotion, k } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/**
 * 서 있기. 4초 주기로 무게중심을 좌우로 옮긴다.
 * 발은 다리 IK가 바닥에 붙잡아 두므로 센터만 움직이면 무릎·골반이 따라온다.
 * 숨쉬기와 시선은 절차적 레이어가 덧붙인다.
 */
export default defineMotion({
  name: "idle",
  label: "서 있기",
  loop: true,
  length: 120,
  fadeIn: 0.35,
  bones: {
    センター: [
      k(0, { px: 0, py: 0 }),
      k(30, { px: 0.14, py: -0.04 }),
      k(60, { px: 0, py: 0 }),
      k(90, { px: -0.14, py: -0.04 }),
      k(120, { px: 0, py: 0 }),
    ],
    下半身: [k(0), k(30, { rz: 0.9 }), k(60), k(90, { rz: -0.9 }), k(120)],
    上半身: [k(0), k(30, { rz: -0.7, ry: 0.6 }), k(60), k(90, { rz: 0.7, ry: -0.6 }), k(120)],
    首: [k(0, { rx: -1.5 }), k(60, { rx: -1, rz: 0.8 }), k(120, { rx: -1.5 })],
    左腕: [
      k(0, { rz: -ARM_RELAX, rx: ARM_FORWARD }),
      k(60, { rz: -ARM_RELAX + 1.5, rx: ARM_FORWARD + 1 }),
      k(120, { rz: -ARM_RELAX, rx: ARM_FORWARD }),
    ],
    右腕: [
      k(0, { rz: ARM_RELAX, rx: ARM_FORWARD }),
      k(60, { rz: ARM_RELAX - 1.5, rx: ARM_FORWARD + 1 }),
      k(120, { rz: ARM_RELAX, rx: ARM_FORWARD }),
    ],
    左ひじ: [k(0, { ry: ELBOW_RELAX }), k(60, { ry: ELBOW_RELAX + 2 }), k(120, { ry: ELBOW_RELAX })],
    右ひじ: [k(0, { ry: -ELBOW_RELAX }), k(60, { ry: -ELBOW_RELAX - 2 }), k(120, { ry: -ELBOW_RELAX })],
  },
});
