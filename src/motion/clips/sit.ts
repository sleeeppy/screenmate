import { defineMotion, k, type Key, type KeyValues, type Motion } from "../dsl.ts";
import { splinePose } from "../spline.ts";
import { ARM_FORWARD, ARM_RELAX, ELBOW_RELAX } from "./pose.ts";

/**
 * 앉기와 앉고 일어서기 (다리 IK 끔).
 *
 * 발 기준점(행동의 feet)은 앉은 면(창 테두리·바닥)에 있고, 센터를 엉덩이 높이만큼 내려 엉덩이가 그 면에 닿게 한다.
 * 엉덩이(足) 기본 높이는 발목 1.1 + 다리 9.3 ≈ 10.4, 엉덩이 두께 0.9를 남긴다.
 * (센터 이동은 모델 다리 길이 비율 legScale이 곱해지므로 모델마다 맞는다.)
 *
 * - edge: 창 위쪽 테두리에 걸터앉아 다리를 앞으로 내밀고 종아리를 아래로 늘어뜨린다. 다리를 번갈아 흔든다.
 * - floor: 바닥에 다리를 쭉 뻗고 앉아(장좌) 팔을 뒤로 짚는다.
 * - sleepy: 고개를 꾸벅이며 눈을 감는다 (졸기). 다리 흔들기는 멈춘다.
 *
 * 앉는·일어서는 전환은 같은 자세 표(STAND·CROUCH·seatPose …)를 매끄러운 곡선(spline.ts)으로 잇는다.
 * 준비(무게 싣기) → 본동작 → 안착(살짝 내려앉았다 자리 잡기) 순서이고, 상체가 먼저·머리와 팔이 늦게 따라온다.
 * 전환 끝 자세 = 반복 첫 프레임이라 전환 → 반복이 이음매 없이 이어진다. 다리 IK를 끄므로 쪼그리기는 허벅지·종아리 각도로 발이 엉덩이 아래에 오게 잡았다
 * (허벅지 앞 50°, 무릎 100° → 종아리 뒤 50°: 높이 4.6cos50 + 4.7cos50 ≈ 6.0 = 다리 9.3 - 센터 3.4).
 */
export const SIT_DROP = 9.5;
/** 앉았을 때 머리 꼭대기 높이 / 선 키 (클릭 판정·시선용, 대략) */
export const SIT_HEAD_RATIO = 0.42;
const LENGTH = 90;

type Pose = Record<string, KeyValues>;
type Seat = "edge" | "floor";

/**
 * 선 자세 (idle 0프레임 + 다리 IK가 KNEE_SOFT 0.1만큼 굽힌 다리). 전환 시작·끝.
 * 허벅지 앞 8°, 무릎 17°, 발목은 발바닥이 평평하게 되돌린다.
 */
const STAND: Pose = {
  センター: { py: 0 },
  上半身: {},
  首: { rx: -1.5 },
  左腕: { rz: -ARM_RELAX, rx: ARM_FORWARD },
  右腕: { rz: ARM_RELAX, rx: ARM_FORWARD },
  左ひじ: { ry: ELBOW_RELAX },
  右ひじ: { ry: -ELBOW_RELAX },
  左足: { rx: 8 },
  右足: { rx: 8 },
  左ひざ: { rx: -17 },
  右ひざ: { rx: -17 },
  左足首: { rx: 9 },
  右足首: { rx: 9 },
};

/** 쪼그리기: 발은 그대로 엉덩이 아래, 상체를 숙이고 팔을 앞으로 내밀어 균형 */
const CROUCH: Pose = {
  センター: { py: -3.4 },
  上半身: { rx: -20 },
  首: { rx: 8 },
  左腕: { rz: -ARM_RELAX + 8, rx: 38 },
  右腕: { rz: ARM_RELAX - 8, rx: 38 },
  左ひじ: { ry: ELBOW_RELAX + 14 },
  右ひじ: { ry: -ELBOW_RELAX - 14 },
  左足: { rx: 50, rz: -3 },
  右足: { rx: 50, rz: 3 },
  左ひざ: { rx: -100 },
  右ひざ: { rx: -100 },
  左足首: { rx: 50 },
  右足首: { rx: 50 },
};

