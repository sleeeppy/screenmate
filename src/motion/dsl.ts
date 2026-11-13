/**
 * 모션 작성 DSL (순수 TS).
 *
 * 프레임 단위는 MMD와 같은 30fps. 회전은 오일러각(도), 이동은 기본 위치 기준 오프셋(모델 단위).
 *
 *   export default defineMotion({
 *     name: "idle", label: "서 있기", loop: true, length: 120,
 *     bones: {
 *       "上半身": [k(0, { rx: 0 }), k(60, { rx: -2, ease: "inOut" }), k(120, { rx: 0 })],
 *       "センター": [k(0, { py: 0 }), k(60, { py: -0.1 }), k(120, { py: 0 })],
 *     },
 *     morphs: { smile: [k(0, { w: 0 }), k(30, { w: 1 })] },
 *   });
 *
 * - 키에 적지 않은 축은 0이다 (이전 키 값을 이어받지 않음). 키마다 자세 전체를 적는 MMD 방식.
 * - 이동(센터·足ＩＫ)은 모델의 다리 길이 비율(legScale)이 곱해진다.
 * - 腕 회전에는 모델별 팔 기본각 보정이 자동으로 더해진다 (calibration.ts 참고).
 * - 모프 키 이름은 감정 이름(blink, smile, surprise …, morphMap.ts) 또는 실제 모프 이름.
 * - ease는 이 키로 들어오는 구간의 곡선이다 (VMD 보간과 같은 의미).
 */
import { bezierEase, quatFromEulerDeg, type Quat, type Vec3 } from "./math.ts";

export type Ease = "linear" | "in" | "out" | "inOut" | "snap" | readonly [x1: number, y1: number, x2: number, y2: number];

export const EASE_CURVES: Record<Exclude<Ease, readonly number[]>, readonly [number, number, number, number]> = {
  linear: [0.25, 0.25, 0.75, 0.75],
  in: [0.5, 0, 0.85, 0.6],
  out: [0.15, 0.4, 0.5, 1],
  inOut: [0.45, 0, 0.55, 1],
  /** 빠르게 도달 후 정착 (착지·반응용) */
  snap: [0.1, 0.7, 0.3, 1],
};

export interface KeyValues {
  rx?: number;
  ry?: number;
  rz?: number;
  px?: number;
  py?: number;
  pz?: number;
  /** 모프 가중치 0~1 */
  w?: number;
  ease?: Ease;
}

export interface Key extends KeyValues {
  frame: number;
}

export interface MotionDef {
  name: string;
  /** 트레이 미리보기 메뉴에 보일 이름 */
  label: string;
  loop: boolean;
  /** 30fps 기준 길이 (프레임) */
  length: number;
  /** 다른 모션에서 넘어올 때 섞는 시간 (초) */
  fadeIn?: number;
  bones: Record<string, readonly Key[]>;
  morphs?: Record<string, readonly Key[]>;
  /** 이 모션 동안 다리 IK를 켤지 (기본 true) */
  legIk?: boolean;
}

export function k(frame: number, values: KeyValues = {}): Key {
  return { frame, ...values };
}

/** 컴파일된 키: 회전은 쿼터니언으로 미리 계산 */
export interface CompiledKey {
  frame: number;
  rotation: Quat;
  position: Vec3;
  weight: number;
  curve: readonly [number, number, number, number];
}

export interface CompiledTrack {
  name: string;
  keys: CompiledKey[];
  hasRotation: boolean;
  hasPosition: boolean;
}

export interface Motion {
  name: string;
  label: string;
  loop: boolean;
  length: number;
  fadeIn: number;
  legIk: boolean;
  bones: CompiledTrack[];
  morphs: CompiledTrack[];
}

export function defineMotion(def: MotionDef): Motion {
  return {
    name: def.name,
    label: def.label,
    loop: def.loop,
    length: def.length,
    fadeIn: def.fadeIn ?? 0.25,
    legIk: def.legIk ?? true,
    bones: Object.entries(def.bones).map(([name, keys]) => compileTrack(def.name, name, keys)),
    morphs: Object.entries(def.morphs ?? {}).map(([name, keys]) => compileTrack(def.name, name, keys)),
  };
}

function compileTrack(motion: string, name: string, keys: readonly Key[]): CompiledTrack {
  if (keys.length === 0) {
    throw new Error(`${motion}/${name}: 키가 없습니다`);
  }
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  return {
    name,
    hasRotation: sorted.some((key) => key.rx !== undefined || key.ry !== undefined || key.rz !== undefined),
    hasPosition: sorted.some((key) => key.px !== undefined || key.py !== undefined || key.pz !== undefined),
    keys: sorted.map((key) => ({
      frame: key.frame,
      rotation: quatFromEulerDeg(key.rx ?? 0, key.ry ?? 0, key.rz ?? 0),
      position: [key.px ?? 0, key.py ?? 0, key.pz ?? 0],
      weight: key.w ?? 0,
      curve: curveOf(key.ease ?? "inOut"),
    })),
  };
}

export function curveOf(ease: Ease): readonly [number, number, number, number] {
  return typeof ease === "string" ? EASE_CURVES[ease] : ease;
}

/** 구간 [a, b] 사이 frame의 진행률(이징 적용). b의 곡선을 쓴다. */
export function segmentProgress(a: CompiledKey, b: CompiledKey, frame: number): number {
  const span = b.frame - a.frame;
  if (span <= 0) return 1;
  const [x1, y1, x2, y2] = b.curve;
  return bezierEase(x1, y1, x2, y2, (frame - a.frame) / span);
}
