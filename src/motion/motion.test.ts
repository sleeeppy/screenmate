import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MORPH_NAMES } from "../mmd/morphMap.ts";
import { MOTIONS } from "./clips/index.ts";
import { WALK_SPEED_UNITS } from "./clips/walk.ts";
import { defineMotion, k } from "./dsl.ts";
import { motionFinished, motionFrame, samplePosition, sampleRotation, sampleWeight } from "./evaluate.ts";
import { bezierEase, quatFromEulerDeg, quatMul, quatSlerp, type Quat } from "./math.ts";
import { SwingLag } from "./layers.ts";
import { encodeShiftJis, interpolationBytes, motionToVmd } from "./vmd.ts";

const close = (actual: number, expected: number, epsilon = 1e-4) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
const closeQuat = (a: Quat, b: Quat) => {
  // q와 -q는 같은 회전
  const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  for (let i = 0; i < 4; i++) close(a[i], b[i] * sign);
};

/** 쿼터니언으로 벡터 회전 (q v q⁻¹) */
function rotate(q: Quat, v: [number, number, number]): [number, number, number] {
  const p: Quat = [v[0], v[1], v[2], 0];
  const inverse: Quat = [-q[0], -q[1], -q[2], q[3]];
  const r = quatMul(quatMul(q, p), inverse);
  return [r[0], r[1], r[2]];
}

test("오일러각은 Babylon RotationYawPitchRoll과 같은 축·부호다", () => {
  // Babylon 행 벡터 규약: RotationY(+90)은 +x를 -z로, RotationZ(+90)은 +x를 +y로 보낸다.
  const yaw = rotate(quatFromEulerDeg(0, 90, 0), [1, 0, 0]);
  close(yaw[0], 0);
  close(yaw[2], -1);
  const roll = rotate(quatFromEulerDeg(0, 0, 90), [1, 0, 0]);
  close(roll[1], 1);
  // 문서화한 부호: 左腕(+x 방향) Z+ = 올림, 내린 팔 X+ = 앞(-z)으로
  assert.ok(rotate(quatFromEulerDeg(0, 0, 10), [1, -0.6, 0])[1] > -0.6);
  assert.ok(rotate(quatFromEulerDeg(10, 0, 0), [0, -1, 0])[2] < 0);
  // 머리(-z를 봄) X+ = 위
  assert.ok(rotate(quatFromEulerDeg(10, 0, 0), [0, 0, -1])[1] > 0);
});

test("슬러프 양 끝과 중간", () => {
  const a = quatFromEulerDeg(0, 0, 0);
  const b = quatFromEulerDeg(0, 90, 0);
  closeQuat(quatSlerp(a, b, 0), a);
  closeQuat(quatSlerp(a, b, 1), b);
  closeQuat(quatSlerp(a, b, 0.5), quatFromEulerDeg(0, 45, 0));
});

test("베지어 이징: 끝점 고정, 직선은 그대로, 단조 증가", () => {
  close(bezierEase(0.45, 0, 0.55, 1, 0), 0);
  close(bezierEase(0.45, 0, 0.55, 1, 1), 1);
  close(bezierEase(0.25, 0.25, 0.75, 0.75, 0.3), 0.3);
  close(bezierEase(0.45, 0, 0.55, 1, 0.5), 0.5, 1e-3);
  let previous = 0;
  for (let x = 0.05; x <= 1; x += 0.05) {
    const y = bezierEase(0.1, 0.7, 0.3, 1, x);
    assert.ok(y >= previous);
    previous = y;
  }
});

test("반복 모션은 끝에서 처음으로 이어지고, 한 번짜리는 끝에서 멈춘다", () => {
  const loop = defineMotion({
    name: "t",
    label: "t",
    loop: true,
    length: 30,
    bones: { 首: [k(0, { ry: 0 }), k(15, { ry: 20, ease: "linear" })] },
    morphs: { smile: [k(0, { w: 0 }), k(15, { w: 1, ease: "linear" })] },
  });
  const track = loop.bones[0];
  // 15 → 30(=0) 구간은 마지막 키에서 첫 키로 돌아온다
  closeQuat(sampleRotation(track, 22.5, loop, [0, 0, 0, 1]), quatSlerp(quatFromEulerDeg(0, 20, 0), quatFromEulerDeg(0, 0, 0), 0.5, [0, 0, 0, 1]));
  close(motionFrame(loop, 1.5), 15); // 45프레임 → 15
  close(sampleWeight(loop.morphs[0], 7.5, loop), 0.5);

  const once = defineMotion({ name: "o", label: "o", loop: false, length: 10, bones: { センター: [k(0, { py: 0 }), k(10, { py: -1 })] } });
  close(motionFrame(once, 5), 10);
  assert.equal(motionFinished(once, 0.2), false);
  assert.equal(motionFinished(once, 0.4), true);
  close(samplePosition(once.bones[0], 10, once, [0, 0, 0])[1], -1);
});

