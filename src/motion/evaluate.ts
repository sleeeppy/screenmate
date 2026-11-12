/** 컴파일된 모션 트랙을 특정 프레임에서 샘플링한다 (순수 TS). */
import { segmentProgress, type CompiledKey, type CompiledTrack, type Motion } from "./dsl.ts";
import { lerp, quatCopy, quatSlerp, type Quat, type Vec3 } from "./math.ts";

/** 재생 시간(초) → 모션 프레임. 반복 모션은 길이로 감싸고, 아니면 끝에서 멈춘다. */
export function motionFrame(motion: Motion, seconds: number): number {
  const frame = seconds * 30;
  if (motion.loop) {
    return motion.length > 0 ? ((frame % motion.length) + motion.length) % motion.length : 0;
  }
  return Math.min(frame, motion.length);
}

export function motionFinished(motion: Motion, seconds: number): boolean {
  return !motion.loop && seconds * 30 >= motion.length;
}

/**
 * 트랙에서 frame 양옆 키와 진행률을 찾는다.
 * 반복 모션에서 마지막 키 뒤는 첫 키(+length)로 이어진다.
 */
function bracket(
  track: CompiledTrack,
  frame: number,
  loop: boolean,
  length: number,
): [a: CompiledKey, b: CompiledKey, t: number] {
  const keys = track.keys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (keys.length === 1) return [first, first, 0];
  if (frame <= first.frame) {
    if (loop && first.frame > 0) {
      const wrapped: CompiledKey = { ...last, frame: last.frame - length };
      return [wrapped, first, segmentProgress(wrapped, first, frame)];
    }
    return [first, first, 0];
  }
  if (frame >= last.frame) {
    if (loop && last.frame < length) {
      const wrapped: CompiledKey = { ...first, frame: first.frame + length };
      return [last, wrapped, segmentProgress(last, wrapped, frame)];
    }
    return [last, last, 0];
  }
  // 키는 많아야 수십 개라 선형 탐색으로 충분하다.
  let index = 1;
  while (keys[index].frame < frame) index++;
  const a = keys[index - 1];
  const b = keys[index];
  return [a, b, segmentProgress(a, b, frame)];
}

export function sampleRotation(track: CompiledTrack, frame: number, motion: Motion, out: Quat): Quat {
  const [a, b, t] = bracket(track, frame, motion.loop, motion.length);
  return t <= 0 ? quatCopy(a.rotation, out) : quatSlerp(a.rotation, b.rotation, t, out);
}

export function samplePosition(track: CompiledTrack, frame: number, motion: Motion, out: Vec3): Vec3 {
  const [a, b, t] = bracket(track, frame, motion.loop, motion.length);
  out[0] = lerp(a.position[0], b.position[0], t);
  out[1] = lerp(a.position[1], b.position[1], t);
  out[2] = lerp(a.position[2], b.position[2], t);
  return out;
}

export function sampleWeight(track: CompiledTrack, frame: number, motion: Motion): number {
  const [a, b, t] = bracket(track, frame, motion.loop, motion.length);
  return lerp(a.weight, b.weight, t);
}
