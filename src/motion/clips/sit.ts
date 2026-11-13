import { defineMotion, k, type Key, type Motion } from "../dsl.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/**
 * 앉기 (다리 IK 끔). 발 기준점(행동의 feet)은 앉은 면(창 테두리·바닥)에 있고, 센터를 엉덩이 높이만큼 내려
 * 엉덩이가 그 면에 닿게 한다. 엉덩이(足) 기본 높이는 발목 1.1 + 다리 9.3 ≈ 10.4, 엉덩이 두께 0.9를 남긴다.
 * (센터 이동은 모델 다리 길이 비율 legScale이 곱해지므로 모델마다 맞는다.)
 *
 * - edge: 창 위쪽 테두리에 걸터앉아 다리를 앞으로 내밀고 종아리를 아래로 늘어뜨린다. 다리를 번갈아 흔든다.
 * - floor: 바닥에 다리를 쭉 뻗고 앉아(장좌) 팔을 뒤로 짚는다.
 * - sleepy: 고개를 꾸벅이며 눈을 감는다 (졸기). 다리 흔들기는 멈춘다.
 */
export const SIT_DROP = 9.5;
/** 앉았을 때 머리 꼭대기 높이 / 선 키 (클릭 판정·시선용, 대략) */
export const SIT_HEAD_RATIO = 0.42;
const LENGTH = 90;

/** 반복 키: 값 두 개를 주기 안에서 오간다 (0 = a, LENGTH/2 = b, LENGTH = a) */
function swing(a: Record<string, number>, b: Record<string, number>, phase = 0): Key[] {
  const half = LENGTH / 2;
  const first = Math.round(phase * LENGTH) % LENGTH;
  if (first === 0) return [k(0, a), k(half, b), k(LENGTH, a)];
  // 위상이 있으면 b에서 시작해 a를 지나 b로 (같은 모양, 반 주기 늦게)
  return [k(0, b), k(half, a), k(LENGTH, b)];
}

function sitClip(name: string, label: string, place: "edge" | "floor", sleepy: boolean): Motion {
  const drop = { py: -SIT_DROP };
  const edge = place === "edge";
  return defineMotion({
    name,
    label,
    loop: true,
    length: LENGTH,
    fadeIn: 0.5,
    legIk: false,
    bones: {
      センター: [k(0, drop), k(LENGTH, drop)],
      // 상체: 걸터앉으면 살짝 앞으로, 바닥에서는 팔로 짚고 뒤로. 졸면 앞으로 늘어진다.
      上半身: sleepy
        ? swing({ rx: -9 }, { rx: -11 })
        : edge
          ? swing({ rx: -2, ry: 2 }, { rx: -3, ry: -2 })
          : swing({ rx: 9 }, { rx: 8 }),
      首: sleepy
        ? // 꾸벅: 천천히 숙였다가 퍼뜩 조금 든다
          [k(0, { rx: -16, rz: 5 }), k(55, { rx: -27, rz: 7, ease: "in" }), k(64, { rx: -15, rz: 4, ease: "snap" }), k(LENGTH, { rx: -16, rz: 5 })]
        : edge
          ? swing({ rx: -3, rz: 3 }, { rx: -2, rz: -3 })
          : swing({ rx: -6 }, { rx: -5, rz: 2 }),
      左腕: edge
        ? sleepy
          ? [k(0, { rz: -ARM_RELAX - 4, rx: 34 }), k(LENGTH, { rz: -ARM_RELAX - 4, rx: 34 })]
          : [k(0, { rz: -ARM_RELAX - 8, rx: ARM_FORWARD + 10 }), k(LENGTH, { rz: -ARM_RELAX - 8, rx: ARM_FORWARD + 10 })]
        : [k(0, { rz: -ARM_RELAX - 6, rx: -28 }), k(LENGTH, { rz: -ARM_RELAX - 6, rx: -28 })],
      右腕: edge
        ? sleepy
          ? [k(0, { rz: ARM_RELAX + 4, rx: 34 }), k(LENGTH, { rz: ARM_RELAX + 4, rx: 34 })]
          : [k(0, { rz: ARM_RELAX + 8, rx: ARM_FORWARD + 10 }), k(LENGTH, { rz: ARM_RELAX + 8, rx: ARM_FORWARD + 10 })]
        : [k(0, { rz: ARM_RELAX + 6, rx: -28 }), k(LENGTH, { rz: ARM_RELAX + 6, rx: -28 })],
      左ひじ: [k(0, { ry: sleepy && edge ? 38 : ELBOW_RELAX - 4 }), k(LENGTH, { ry: sleepy && edge ? 38 : ELBOW_RELAX - 4 })],
      右ひじ: [k(0, { ry: sleepy && edge ? -38 : -ELBOW_RELAX + 4 }), k(LENGTH, { ry: sleepy && edge ? -38 : -ELBOW_RELAX + 4 })],
      // 허벅지는 앞으로 수평 (足 X+ = 앞)
      左足: [k(0, { rx: 86, rz: -3 }), k(LENGTH, { rx: 86, rz: -3 })],
      右足: [k(0, { rx: 86, rz: 3 }), k(LENGTH, { rx: 86, rz: 3 })],
      // 종아리: 걸터앉으면 아래로(무릎 90° 굽힘)·번갈아 흔들기, 바닥이면 쭉 편다 (ひざ X- = 굽힘)
      左ひざ: edge ? (sleepy ? [k(0, { rx: -88 }), k(LENGTH, { rx: -88 })] : swing({ rx: -102 }, { rx: -70 })) : [k(0, { rx: -6 }), k(LENGTH, { rx: -6 })],
      右ひざ: edge ? (sleepy ? [k(0, { rx: -92 }), k(LENGTH, { rx: -92 })] : swing({ rx: -102 }, { rx: -70 }, 0.5)) : [k(0, { rx: -6 }), k(LENGTH, { rx: -6 })],
      左足首: [k(0, { rx: edge ? -14 : 12 }), k(LENGTH, { rx: edge ? -14 : 12 })],
      右足首: [k(0, { rx: edge ? -10 : 12 }), k(LENGTH, { rx: edge ? -10 : 12 })],
    },
    morphs: sleepy
      ? { blink: [k(0, { w: 1 }), k(LENGTH, { w: 1 })], sleepy: [k(0, { w: 0.5 }), k(LENGTH, { w: 0.5 })] }
      : { smile: [k(0, { w: 0.25 }), k(LENGTH, { w: 0.25 })] },
  });
}

export const sitEdge = sitClip("sit_edge", "걸터앉기", "edge", false);
export const sitFloor = sitClip("sit_floor", "바닥에 앉기", "floor", false);
export const sleepEdge = sitClip("sleep_edge", "걸터앉아 졸기", "edge", true);
export const sleepFloor = sitClip("sleep_floor", "앉아서 졸기", "floor", true);
