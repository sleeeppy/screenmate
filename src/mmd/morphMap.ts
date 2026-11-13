/**
 * 감정 → 모프 별칭 테이블.
 *
 * 모델마다 같은 표정의 이름이 다르다 (ウィンク / ウインク / ｳｨﾝｸ, にこり / にっこり).
 * 비교 전에 NFKC 정규화(반각→전각)와 표기 차이 흡수를 하고,
 * 후보를 순서대로 찾아 첫 번째로 있는 모프를 쓴다. 후보가 여러 모프의 조합일 수도 있다.
 */
export type Emotion = "blink" | "smile" | "joy" | "surprise" | "shy" | "sleepy" | "trouble" | "angry" | "mouthA";

/** 하나의 후보: 모프 이름과 가중치 배율 목록 */
type Candidate = readonly (readonly [name: string, weight: number])[];

const ALIASES: Record<Emotion, readonly Candidate[]> = {
  blink: [[["まばたき", 1]], [["ウィンク", 1], ["ウィンク右", 1]]],
  smile: [[["笑い", 1]], [["にこり", 1]], [["にっこり", 1]]],
  joy: [[["にこり", 1]], [["にっこり", 1]], [["笑い", 1]]],
  surprise: [[["びっくり", 1]], [["瞳小", 1], ["あ", 0.4]]],
  shy: [[["照れ", 1]], [["笑い", 0.5]]],
  sleepy: [[["眠い目", 1]], [["なごみ", 1]], [["じと目", 0.7]]],
  trouble: [[["困る", 1]], [["真面目", 1]]],
  angry: [[["怒り", 1]], [["真面目", 1]]],
  mouthA: [[["あ", 1]]],
};

/** 감정마다 가장 흔한 모프 이름 (VMD 내보내기용: MMD 표준 표정 이름) */
export const DEFAULT_MORPH_NAMES: Record<Emotion, string> = Object.fromEntries(
  Object.entries(ALIASES).map(([emotion, candidates]) => [emotion, candidates[0][0][0]]),
) as Record<Emotion, string>;

export type ResolvedMorphs = Partial<Record<Emotion, [name: string, weight: number][]>>;

export function normalizeMorphName(name: string): string {
  return name
    .normalize("NFKC") // 반각 가타카나·전각 숫자 통일 (ｳｨﾝｸ２ → ウィンク2)
    .replace(/ウイン/g, "ウィン") // ウインク → ウィンク
    .replace(/\s+/g, "");
}

/** 모델에 있는 모프 이름 목록으로 감정별 실제 모프를 고른다. */
export function resolveMorphs(modelMorphNames: readonly string[]): ResolvedMorphs {
  const byNormalized = new Map<string, string>();
  for (const name of modelMorphNames) {
    const key = normalizeMorphName(name);
    if (!byNormalized.has(key)) {
      byNormalized.set(key, name);
    }
  }
  const resolved: ResolvedMorphs = {};
  for (const emotion of Object.keys(ALIASES) as Emotion[]) {
    for (const candidate of ALIASES[emotion]) {
      const actual = candidate.map(([name, weight]) => [byNormalized.get(normalizeMorphName(name)), weight] as const);
      if (actual.every(([name]) => name !== undefined)) {
        resolved[emotion] = actual.map(([name, weight]) => [name as string, weight]);
        break;
      }
    }
  }
  return resolved;
}
