import { defineMotion, k, type Key } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/** 서 있기 팔 자세 (idle.ts 0프레임과 같다: 끝나고 서 있기로 이어질 때 튀지 않게) */
const armsAt = (frames: number[]): Record<string, Key[]> => ({
  左腕: frames.map((frame) => k(frame, { rz: -ARM_RELAX, rx: ARM_FORWARD })),
  右腕: frames.map((frame) => k(frame, { rz: ARM_RELAX, rx: ARM_FORWARD })),
  左ひじ: frames.map((frame) => k(frame, { ry: ELBOW_RELAX })),
  右ひじ: frames.map((frame) => k(frame, { ry: -ELBOW_RELAX })),
});

/** 두리번거리기 (3.3초, 한 번). 화면 왼쪽을 봤다가 오른쪽을 보고 돌아온다. 눈이 먼저 간다. */
export const idleLook = defineMotion({
  name: "idle_look",
  label: "두리번거리기",
  loop: false,
  length: 100,
  fadeIn: 0.3,
  bones: {
    ...armsAt([0, 100]),
    上半身: [k(0), k(22, { ry: 5 }), k(48, { ry: 5 }), k(62, { ry: -5 }), k(86, { ry: -5 }), k(100)],
    // 首 Y+ = 모델의 오른쪽 = 화면 왼쪽
    首: [k(0, { rx: -1.5 }), k(20, { ry: 16, rx: 1, ease: "inOut" }), k(46, { ry: 15, rx: 2 }), k(64, { ry: -16, rx: 1, ease: "inOut" }), k(86, { ry: -15 }), k(100, { rx: -1.5 })],
    頭: [k(0), k(18, { ry: 12, rz: 2 }), k(46, { ry: 12, rz: 3 }), k(62, { ry: -12, rz: -2 }), k(86, { ry: -12, rz: -3 }), k(100)],
    両目: [k(0), k(10, { ry: 10, ease: "out" }), k(44, { ry: 8 }), k(54, { ry: -10, ease: "out" }), k(84, { ry: -8 }), k(96)],
  },
});

/**
 * 기지개 (3.5초, 한 번). 두 팔을 앞으로 들어 머리 위로 쭉 뻗고, 어깨를 으쓱 올리며 몸을 젖히고 하품, 앞으로 내린다.
 *
 * 팔은 옆으로(Z) 들면 체조처럼 보인다. 회전 순서가 Z → X라서 먼저 Z로 팔을 몸 옆에 곧게 내리고,
 * X로 앞→위로 165° 돌리면 앞으로 들어 머리 위로 간다. 손목은 뒤로 젖혀 손바닥이 위를 보게.
 * 기본 자세 팔은 수평에서 37° 아래라 곧게 내리려면 53°만 더 내린다 (더 내리면 몸 안쪽으로 넘어가
 * 머리 위에서 두 손이 엇갈린다). 위에서는 몇 도 덜 내려 살짝 V자로 벌린다.
 */
const DOWN = 90 - 37;
const UP = 165;
export const idleStretch = defineMotion({
  name: "idle_stretch",
  label: "기지개",
  loop: false,
  length: 105,
  fadeIn: 0.3,
  bones: {
    上半身: [k(0), k(30, { rx: 6, ease: "inOut" }), k(50, { rx: 10 }), k(66, { rx: 9, rz: 1.5 }), k(90, { rx: 0, ease: "inOut" }), k(105)],
    首: [k(0, { rx: -1.5 }), k(30, { rx: 10 }), k(50, { rx: 15, rz: 4 }), k(68, { rx: 13, rz: -2 }), k(90, { rx: -2 }), k(105, { rx: -1.5 })],
    // 肩 Z+ = 으쓱 (左), 右는 반대 부호
    左肩: [k(0), k(30, { rz: 10, ease: "inOut" }), k(52, { rz: 14 }), k(70, { rz: 12 }), k(90), k(105)],
    右肩: [k(0), k(30, { rz: -10, ease: "inOut" }), k(52, { rz: -14 }), k(70, { rz: -12 }), k(90), k(105)],
    左腕: [
      k(0, { rz: -ARM_RELAX, rx: ARM_FORWARD }),
      k(14, { rz: -DOWN + 6, rx: 70, ease: "in" }),
      k(30, { rz: -DOWN + 10, rx: UP, ease: "out" }),
      k(52, { rz: -DOWN + 12, rx: UP + 6 }),
      k(70, { rz: -DOWN + 10, rx: UP + 2 }),
      k(84, { rz: -DOWN + 6, rx: 60, ease: "in" }),
      k(98, { rz: -ARM_RELAX, rx: ARM_FORWARD, ease: "out" }),
      k(105, { rz: -ARM_RELAX, rx: ARM_FORWARD }),
    ],
    右腕: [
      k(0, { rz: ARM_RELAX, rx: ARM_FORWARD }),
      k(14, { rz: DOWN - 6, rx: 70, ease: "in" }),
      k(30, { rz: DOWN - 10, rx: UP, ease: "out" }),
      k(52, { rz: DOWN - 12, rx: UP + 6 }),
      k(70, { rz: DOWN - 10, rx: UP + 2 }),
      k(84, { rz: DOWN - 6, rx: 60, ease: "in" }),
      k(98, { rz: ARM_RELAX, rx: ARM_FORWARD, ease: "out" }),
      k(105, { rz: ARM_RELAX, rx: ARM_FORWARD }),
    ],
    // 올릴 때는 팔꿈치를 굽혔다가 위에서 쭉 편다
    左ひじ: [k(0, { ry: ELBOW_RELAX }), k(16, { ry: 55 }), k(32, { ry: 8 }), k(52, { ry: 2 }), k(70, { ry: 4 }), k(84, { ry: 30 }), k(98, { ry: ELBOW_RELAX }), k(105, { ry: ELBOW_RELAX })],
    右ひじ: [k(0, { ry: -ELBOW_RELAX }), k(16, { ry: -55 }), k(32, { ry: -8 }), k(52, { ry: -2 }), k(70, { ry: -4 }), k(84, { ry: -30 }), k(98, { ry: -ELBOW_RELAX }), k(105, { ry: -ELBOW_RELAX })],
    左手首: [k(0), k(30, { rx: -25 }), k(70, { rx: -30 }), k(90), k(105)],
    右手首: [k(0), k(30, { rx: -25 }), k(70, { rx: -30 }), k(90), k(105)],
  },
  morphs: {
    blink: [k(0, { w: 0 }), k(34, { w: 0.9 }), k(72, { w: 0.9 }), k(84, { w: 0 }), k(105, { w: 0 })],
    mouthA: [k(0, { w: 0 }), k(36, { w: 0.7 }), k(64, { w: 0.6 }), k(80, { w: 0 }), k(105, { w: 0 })],
  },
});
