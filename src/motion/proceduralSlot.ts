import type { IMmdAnimation } from "babylon-mmd/esm/Loader/Animation/IMmdAnimation";
import type { IMmdBindableModelAnimation } from "babylon-mmd/esm/Runtime/Animation/IMmdBindableAnimation";
import type { IMmdRuntimeModelAnimation } from "babylon-mmd/esm/Runtime/Animation/IMmdRuntimeAnimation";
import type { IMmdModel } from "babylon-mmd/esm/Runtime/IMmdModel";

const EIGHT_HOURS_AT_30FPS = 30 * 60 * 60 * 8;

/**
 * babylon-mmd 런타임 애니메이션 자리에 우리 모션 드라이버를 꽂는 어댑터.
 *
 * MmdModel.beforePhysics()가 animate()를 부른 뒤 부여 변환·IK·물리를 푼다.
 * 그래서 여기서 본·모프에 쓴 값이 그대로 IK와 물리의 입력이 된다.
 * 재생 시간은 드라이버가 실제 시각으로 관리하므로 frameTime은 쓰지 않는다.
 */
export function createProceduralSlot(bind: (model: IMmdModel) => { update(): void }): IMmdBindableModelAnimation {
  const animation: IMmdAnimation = {
    name: "screenmate-motion",
    startFrame: 0,
    endFrame: EIGHT_HOURS_AT_30FPS,
  };

  return {
    ...animation,
    createRuntimeModelAnimation(model: IMmdModel): IMmdRuntimeModelAnimation {
      const driver = bind(model);
      return {
        animation,
        animate() {
          driver.update();
        },
        induceMaterialRecompile() {},
      };
    },
  };
}
