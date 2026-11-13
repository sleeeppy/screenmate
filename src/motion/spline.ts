/**
 * 자세 키들을 매끄러운 곡선으로 이어 매 프레임 샘플링한다 (순수 TS).
 *
 * DSL 키 보간은 구간마다 이징 곡선이라 기본(inOut)이면 키마다 속도가 0이 되어 멈칫거린다.
 * 여러 자세를 지나는 동작(앉기·일어서기)은 이 함수로 키 사이를 단조 3차 곡선(Fritsch–Carlson)으로 잇는다.
 * - 중간 키에서는 속도가 이어진다. 처음·끝 키에서만 멈춘다.
 * - 단조 곡선이라 키 값을 넘어서지 않는다 (넘치게 하고 싶으면 키를 직접 넣는다).
 * - 본마다 시간 차(delay, 프레임)를 줄 수 있다: 음수면 먼저, 양수면 늦게 움직인다 (상체가 앞서고 팔·머리가 따라옴).
 *   시간 차는 가운데서 가장 크고 처음·끝에서 0이라 시작·끝 자세는 늘 정확히 맞는다.
 */
import { k, type Key, type KeyValues } from "./dsl.ts";

export type Pose = Record<string, KeyValues>;
const AXES = ["rx", "ry", "rz", "px", "py", "pz"] as const;

/** 단조 3차 에르미트 기울기 (Fritsch–Carlson). 끝점 기울기는 0. */
function monotoneSlopes(times: readonly number[], values: readonly number[]): number[] {
  const n = values.length;
  const slopes = new Array<number>(n).fill(0);
  const secants: number[] = [];
  for (let i = 0; i < n - 1; i++) secants.push((values[i + 1] - values[i]) / (times[i + 1] - times[i]));
  for (let i = 1; i < n - 1; i++) {
    const a = secants[i - 1];
    const b = secants[i];
    if (a * b <= 0) continue; // 극값: 멈춘다 (넘치지 않게)
    // 조화 평균 (구간 길이 가중)
    const w1 = 2 * (times[i + 1] - times[i]) + (times[i] - times[i - 1]);
    const w2 = (times[i + 1] - times[i]) + 2 * (times[i] - times[i - 1]);
    slopes[i] = (w1 + w2) / (w1 / a + w2 / b);
  }
  return slopes;
}

function hermite(times: readonly number[], values: readonly number[], slopes: readonly number[], t: number): number {
  if (t <= times[0]) return values[0];
  const last = times.length - 1;
  if (t >= times[last]) return values[last];
  let i = 0;
  while (t > times[i + 1]) i++;
  const h = times[i + 1] - times[i];
  const s = (t - times[i]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * values[i] +
    (s3 - 2 * s2 + s) * h * slopes[i] +
    (-2 * s3 + 3 * s2) * values[i + 1] +
    (s3 - s2) * h * slopes[i + 1]
  );
}

/**
 * steps의 자세들을 지나는 곡선을 0..length 매 프레임 샘플링한 키 (선형 보간).
 * 본은 모든 자세에 나오는 것만. 축은 어느 자세에든 나오면 트랙이 되고, 없는 자세에서는 0.
 */
export function splinePose(
  steps: readonly { frame: number; pose: Pose }[],
  length: number,
  delays: Readonly<Record<string, number>> = {},
): Record<string, Key[]> {
  const bones = Object.keys(steps[0].pose).filter((bone) => steps.every((step) => bone in step.pose));
  const times = steps.map((step) => step.frame);
  const result: Record<string, Key[]> = {};
  for (const bone of bones) {
    const axes = AXES.filter((axis) => steps.some((step) => step.pose[bone][axis] !== undefined));
    const curves = axes.map((axis) => {
      const values = steps.map((step) => step.pose[bone][axis] ?? 0);
      return { axis, values, slopes: monotoneSlopes(times, values) };
    });
    const delay = delays[bone] ?? 0;
    const keys: Key[] = [];
    for (let frame = 0; frame <= length; frame++) {
      // 시간 차는 가운데서 가장 크고 처음·끝에서 0 (sin): 시작·끝 자세는 그대로 맞는다 (반복 모션과 이음매 없음)
      const shift = delay * Math.sin((Math.PI * frame) / length);
      const t = Math.max(times[0], Math.min(times[times.length - 1], frame - shift));
      const values: KeyValues = { ease: "linear" };
      for (const { axis, values: series, slopes } of curves) {
        (values as Record<string, number>)[axis] = Math.round(hermite(times, series, slopes, t) * 1e4) / 1e4;
      }
      keys.push(k(frame, values));
    }
    result[bone] = keys;
  }
  return result;
}
