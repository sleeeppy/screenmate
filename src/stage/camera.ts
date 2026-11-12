import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { CssRect } from "../ipc";
import type { StageSpace } from "./space";

/**
 * MMD 기본 시점처럼 -z에서 +z를 바라본다. MMD 모델은 -z를 향해 서 있으므로 회전 없이 정면이 보이고,
 * Babylon 기본 카메라 방향이라 화면 오른쪽 = 월드 +x가 된다 (걷기·던지기 방향이 뒤집히지 않음).
 */
const CAMERA_Z = -2000;

export function createStageCamera(scene: Scene): FreeCamera {
  const camera = new FreeCamera("stage", new Vector3(0, 0, CAMERA_Z), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.1;
  camera.maxZ = Math.abs(CAMERA_Z) * 4;
  camera.setTarget(new Vector3(0, 0, 0));
  return camera;
}

/** 캔버스가 덮는 화면 영역(CSS px)과 정확히 같은 월드 영역을 보도록 카메라를 맞춘다. */
export function aimAtBox(camera: FreeCamera, box: CssRect, space: StageSpace): void {
  const center = space.toWorld(box.x + box.width / 2, box.y + box.height / 2);
  camera.position.set(center.x, center.y, CAMERA_Z);
  camera.setTarget(new Vector3(center.x, center.y, 0));
  const halfWidth = box.width / (2 * space.pixelsPerUnit);
  const halfHeight = box.height / (2 * space.pixelsPerUnit);
  camera.orthoLeft = -halfWidth;
  camera.orthoRight = halfWidth;
  camera.orthoTop = halfHeight;
  camera.orthoBottom = -halfHeight;
}