/** 앉은 자세 (반복 0프레임) */
function seatPose(place: Seat, sleepy: boolean): Pose {
  const edge = place === "edge";
  const armDown = edge ? (sleepy ? 4 : 8) : 6;
  const armForward = edge ? (sleepy ? 34 : ARM_FORWARD + 10) : -28;
  const elbow = sleepy && edge ? 38 : ELBOW_RELAX - 4;
  return {
    センター: { py: -SIT_DROP },
    上半身: sleepy ? { rx: -9 } : edge ? { rx: -2, ry: 2 } : { rx: 9 },
    首: sleepy ? { rx: -16, rz: 5 } : edge ? { rx: -3, rz: 3 } : { rx: -6 },
    左腕: { rz: -ARM_RELAX - armDown, rx: armForward },
    右腕: { rz: ARM_RELAX + armDown, rx: armForward },
    左ひじ: { ry: elbow },
    右ひじ: { ry: -elbow },
    // 허벅지는 앞으로 수평 (足 X+ = 앞)
    左足: { rx: 86, rz: -3 },
    右足: { rx: 86, rz: 3 },
    // 걸터앉으면 무릎을 굽혀 종아리를 아래로, 바닥이면 쭉 편다 (ひざ X- = 굽힘). 오른쪽은 반 주기 어긋나게 흔든다.
    左ひざ: { rx: edge ? (sleepy ? -88 : -102) : -6 },
    右ひざ: { rx: edge ? (sleepy ? -92 : -70) : -6 },
    左足首: { rx: edge ? -14 : 12 },
    右足首: { rx: edge ? -10 : 12 },
  };
}

/** 반복 반 주기(45프레임) 자세: 앉은 자세에서 흔들리는 본만 바꾼다 */
function seatSwing(place: Seat, sleepy: boolean): Pose {
  const base = seatPose(place, sleepy);
  if (sleepy) return { ...base, 上半身: { rx: -11 } };
  if (place === "edge") {
    return {
      ...base,
      上半身: { rx: -3, ry: -2 },
      首: { rx: -2, rz: -3 },
      左ひざ: { rx: -70 },
      右ひざ: { rx: -102 },
    };
  }
  return { ...base, 上半身: { rx: 8 }, 首: { rx: -5, rz: 2 } };
}

/** 자세 표들을 프레임에 맞춰 이어 붙인다. 모든 자세에 나오는 본만 트랙이 된다. */
function sequence(steps: readonly { frame: number; pose: Pose }[]): Record<string, Key[]> {
  const bones = Object.keys(steps[0].pose).filter((bone) => steps.every((step) => bone in step.pose));
  return Object.fromEntries(bones.map((bone) => [bone, steps.map((step) => k(step.frame, step.pose[bone]))]));
}

function seatLoop(name: string, label: string, place: Seat, sleepy: boolean): Motion {
  const a = seatPose(place, sleepy);
  const b = seatSwing(place, sleepy);
  const bones = sequence([
    { frame: 0, pose: a },
    { frame: LENGTH / 2, pose: b },
    { frame: LENGTH, pose: a },
  ]);
  if (sleepy) {
    // 꾸벅: 천천히 숙였다가 퍼뜩 조금 든다
    bones.首 = [k(0, { rx: -16, rz: 5 }), k(55, { rx: -27, rz: 7, ease: "in" }), k(64, { rx: -15, rz: 4, ease: "snap" }), k(LENGTH, { rx: -16, rz: 5 })];
  }
  return defineMotion({
    name,
    label,
    loop: true,
    length: LENGTH,
    fadeIn: 0.5,
    legIk: false,
    bones,
    morphs: sleepy
      ? { blink: [k(0, { w: 1 }), k(LENGTH, { w: 1 })], sleepy: [k(0, { w: 0.5 }), k(LENGTH, { w: 0.5 })] }
      : { smile: [k(0, { w: 0.25 }), k(LENGTH, { w: 0.25 })] },
  });
}

/** 움직이기 직전 준비: 살짝 내려다보며 무게를 싣는다 */
const PREPARE: Pose = {
  ...STAND,
  センター: { py: -0.5 },
  上半身: { rx: -6 },
  首: { rx: -7 },
  左腕: { rz: -ARM_RELAX + 2, rx: ARM_FORWARD + 10 },
  右腕: { rz: ARM_RELAX - 2, rx: ARM_FORWARD + 10 },
  左足: { rx: 14 },
  右足: { rx: 14 },
  左ひざ: { rx: -28 },
  右ひざ: { rx: -28 },
  左足首: { rx: 14 },
  右足首: { rx: 14 },
};

