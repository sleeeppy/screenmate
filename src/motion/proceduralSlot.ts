import type { IMmdAnimation } from "babylon-mmd/esm/Loader/Animation/IMmdAnimation";
import type { IMmdBindableModelAnimation } from "babylon-mmd/esm/Runtime/Animation/IMmdBindableAnimation";
import type { IMmdRuntimeModelAnimation } from "babylon-mmd/esm/Runtime/Animation/IMmdRuntimeAnimation";
import type { IMmdModel } from "babylon-mmd/esm/Runtime/IMmdModel";
import type { ResolvedMorphs } from "../mmd/morphMap";
import { Blinker } from "./blink";

const EIGHT_HOURS_AT_30FPS = 30 * 60 * 60 * 8;

/**
 * 절차적 레이어를 꽂는 런타임 애니메이션 슬롯.
 * MmdModel.beforePhysics()가 animate()를 부른 뒤 부여·IK·물리를 푼다.
 * 그래서 여기서 바꾼 본·모프 값은 IK와 물리에 그대로 반영된다.
 * (M3에서 클립 컴포지트 + 숨쉬기·시선 레이어가 여기에 들어간다)
 */
export function createProceduralSlot(morphs: ResolvedMorphs): IMmdBindableModelAnimation {
  const animation: IMmdAnimation = {
    name: "procedural-slot",
    startFrame: 0,
    endFrame: EIGHT_HOURS_AT_30FPS,
  };

  return {
    ...animation,
    createRuntimeModelAnimation(model: IMmdModel): IMmdRuntimeModelAnimation {
      const blink = morphTargets(model, morphs.blink);
      const blinker = new Blinker();
      return {
        animation,
        animate() {
          const weight = blinker.weight(performance.now());
          for (const [index, scale] of blink) {
            model.morph.setMorphWeightFromIndex(index, weight * scale);
          }
        },
        induceMaterialRecompile() {},
      };
    },
  };
}

/** 모프 이름 → 인덱스 (같은 이름이 여러 개면 모두) */
function morphTargets(model: IMmdModel, entries: ResolvedMorphs[keyof ResolvedMorphs]): [number, number][] {
  const targets: [number, number][] = [];
  for (const [name, scale] of entries ?? []) {
    for (const index of model.morph.getMorphIndices(name) ?? []) {
      targets.push([index, scale]);
    }
  }
  return targets;
}
