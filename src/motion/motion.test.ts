import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MORPH_NAMES } from "../mmd/morphMap.ts";
import { MOTIONS } from "./clips/index.ts";
import { isPassingFrame, WALK_SPEED_UNITS } from "./clips/walk.ts";
import { KNEE_SOFT } from "./clips/pose.ts";
import { defineMotion, k } from "./dsl.ts";
import { motionFinished, motionFrame, samplePosition, sampleRotation, sampleWeight } from "./evaluate.ts";
import { bezierEase, quatFromEulerDeg, quatMul, quatSlerp, type Quat } from "./math.ts";
import { SwingLag } from "./layers.ts";
import { kneeBendForReach, rotateVec, solveLeg } from "./legReach.ts";
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

test("다리 IK를 쓰는 모션은 다리가 완전히 펴지지 않는다 (센터가 늘 기본 높이보다 낮음)", () => {
  for (const motion of MOTIONS.filter((candidate) => candidate.legIk)) {
    const center = motion.bones.find((track) => track.name === "センター");
    for (let frame = 0; frame <= motion.length; frame += 0.5) {
      const py = center ? samplePosition(center, frame, motion, [0, 0, 0])[1] : 0;
      assert.ok(py - KNEE_SOFT <= -0.05, `${motion.name} ${frame}프레임 센터 ${(py - KNEE_SOFT).toFixed(3)}`);
    }
  }
});

test("무릎 미리 굽히기: 곧은 다리는 최소 각, 가까울수록 더 굽히고 삼각형 관계를 만족한다", () => {
  const thigh = 4.6;
  const shin = 4.4;
  close(kneeBendForReach(thigh, shin, thigh + shin), (2 * Math.PI) / 180);
  close(kneeBendForReach(thigh, shin, 20), (2 * Math.PI) / 180); // 닿지 않으면 편 채로
  const bend = kneeBendForReach(thigh, shin, 8.6);
  assert.ok(bend > kneeBendForReach(thigh, shin, 8.9));
  // 굽힌 무릎에서 엉덩이~발목 거리 = 요청 거리 (코사인 법칙)
  const inner = Math.PI - bend;
  close(Math.sqrt(thigh * thigh + shin * shin - 2 * thigh * shin * Math.cos(inner)), 8.6, 1e-6);
});

test("해석적 다리 IK: 발목이 목표에 정확히 닿고, 무릎은 앞으로 굽는다", () => {
  // DIVA 린 기본 자세 값 (足→ひざ, ひざ→足首)
  const thigh: [number, number, number] = [-0.104, -4.631, -0.02];
  const shin: [number, number, number] = [0.05, -4.681, 0.104];
  for (const target of [
    [0.05, -9.17, 0.08], // 서 있기 (살짝 굽힘)
    [0.05, -8.0, -1.5], // 걷기 앞발
    [0.3, -7.2, 1.2], // 뒤로 + 옆
  ] as [number, number, number][]) {
    const { hip, knee } = solveLeg(target, thigh, shin);
    const kneePos = rotateVec(hip, thigh);
    const ankle = rotateVec(quatMul(hip, knee), shin);
    for (let axis = 0; axis < 3; axis++) close(kneePos[axis] + ankle[axis], target[axis], 1e-6);
    assert.ok(kneePos[2] < 0.2, `무릎이 앞(-z)으로 (z=${kneePos[2].toFixed(3)})`);
  }
  // 닿지 않으면 목표 방향으로 쭉 편다
  const far = solveLeg([0, -20, 0], thigh, shin);
  const reach = rotateVec(far.hip, thigh)[1] + rotateVec(quatMul(far.hip, far.knee), shin)[1];
  assert.ok(reach < -9.2);
});

test("걷기: 두 발이 엇갈리는 프레임에서 디딤발은 몸 아래, 반대 발은 몸 가까이 있다", () => {
  const walk = MOTIONS.find((motion) => motion.name === "walk")!;
  const z = (bone: string, frame: number) => samplePosition(walk.bones.find((track) => track.name === bone)!, frame, walk, [0, 0, 0])[2];
  for (const frame of [8.5, 23.5]) {
    assert.ok(isPassingFrame(frame));
    assert.ok(Math.abs(z("左足ＩＫ", frame)) < 0.6 && Math.abs(z("右足ＩＫ", frame)) < 0.6, `${frame}`);
  }
  assert.ok(!isPassingFrame(0) && !isPassingFrame(15));
});

