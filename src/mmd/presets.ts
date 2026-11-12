import type { ProfileOverrides } from "./profile";

/**
 * 모델별 기본 보정 (저장소에 함께 있는 모델용). 모델 id는 가져온 폴더·파일 이름으로 정해진다.
 * 사용자 프로필의 overrides가 이 값보다 우선한다.
 *
 * - DIVA風水着: 재질 ambient가 커서 빛 받는 쪽이 하얗게 포화되고 음영이 거의 안 보인다 → ambient를 줄인다.
 *   검은 윤곽선도 굵어 보여서 조금 더 얇게.
 * - YYB: 윤곽선 색이 밝은 갈색·분홍이라 테두리가 도드라진다 → 더 얇게.
 */
const PRESETS: { match: RegExp; overrides: ProfileOverrides }[] = [
  { match: /^DIVA風水着セット--/, overrides: { ambientScale: 0.55, edgeScale: 0.75 } },
  { match: /^YYB式鏡音レン/, overrides: { edgeScale: 0.55 } },
];

export function presetOverrides(modelId: string): ProfileOverrides {
  return PRESETS.filter((preset) => preset.match.test(modelId)).reduce<ProfileOverrides>(
    (merged, preset) => ({ ...merged, ...preset.overrides }),
    {},
  );
}
