import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";

/** 모션을 작성할 때 기준으로 삼는 팔 기본 각도(수평에서 아래로). 모델 10개 평균 근처. */
export const REFERENCE_ARM_DOWN_DEG = 37;
/** 모션 이동량 기준 다리 길이 (足 → 足首, 모델 단위) */
export const REFERENCE_LEG_LENGTH = 9.3;

export interface Calibration {
  /** 頭 본 높이 (모델 단위). 화면 표시 크기 기준 */
  headY: number;
  /** センター 본 높이 */
  centerY: number;
  /** 足 → 足首 길이 */
  legLength: number;
  /** 다리 길이 / 기준 다리 길이. 보폭·IK 이동량에 곱한다 */
  legScale: number;
  /** 모델 팔 기본각 (도) */
  armDownDeg: { left: number; right: number };
  /** 기준각 − 모델 팔 기본각. 腕 Z 회전에 더해 모델 간 팔 높이를 맞춘다 */
  armOffsetDeg: { left: number; right: number };
  /** 표준 본 중 없는 것 */
  missingBones: string[];
}

const REQUIRED_BONES = [
  "センター", "上半身", "首", "頭", "左腕", "左ひじ", "左手首", "右腕", "右ひじ", "右手首",
  "左足", "左ひざ", "左足首", "右足", "右ひざ", "右足首", "左足ＩＫ", "右足ＩＫ",
];
const SEMI_STANDARD_BONES = ["グルーブ", "腰", "上半身2", "左腕捩", "右腕捩", "左足D", "右足D", "全ての親"];

/** 기본 자세(바인드 포즈)의 본 위치로 보정값을 계산한다. */
export function calibrate(skeleton: Skeleton): Calibration {
  const names = new Set(skeleton.bones.map((bone) => bone.name));
  // 현재 포즈가 아니라 바인드 포즈 위치를 쓴다 (절대 역바인드 행렬의 역).
  // getAbsolutePosition()은 런타임이 연결한 노드 상태에 따라 0을 돌려줄 수 있다.
  const position = (name: string): Vector3 | null => {
    const bone = skeleton.bones.find((candidate) => candidate.name === name);
    return bone ? bone.getAbsoluteInverseBindMatrix().clone().invert().getTranslation() : null;
  };

  const head = position("頭");
  const center = position("センター");
  const legTop = position("左足");
  const ankle = position("左足首");
  const headY = head && head.y > 1 ? head.y : 16;
  const legLength = legTop && ankle ? legTop.subtract(ankle).length() : REFERENCE_LEG_LENGTH;

  const armDown = (side: "左" | "右"): number => {
    const shoulder = position(`${side}腕`);
    const elbow = position(`${side}ひじ`);
    if (!shoulder || !elbow) {
      return REFERENCE_ARM_DOWN_DEG;
    }
    const dx = Math.abs(elbow.x - shoulder.x);
    const dy = elbow.y - shoulder.y;
    return (Math.atan2(-dy, dx) * 180) / Math.PI;
  };
  const left = round(armDown("左"));
  const right = round(armDown("右"));

  return {
    headY: round(headY),
    centerY: round(center?.y ?? headY * 0.48),
    legLength: round(legLength),
    legScale: round(legLength / REFERENCE_LEG_LENGTH),
    armDownDeg: { left, right },
    armOffsetDeg: { left: round(REFERENCE_ARM_DOWN_DEG - left), right: round(REFERENCE_ARM_DOWN_DEG - right) },
    missingBones: [...REQUIRED_BONES, ...SEMI_STANDARD_BONES].filter((name) => !names.has(name)),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