/** 걸터앉을 때 쪼그린 다음: 엉덩이를 테두리로 내리며 다리를 앞으로 내민다 */
const EDGE_LOWER: Pose = {
  ...CROUCH,
  センター: { py: -7.4 },
  上半身: { rx: -9 },
  首: { rx: 2 },
  左腕: { rz: -ARM_RELAX - 4, rx: 18 },
  右腕: { rz: ARM_RELAX + 4, rx: 18 },
  左足: { rx: 72, rz: -3 },
  右足: { rx: 72, rz: 3 },
  左ひざ: { rx: -96 },
  右ひざ: { rx: -88 },
  左足首: { rx: 8 },
  右足首: { rx: 8 },
};

/** 테두리에 엉덩이가 닿는 순간: 살짝 더 내려앉고(다시 올라와 안착) 다리가 앞으로 흔들린다 */
function edgeLand(): Pose {
  const seat = seatPose("edge", false);
  return {
    ...seat,
    センター: { py: -SIT_DROP - 0.25 },
    上半身: { rx: -5, ry: 0 },
    首: { rx: -1, rz: 1 },
    左ひざ: { rx: -92 },
    右ひざ: { rx: -82 },
  };
}

/** 바닥에 앉을 때 쪼그린 다음: 손을 뒤로 짚고 엉덩이를 내린다 (무릎은 아직 굽힌 채) */
const FLOOR_LOWER: Pose = {
  ...CROUCH,
  センター: { py: -8.4 },
  上半身: { rx: 0 },
  首: { rx: -2 },
  左腕: { rz: -ARM_RELAX - 6, rx: -22 },
  右腕: { rz: ARM_RELAX + 6, rx: -22 },
  左足: { rx: 78, rz: -3 },
  右足: { rx: 78, rz: 3 },
  左ひざ: { rx: -92 },
  右ひざ: { rx: -92 },
  左足首: { rx: 30 },
  右足首: { rx: 30 },
};

/** 엉덩이가 바닥에 닿은 뒤: 무릎을 세운 채 살짝 내려앉았다가 다리를 뻗는다 */
function floorLand(): Pose {
  const seat = seatPose("floor", false);
  return {
    ...seat,
    センター: { py: -SIT_DROP - 0.2 },
    上半身: { rx: 6 },
    左ひざ: { rx: -58 },
    右ひざ: { rx: -58 },
    左足首: { rx: 24 },
    右足首: { rx: 24 },
  };
}

/** 일어설 때 걸터앉은 자리에서: 손으로 테두리를 짚어 누른다 */
const EDGE_PUSH: Pose = {
  ...seatPose("edge", false),
  センター: { py: -SIT_DROP + 0.1 },
  上半身: { rx: -14 },
  首: { rx: 2 },
  左腕: { rz: -ARM_RELAX - 12, rx: 24 },
  右腕: { rz: ARM_RELAX + 12, rx: 24 },
  左ひざ: { rx: -108 },
  右ひざ: { rx: -108 },
};

/** 일어설 때: 앉은 자리에서 상체를 숙이고 다리를 몸 쪽으로 당긴다 */
function riseGather(place: Seat): Pose {
  return {
    ...CROUCH,
    センター: { py: -8.2 },
    上半身: { rx: -26 },
    首: { rx: 8 },
    左腕: place === "edge" ? { rz: -ARM_RELAX - 8, rx: 26 } : { rz: -ARM_RELAX + 4, rx: 30 },
    右腕: place === "edge" ? { rz: ARM_RELAX + 8, rx: 26 } : { rz: ARM_RELAX - 4, rx: 30 },
    左足: { rx: 80, rz: -3 },
    右足: { rx: 80, rz: 3 },
    左ひざ: { rx: -118 },
    右ひざ: { rx: -118 },
    左足首: { rx: 40 },
    右足首: { rx: 40 },
  };
}