test("모든 모션: 반복 모션은 첫·끝 자세가 같고, 이름은 VMD 칸에 들어간다", () => {
  for (const motion of MOTIONS) {
    for (const track of motion.bones) {
      assert.ok(encodeShiftJis(track.name).length <= 15, `${motion.name}/${track.name}`);
      if (motion.loop) {
        const start = sampleRotation(track, 0, motion, [0, 0, 0, 1]);
        const end = sampleRotation(track, motion.length - 1e-3, motion, [0, 0, 0, 1]);
        closeQuat(end, start);
      }
    }
    for (const track of motion.morphs) {
      const name = DEFAULT_MORPH_NAMES[track.name as keyof typeof DEFAULT_MORPH_NAMES] ?? track.name;
      assert.ok(encodeShiftJis(name).length <= 15, `${motion.name}/${name}`);
    }
  }
});

test("걷기: 디딤발이 일정 속도로 뒤로 가서 몸 이동 속도와 맞출 수 있다", () => {
  const walk = MOTIONS.find((motion) => motion.name === "walk")!;
  const left = walk.bones.find((track) => track.name === "左足ＩＫ")!;
  const z = (frame: number) => samplePosition(left, frame, walk, [0, 0, 0])[2];
  close(z(7.5) - z(0), z(15) - z(7.5), 1e-3);
  assert.ok(z(15) > z(0)); // 뒤(+z)로
  // 디딤발 속도 = 몸 이동 속도 상수 (프레임 30fps)
  close((z(15) - z(0)) / (15 / 30), WALK_SPEED_UNITS, 1e-3);
  const lift = (frame: number) => samplePosition(left, frame, walk, [0, 0, 0])[1];
  assert.ok(lift(23) > 0.5);
  close(lift(7), 0);
});

test("VMD: 헤더, 프레임 수, 보간 64바이트 배치", () => {
  const motion = MOTIONS.find((candidate) => candidate.name === "hang")!;
  const bytes = motionToVmd(motion, { morphNames: DEFAULT_MORPH_NAMES });
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 25)), "Vocaloid Motion Data 0002");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boneCount = view.getUint32(50, true);
  assert.equal(boneCount, motion.bones.reduce((sum, track) => sum + track.keys.length, 0));
  const firstName = new TextDecoder("shift_jis").decode(bytes.subarray(54, 69)).replace(/\0.*$/, "");
  assert.equal(firstName, motion.bones[0].name);

  const interpolation = interpolationBytes([0.5, 0, 1, 1]);
  assert.equal(interpolation[0], 64); // X_x1
  assert.deepEqual([...interpolation.subarray(2, 4)], [0x63, 0x0f]); // 물리 on
  assert.equal(interpolation[4], 0); // X_y1
  assert.equal(interpolation[16], 64); // 1행 = Y_x1부터
  assert.equal(interpolation[63], 0);
});

test("흔들림 2차 움직임: 몸이 반시계로 돌기 시작하면 팔다리는 시계 방향으로 처졌다가 가라앉는다", () => {
  const lag = new SwingLag();
  const dt = 1 / 60;
  let roll = 0;
  lag.update(roll, dt);
  let min = 0;
  for (let i = 0; i < 12; i++) {
    roll += 0.02; // 1.2 rad/s 반시계
    min = Math.min(min, lag.update(roll, dt));
  }
  assert.ok(min < -3, `처짐 ${min}°`);
  let last = 0;
  for (let i = 0; i < 240; i++) last = lag.update(roll, dt); // 4초 정지
  assert.ok(Math.abs(last) < 0.5, `가라앉음 ${last}°`);
  // 서 있으면(null) 입력 없이 가라앉기만 한다
  assert.ok(Math.abs(lag.update(null, dt)) < 0.5);
});