test("걷기: 발을 뗄 때·디딜 때 발 속도가 끊기지 않는다 (걸음마다 멈칫하지 않음)", () => {
  const walk = MOTIONS.find((motion) => motion.name === "walk")!;
  const foot = walk.bones.find((track) => track.name === "左足ＩＫ")!;
  const at = (frame: number) => samplePosition(foot, frame, walk, [0, 0, 0]);
  // 디딤 끝(17)과 착지(30=0) 앞뒤 한 프레임 속도 비교
  // 30프레임 = 0프레임 (반복). 그 뒤는 0→1로 본다.
  const next = (frame: number) => (frame >= walk.length ? frame + 1 - walk.length : frame + 1);
  const here = (frame: number) => (frame >= walk.length ? 0 : frame);
  for (const contact of [17, 30]) {
    const before = at(contact)[2] - at(contact - 1)[2];
    const after = at(next(contact))[2] - at(here(contact))[2];
    // 방향이 바로 뒤집히거나 멈추지 않는다 (예전: 0.259 → -0.064).
    // 접점에서 속도는 이어지지만 한 프레임 평균에는 흔들기 감속이 섞여 2배까지 차이 난다.
    assert.ok(after > before * 0.3 && after < before * 2.5, `${contact}프레임 앞뒤 속도 ${before.toFixed(3)} → ${after.toFixed(3)}`);
    const up = at(next(contact))[1] - at(here(contact))[1];
    const down = at(contact)[1] - at(contact - 1)[1];
    assert.ok(Math.abs(up - down) < 0.35, `${contact}프레임 위아래 속도 ${down.toFixed(3)} → ${up.toFixed(3)}`);
  }
});

test("앉기 전환: 앉는 모션 끝 = 앉기 반복 첫 프레임 = 일어서는 모션 시작 (이음매 없음)", () => {
  const byName = (name: string) => MOTIONS.find((motion) => motion.name === name)!;
  for (const seat of ["edge", "floor"]) {
    const down = byName(`sit_down_${seat}`);
    const loop = byName(`sit_${seat}`);
    const up = byName(`stand_up_${seat}`);
    for (const track of loop.bones) {
      const downTrack = down.bones.find((candidate) => candidate.name === track.name);
      const upTrack = up.bones.find((candidate) => candidate.name === track.name);
      assert.ok(downTrack && upTrack, `${seat}/${track.name}: 전환에도 있어야 한다`);
      const at = (motion: typeof loop, target: typeof track, frame: number) => sampleRotation(target, frame, motion, [0, 0, 0, 1]);
      closeQuat(at(down, downTrack, down.length), at(loop, track, 0));
      closeQuat(at(up, upTrack, 0), at(loop, track, 0));
      if (track.hasPosition) {
        close(samplePosition(downTrack, down.length, down, [0, 0, 0])[1], samplePosition(track, 0, loop, [0, 0, 0])[1]);
      }
    }
    // 일어서기 끝과 앉기 시작은 선 자세(센터 0)
    const center = (motion: typeof loop, frame: number) =>
      samplePosition(motion.bones.find((track) => track.name === "センター")!, frame, motion, [0, 0, 0])[1];
    close(center(up, up.length), 0);
    close(center(down, 0), 0);
    assert.ok(!down.loop && !up.loop && !down.legIk && !up.legIk);
  }
});

test("자세 곡선: 키를 지나고, 중간 키에서 멈추지 않으며, 넘치지 않고, 시간 차가 있어도 끝 자세가 맞는다", async () => {
  const { splinePose } = await import("./spline.ts");
  const steps = [
    { frame: 0, pose: { センター: { py: 0 }, 首: { rx: 0 } } },
    { frame: 10, pose: { センター: { py: -3 }, 首: { rx: 10 } } },
    { frame: 20, pose: { センター: { py: -8 }, 首: { rx: 4 } } },
    { frame: 30, pose: { センター: { py: -9 }, 首: { rx: 4 } } },
  ];
  const tracks = splinePose(steps, 30, { 首: 3 });
  const center = tracks["センター"].map((key) => key.py ?? 0);
  // 키를 정확히 지난다
  close(center[0], 0);
  close(center[10], -3);
  close(center[20], -8);
  close(center[30], -9);
  // 중간 키(10프레임)에서 속도가 이어진다: 앞뒤 한 프레임 이동량이 비슷하고 0이 아니다
  const before = center[10] - center[9];
  const after = center[11] - center[10];
  assert.ok(before < -0.1 && after < -0.1 && Math.abs(after - before) < 0.25, `${before} → ${after}`);
  // 단조: 내려가기만 한다 (넘치지 않음)
  for (let i = 1; i < center.length; i++) assert.ok(center[i] <= center[i - 1] + 1e-9);
  // 시간 차가 있어도 처음·끝은 키 그대로, 가운데서는 늦게 따라온다
  const neck = tracks["首"].map((key) => key.rx ?? 0);
  close(neck[0], 0);
  close(neck[30], 4);
  assert.ok(neck[10] < 10 - 1, `늦게 따라온다 (${neck[10]})`);
});
