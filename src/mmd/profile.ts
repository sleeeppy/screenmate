import type { Calibration } from "./calibration";
import type { Emotion, ResolvedMorphs } from "./morphMap";

/**
 * 모델 프로필 (%APPDATA%\dev.sleeeppy.screenmate\profiles\<id>.json)
 *
 * `computed`는 로드할 때마다 다시 계산해 덮어쓴다.
 * `overrides`는 사용자가 직접 고치는 칸이고 앱은 건드리지 않는다.
 *
 * 예) 머리가 커 보이는 모델을 조금 작게:  "overrides": { "headY": 17.5 }
 *     웃는 표정을 다른 모프로:            "overrides": { "morphs": { "smile": [["にやり", 1]] } }
 *     물리 끄기:                          "overrides": { "physics": false }
 *     윤곽선 더 얇게:                     "overrides": { "edgeScale": 0.6 }
 *     하얗게 뜨는 모델 음영 살리기:       "overrides": { "ambientScale": 0.6 }
 * 저장소 모델용 기본값은 presets.ts에 있고, 여기 적은 값이 그보다 우선한다.
 */
export interface ModelProfile {
  version: 1;
  name: string;
  computed: {
    calibration: Calibration;
    morphs: ResolvedMorphs;
    morphCount: number;
    loadMs: number;
  };
  overrides: ProfileOverrides;
}

export interface ProfileOverrides {
  headY?: number;
  morphs?: ResolvedMorphs;
  /** false면 Bullet 물리를 끈다 (머리카락·치마가 고정됨, CPU 절약) */
  physics?: boolean;
  /** 윤곽선 두께 배율 (기본 1, 0이면 윤곽선 없음) */
  edgeScale?: number;
  /** 재질 ambient 배율 (기본 1). 낮추면 빛 받는 쪽 포화가 줄고 음영이 드러난다 */
  ambientScale?: number;
}

export function readOverrides(profile: unknown): ProfileOverrides {
  if (!profile || typeof profile !== "object" || !("overrides" in profile)) {
    return {};
  }
  const raw = (profile as { overrides: unknown }).overrides;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const overrides: ProfileOverrides = {};
  const { headY, morphs, physics, edgeScale, ambientScale } = raw as Record<string, unknown>;
  if (typeof ambientScale === "number" && ambientScale >= 0) {
    overrides.ambientScale = ambientScale;
  }
  if (typeof edgeScale === "number" && edgeScale >= 0) {
    overrides.edgeScale = edgeScale;
  }
  if (typeof headY === "number" && headY > 1) {
    overrides.headY = headY;
  }
  if (typeof physics === "boolean") {
    overrides.physics = physics;
  }
  if (morphs && typeof morphs === "object") {
    overrides.morphs = morphs as ResolvedMorphs;
  }
  return overrides;
}

export function applyOverrides(
  calibration: Calibration,
  morphs: ResolvedMorphs,
  overrides: ProfileOverrides,
): { calibration: Calibration; morphs: ResolvedMorphs } {
  return {
    calibration: overrides.headY ? { ...calibration, headY: overrides.headY } : calibration,
    morphs: { ...morphs, ...(overrides.morphs ?? {}) } as Record<Emotion, [string, number][]>,
  };
}