/** 바닥에서 일어설 때 먼저: 뻗은 다리를 무릎을 세워 당기고 손은 뒤를 짚는다 */
const FLOOR_KNEES_IN: Pose = {
  ...seatPose("floor", false),
  上半身: { rx: 2 },
  左腕: { rz: -ARM_RELAX - 6, rx: -24 },
  右腕: { rz: ARM_RELAX + 6, rx: -24 },
  左足: { rx: 84, rz: -3 },
  右足: { rx: 84, rz: 3 },
  左ひざ: { rx: -112 },
  右ひざ: { rx: -112 },
  左足首: { rx: 34 },
  右足首: { rx: 34 },
};

/** 다 일어서기 직전: 상체가 살짝 뒤로 젖혀졌다가 바로 선다 (일어나는 힘이 남은 느낌) */
const STAND_SETTLE: Pose = {
  ...STAND,
  センター: { py: -0.25 },
  上半身: { rx: 3 },
  首: { rx: -3 },
  左足: { rx: 10 },
  右足: { rx: 10 },
  左ひざ: { rx: -21 },
  右ひざ: { rx: -21 },
  左足首: { rx: 11 },
  右足首: { rx: 11 },
};

/**
 * 몸 부위별 시간 차 (프레임, splinePose): 상체가 먼저 움직이고, 머리·팔·팔꿈치가 차례로 늦게 따라온다.
 * 모든 부위가 한꺼번에 움직이면 로봇처럼 보인다.
 */
const OVERLAP: Record<string, number> = {
  上半身: -2,
  首: 2,
  左腕: 3,
  右腕: 3,
  左ひじ: 4,
  右ひじ: 4,
};

function sitDown(place: Seat): Motion {
  const edge = place === "edge";
  const length = edge ? 40 : 46;
  const steps = edge
    ? [
        { frame: 0, pose: STAND },
        { frame: 6, pose: PREPARE },
        { frame: 16, pose: CROUCH },
        { frame: 26, pose: EDGE_LOWER },
        { frame: 33, pose: edgeLand() },
        { frame: length, pose: seatPose(place, false) },
      ]
    : [
        { frame: 0, pose: STAND },
        { frame: 6, pose: PREPARE },
        { frame: 17, pose: CROUCH },
        { frame: 28, pose: FLOOR_LOWER },
        { frame: 35, pose: floorLand() },
        { frame: length, pose: seatPose(place, false) },
      ];
  return defineMotion({
    name: `sit_down_${place}`,
    label: edge ? "걸터앉는 중" : "바닥에 앉는 중",
    loop: false,
    length,
    fadeIn: 0.12,
    legIk: false,
    bones: splinePose(steps, length, OVERLAP),
  });
}

function standUp(place: Seat): Motion {
  const edge = place === "edge";
  const length = edge ? 40 : 46;
  const steps = edge
    ? [
        { frame: 0, pose: seatPose(place, false) },
        { frame: 8, pose: EDGE_PUSH },
        { frame: 17, pose: riseGather(place) },
        { frame: 26, pose: CROUCH },
        { frame: 34, pose: STAND_SETTLE },
        { frame: length, pose: STAND },
      ]
    : [
        { frame: 0, pose: seatPose(place, false) },
        { frame: 10, pose: FLOOR_KNEES_IN },
        { frame: 21, pose: riseGather(place) },
        { frame: 30, pose: CROUCH },
        { frame: 39, pose: STAND_SETTLE },
        { frame: length, pose: STAND },
      ];
  return defineMotion({
    name: `stand_up_${place}`,
    label: edge ? "걸터앉았다 일어서기" : "바닥에서 일어서기",
    loop: false,
    length,
    fadeIn: 0.3,
    legIk: false,
    bones: splinePose(steps, length, OVERLAP),
  });
}

export const sitEdge = seatLoop("sit_edge", "걸터앉기", "edge", false);
export const sitFloor = seatLoop("sit_floor", "바닥에 앉기", "floor", false);
export const sleepEdge = seatLoop("sleep_edge", "걸터앉아 졸기", "edge", true);
export const sleepFloor = seatLoop("sleep_floor", "앉아서 졸기", "floor", true);
export const sitDownEdge = sitDown("edge");
export const sitDownFloor = sitDown("floor");
export const standUpEdge = standUp("edge");
export const standUpFloor = standUp("floor");
