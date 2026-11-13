import { Space } from "@babylonjs/core/Maths/math.axis";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { IMmdModel } from "babylon-mmd/esm/Runtime/IMmdModel";
import type { IMmdRuntimeBone } from "babylon-mmd/esm/Runtime/IMmdRuntimeBone";
import type { Calibration } from "../mmd/calibration";
import type { ResolvedMorphs } from "../mmd/morphMap";
import { Blinker } from "./blink";
import type { Motion } from "./dsl";
import { motionFinished, motionFrame, sampleRotation, samplePosition, sampleWeight } from "./evaluate";
import { Breathing, LookAt, SwingLag, type GazeTarget } from "./layers";
import { KNEE_SOFT } from "./clips/pose.ts";
import { quatConjugate, rotateVec, solveLeg } from "./legReach.ts";
import { IDENTITY, quatCopy, quatFromEulerDeg, quatMul, quatSlerp, type Quat, type Vec3 } from "./math";

/**
 * 준표준 본이 없는 모델(옛 PMD)을 위한 대체 본.
 * 대체 본에 원래 트랙이 있으면 회전은 곱하고 이동은 더한다.
 */
const BONE_FALLBACKS: Record<string, string | null> = {
  上半身2: "上半身",
  グルーブ: "センター",
  腰: null,
  左腕捩: null,
  右腕捩: null,
  左手捩: null,
  右手捩: null,
};

const LEG_IK_BONES = ["左足ＩＫ", "右足ＩＫ", "左つま先ＩＫ", "右つま先ＩＫ"];
/** 이동량에 legScale을 곱하는 본 */
const SCALED_POSITION_BONES = new Set(["センター", "グルーブ", "左足ＩＫ", "右足ＩＫ", "左つま先ＩＫ", "右つま先ＩＫ", "全ての親"]);

interface BoundBone {
  name: string;
  runtime: IMmdRuntimeBone;
  rest: Vector3;
  /** 이번 프레임 결과 */
  rotation: Quat;
  position: Vec3;
  touched: boolean;
  /** 지난 프레임에 우리가 값을 썼는지 (안 쓰게 되면 기본 자세로 한 번 되돌림) */
  written: boolean;
}

/** 해석적 다리 IK로 푸는 한쪽 다리 */
interface Leg {
  hip: BoundBone;
  knee: BoundBone;
  ankle: BoundBone;
  ik: BoundBone;
  /** 이 다리의 足ＩＫ 솔버 (우리가 대신 푸므로 끈다) */
  solverIndex: number;
}

interface Playing {
  motion: Motion;
  startedAt: number;
  /** 페이드인 진행 (0→1) */
  fade: number;
}

export interface DriverInputs {
  /** 시선 목표 (모델 로컬 단위, 머리 기준). 없으면 정면으로 돌아온다. */
  gaze(): GazeTarget | null;
  /** 들렸거나 떨어지는 중이면 몸 기울기(라디안, 화면 반시계 +). 아니면 null. */
  sway(): number | null;
}

/**
 * 흔들림 2차 움직임을 본마다 얼마나 나눠 줄지 (SwingLag 각도 배율, 화면 평면 = 각 본의 Z축).
 * 다리는 下半身 → 足으로 누적된다. 무릎은 크게 흔들릴수록 조금 더 굽힌다.
 */
const SWING_SHARE: Record<string, number> = {
  下半身: 0.35,
  左足: 0.35,
  右足: 0.35,
  // 종아리는 허벅지보다 한 번 더 늦게 (채찍처럼). 다리 끝은 몸보다 최대 약 17° 늦다.
  左ひざ: 0.15,
  右ひざ: 0.15,
  上半身: 0.1,
  首: 0.25,
  左腕: 0.7,
  右腕: 0.7,
};
const SWING_KNEE_BEND = 0.5;

const scratchQuatB: Quat = [0, 0, 0, 1];
const babylonQuat = new Quaternion();

/**
 * 모델 하나의 모션 재생기.
 * 클립 크로스페이드 → 모델 보정 → 절차적 레이어(숨쉬기·시선·깜빡임) 순서로 본과 모프에 값을 쓴다.
 * babylon-mmd가 이 값으로 부여 변환·IK·물리를 푼다.
 */
export class MotionDriver {
  private readonly bones = new Map<string, BoundBone>();
  private readonly morphIndices = new Map<string, [number, number][]>();
  private readonly morphWeights = new Map<string, number>();
  private readonly writtenMorphs = new Set<number>();
  private readonly legIkSolvers: number[] = [];
  private readonly legs: Leg[] = [];
  private readonly armCorrection: Record<string, Quat>;
  private readonly blinker = new Blinker();
  private readonly breathing = new Breathing();
  private readonly swingLag = new SwingLag();
  private readonly lookAt: LookAt;
  private playing: Playing[] = [];
  private lastTime = -1;
  private onFinished: ((motion: Motion) => void) | null = null;

  constructor(
    private readonly model: IMmdModel,
    private readonly calibration: Calibration,
    morphs: ResolvedMorphs,
    private readonly inputs: DriverInputs,
  ) {
    for (const runtime of model.runtimeBones) {
      if (!this.bones.has(runtime.name)) {
        const rest = new Vector3();
        runtime.linkedBone.getRestMatrix().getTranslationToRef(rest);
        this.bones.set(runtime.name, {
          name: runtime.name,
          runtime,
          rest,
          rotation: [0, 0, 0, 1],
          position: [0, 0, 0],
          touched: false,
          written: false,
        });
      }
    }
    for (const side of ["左", "右"]) {
      const hip = this.bones.get(`${side}足`);
      const knee = this.bones.get(`${side}ひざ`);
      const ankle = this.bones.get(`${side}足首`);
      const ik = this.bones.get(`${side}足ＩＫ`);
      if (!hip || !knee || !ankle || !ik || ik.runtime.ikSolverIndex < 0) continue;
      this.legs.push({ hip, knee, ankle, ik, solverIndex: ik.runtime.ikSolverIndex });
    }
    for (const name of LEG_IK_BONES) {
      const index = this.bones.get(name)?.runtime.ikSolverIndex ?? -1;
      if (index >= 0) this.legIkSolvers.push(index);
    }

    // 감정 이름 → 실제 모프 인덱스. 실제 모프 이름으로도 찾을 수 있게 같이 넣는다.
    for (const [emotion, entries] of Object.entries(morphs)) {
      const targets: [number, number][] = [];
      for (const [name, scale] of entries ?? []) {
        for (const index of model.morph.getMorphIndices(name) ?? []) targets.push([index, scale]);
      }
      this.morphIndices.set(emotion, targets);
    }

    // 팔 기본각 보정: 모션은 기준각(37°) 팔을 가정하고 작성한다.
    // 左腕 Z+ = 올림, 右腕 Z+ = 내림 이므로 좌우 부호가 반대다.
    this.armCorrection = {
      左腕: quatFromEulerDeg(0, 0, -calibration.armOffsetDeg.left),
      右腕: quatFromEulerDeg(0, 0, calibration.armOffsetDeg.right),
    };
    this.lookAt = new LookAt(this.bones.has("両目"));
  }

  /** 맨 위 모션의 현재 프레임 (30fps 기준). 재생 중인 모션이 없으면 null. */
  get currentFrame(): number | null {
    const top = this.playing[this.playing.length - 1];
    return top ? motionFrame(top.motion, performance.now() / 1000 - top.startedAt) : null;
  }

  get current(): Motion | null {
    return this.playing[this.playing.length - 1]?.motion ?? null;
  }

  /** 모션 재생. 같은 모션이 이미 재생 중이면 무시한다 (restart로 강제). */
  play(
    motion: Motion,
    options: { restart?: boolean; immediate?: boolean; onFinished?: (motion: Motion) => void } = {},
  ): void {
    const now = performance.now() / 1000;
    if (!options.restart && this.current?.name === motion.name) return;
    // immediate: 섞지 않고 바로 이 모션의 첫 프레임부터 (미리보기를 처음부터 다시 볼 때)
    if (options.immediate) this.playing = [];
    this.playing.push({ motion, startedAt: now, fade: this.playing.length === 0 ? 1 : 0 });
    // 완전히 덮인 오래된 클립은 버린다.
    if (this.playing.length > 3) this.playing.splice(0, this.playing.length - 3);
    this.onFinished = options.onFinished ?? null;
  }

  /** MmdModel.beforePhysics → 슬롯 animate()에서 매 프레임 호출 */
  update(): void {
    const now = performance.now() / 1000;
    const dt = this.lastTime < 0 ? 1 / 60 : Math.min(0.1, now - this.lastTime);
    this.lastTime = now;

    for (const bone of this.bones.values()) bone.touched = false;
    this.morphWeights.clear();

    this.mixClips(now, dt);
    this.applyCalibration();
    this.applyLayers(now, dt);
    this.solveLegs();
    this.writeBones();
    this.writeMorphs(now);
    this.writeIk();
  }

  /**
   * 레이어마다 자세를 따로 샘플링한 뒤 아래에서 위로 섞는다.
   * 위 레이어에 없는 본·모프는 기본 자세(회전 0, 이동 0, 가중치 0) 쪽으로 같이 페이드된다.
   */
  private mixClips(now: number, dt: number): void {
    const top = this.playing[this.playing.length - 1];
    if (top && top.fade < 1) {
      top.fade = Math.min(1, top.fade + dt / Math.max(0.01, top.motion.fadeIn));
      if (top.fade >= 1) this.playing = [top];
    }

    for (let layer = 0; layer < this.playing.length; layer++) {
      const entry = this.playing[layer];
      const pose = this.samplePose(entry.motion, motionFrame(entry.motion, now - entry.startedAt));
      if (layer === 0) {
        for (const [bone, sample] of pose.bones) {
          quatCopy(sample.rotation, bone.rotation);
          bone.position[0] = sample.position[0];
          bone.position[1] = sample.position[1];
          bone.position[2] = sample.position[2];
          bone.touched = true;
        }
        for (const [name, weight] of pose.morphs) this.morphWeights.set(name, weight);
        continue;
      }
      const weight = entry.fade;
      for (const bone of new Set([...pose.bones.keys(), ...this.touchedBones()])) {
        const sample = pose.bones.get(bone);
        if (!bone.touched) {
          quatCopy(IDENTITY, bone.rotation);
          bone.position[0] = bone.position[1] = bone.position[2] = 0;
          bone.touched = true;
        }
        quatSlerp(bone.rotation, sample?.rotation ?? IDENTITY, weight, bone.rotation);
        for (let axis = 0; axis < 3; axis++) {
          bone.position[axis] += ((sample?.position[axis] ?? 0) - bone.position[axis]) * weight;
        }
      }
      for (const name of new Set([...pose.morphs.keys(), ...this.morphWeights.keys()])) {
        const previous = this.morphWeights.get(name) ?? 0;
        this.morphWeights.set(name, previous + ((pose.morphs.get(name) ?? 0) - previous) * weight);
      }
    }

    if (top && this.onFinished && motionFinished(top.motion, now - top.startedAt)) {
      const callback = this.onFinished;
      this.onFinished = null;
      callback(top.motion);
    }
  }

  private *touchedBones(): Iterable<BoundBone> {
    for (const bone of this.bones.values()) if (bone.touched) yield bone;
  }

  /** 모션 하나를 한 프레임 샘플링. 같은 본으로 모이는 대체 트랙은 회전은 곱하고 이동은 더한다. */
  private samplePose(motion: Motion, frame: number): {
    bones: Map<BoundBone, { rotation: Quat; position: Vec3 }>;
    morphs: Map<string, number>;
  } {
    const bones = new Map<BoundBone, { rotation: Quat; position: Vec3 }>();
    for (const track of motion.bones) {
      const bone = this.resolveBone(track.name);
      if (!bone) continue;
      const rotation = track.hasRotation ? sampleRotation(track, frame, motion, [0, 0, 0, 1]) : quatCopy(IDENTITY, [0, 0, 0, 1]);
      const position: Vec3 = track.hasPosition ? samplePosition(track, frame, motion, [0, 0, 0]) : [0, 0, 0];
      const existing = bones.get(bone);
      if (existing) {
        quatMul(existing.rotation, rotation, existing.rotation);
        existing.position[0] += position[0];
        existing.position[1] += position[1];
        existing.position[2] += position[2];
      } else {
        bones.set(bone, { rotation, position });
      }
    }
    const morphs = new Map<string, number>();
    for (const track of motion.morphs) morphs.set(track.name, sampleWeight(track, frame, motion));
    return { bones, morphs };
  }

  private resolveBone(name: string): BoundBone | null {
    const direct = this.bones.get(name);
    if (direct) return direct;
    const fallback = BONE_FALLBACKS[name];
    return fallback ? this.bones.get(fallback) ?? null : null;
  }

  private applyCalibration(): void {
    const scale = this.calibration.legScale > 0 ? this.calibration.legScale : 1;
    // 무릎을 늘 살짝 굽힌다 (KNEE_SOFT 참고). 다리 IK를 끈 모션에도 똑같이 적용해 전환 때 튀지 않게.
    const center = this.bones.get("センター");
    if (center) {
      if (!center.touched) {
        quatCopy(IDENTITY, center.rotation);
        center.position[0] = center.position[1] = center.position[2] = 0;
        center.touched = true;
      }
      center.position[1] -= KNEE_SOFT;
    }
    for (const bone of this.bones.values()) {
      if (!bone.touched) continue;
      if (SCALED_POSITION_BONES.has(bone.name)) {
        bone.position[0] *= scale;
        bone.position[1] *= scale;
        bone.position[2] *= scale;
      }
      const correction = this.armCorrection[bone.name];
      if (correction) quatMul(bone.rotation, correction, bone.rotation);
    }
  }

  /**
   * 이번 프레임 우리 값(회전·이동)으로 본의 모델 공간 회전·위치를 구한다 (부여 변환은 무시).
   * 다리 IK를 풀 때 엉덩이·IK 목표 위치를 얻는 데만 쓴다.
   */
  private modelTransform(bone: BoundBone): { rotation: Quat; position: Vec3 } {
    const chain: BoundBone[] = [];
    let current: BoundBone | undefined = bone;
    while (current) {
      chain.push(current);
      const parent: IMmdRuntimeBone | null = current.runtime.parentBone;
      current = parent ? this.bones.get(parent.name) : undefined;
    }
    let rotation: Quat = [0, 0, 0, 1];
    let position: Vec3 = [0, 0, 0];
    for (let index = chain.length - 1; index >= 0; index--) {
      const link = chain[index];
      const local: Vec3 = [link.rest.x, link.rest.y, link.rest.z];
      if (link.touched) {
        local[0] += link.position[0];
        local[1] += link.position[1];
        local[2] += link.position[2];
      }
      const offset = rotateVec(rotation, local);
      position = [position[0] + offset[0], position[1] + offset[1], position[2] + offset[2]];
      if (link.touched) rotation = quatMul(rotation, link.rotation);
    }
    return { rotation, position };
  }

  /** 다리 IK를 쓰는 모션: 足ＩＫ 목표에 발목이 닿도록 足·ひざ를 해석적으로 푼다 (legReach.ts). */
  private solveLegs(): void {
    if (!(this.current?.legIk ?? true)) return;
    for (const leg of this.legs) {
      const parent = leg.hip.runtime.parentBone ? this.bones.get(leg.hip.runtime.parentBone.name) : undefined;
      const frame = parent ? this.modelTransform(parent) : { rotation: [0, 0, 0, 1] as Quat, position: [0, 0, 0] as Vec3 };
      const hipOffset = rotateVec(frame.rotation, [leg.hip.rest.x, leg.hip.rest.y, leg.hip.rest.z]);
      const hip: Vec3 = [frame.position[0] + hipOffset[0], frame.position[1] + hipOffset[1], frame.position[2] + hipOffset[2]];
      const target = this.modelTransform(leg.ik).position;
      const toTarget = rotateVec(quatConjugate(frame.rotation), [target[0] - hip[0], target[1] - hip[1], target[2] - hip[2]]);
      const solved = solveLeg(
        toTarget,
        [leg.knee.rest.x, leg.knee.rest.y, leg.knee.rest.z],
        [leg.ankle.rest.x, leg.ankle.rest.y, leg.ankle.rest.z],
      );
      for (const [bone, rotation] of [
        [leg.hip, solved.hip],
        [leg.knee, solved.knee],
      ] as const) {
        quatCopy(rotation, bone.rotation);
        bone.position[0] = bone.position[1] = bone.position[2] = 0;
        bone.touched = true;
      }
    }
  }

  private applyLayers(now: number, dt: number): void {
    const addRotation = (name: string, rotation: Quat) => {
      const bone = this.resolveBone(name);
      if (!bone) return;
      if (!bone.touched) {
        quatCopy(IDENTITY, bone.rotation);
        bone.position[0] = bone.position[1] = bone.position[2] = 0;
        bone.touched = true;
      }
      // 레이어는 부모 공간에서 모션 위에 덧붙인다.
      quatMul(rotation, bone.rotation, bone.rotation);
    };

    addRotation("上半身", this.breathing.chest(now, scratchQuatB));
    const gaze = this.lookAt.update(this.inputs.gaze(), dt);
    addRotation("首", quatFromEulerDeg(gaze.pitch * 0.4, gaze.yaw * 0.4, 0, scratchQuatB));
    addRotation("頭", quatFromEulerDeg(gaze.pitch * 0.6, gaze.yaw * 0.6, 0, scratchQuatB));
    if (gaze.eyes) addRotation("両目", quatFromEulerDeg(gaze.eyes.pitch, gaze.eyes.yaw, 0, scratchQuatB));

    // 흔들림 2차 움직임: 바닥에 서 있을 때는 0으로 가라앉는다.
    const lag = this.swingLag.update(this.inputs.sway(), dt);
    if (Math.abs(lag) > 0.05) {
      for (const [name, share] of Object.entries(SWING_SHARE)) {
        addRotation(name, quatFromEulerDeg(0, 0, lag * share, scratchQuatB));
      }
      const bend = -Math.abs(lag) * SWING_KNEE_BEND;
      addRotation("左ひざ", quatFromEulerDeg(bend, 0, 0, scratchQuatB));
      addRotation("右ひざ", quatFromEulerDeg(bend, 0, 0, scratchQuatB));
    }
  }

  private writeBones(): void {
    for (const bone of this.bones.values()) {
      if (!bone.touched) {
        if (bone.written) {
          // 더 이상 아무도 이 본을 움직이지 않는다 → 기본 자세로 되돌림
          bone.runtime.linkedBone.setRotationQuaternion(babylonQuat.set(0, 0, 0, 1), Space.LOCAL);
          bone.runtime.linkedBone.position = bone.rest.clone();
          bone.written = false;
        }
        continue;
      }
      const [x, y, z, w] = bone.rotation;
      bone.runtime.linkedBone.setRotationQuaternion(babylonQuat.set(x, y, z, w), Space.LOCAL);
      const position = bone.runtime.linkedBone.position;
      position.set(bone.rest.x + bone.position[0], bone.rest.y + bone.position[1], bone.rest.z + bone.position[2]);
      bone.runtime.linkedBone.position = position;
      bone.written = true;
    }
  }

  private writeMorphs(now: number): void {
    const morph = this.model.morph;
    const pending = new Map<number, number>();
    for (const [name, weight] of this.morphWeights) {
      for (const [index, scale] of this.morphIndices.get(name) ?? this.directMorph(name)) {
        pending.set(index, Math.max(pending.get(index) ?? 0, weight * scale));
      }
    }
    // 깜빡임은 표정 위에 최댓값으로 얹는다 (눈 감는 표정에서는 효과 없음).
    const blink = this.blinker.weight(now * 1000);
    for (const [index, scale] of this.morphIndices.get("blink") ?? []) {
      pending.set(index, Math.max(pending.get(index) ?? 0, blink * scale));
    }
    for (const index of this.writtenMorphs) {
      if (!pending.has(index)) morph.setMorphWeightFromIndex(index, 0);
    }
    this.writtenMorphs.clear();
    for (const [index, weight] of pending) {
      morph.setMorphWeightFromIndex(index, weight);
      this.writtenMorphs.add(index);
    }
  }

  private directMorph(name: string): [number, number][] {
    const indices = this.model.morph.getMorphIndices(name) ?? [];
    const targets = indices.map((index) => [index, 1] as [number, number]);
    this.morphIndices.set(name, targets);
    return targets;
  }

  private writeIk(): void {
    const enabled = (this.current?.legIk ?? true) ? 1 : 0;
    for (const index of this.legIkSolvers) this.model.ikSolverStates[index] = enabled;
    // 足ＩＫ는 solveLegs()가 대신 푼다. 발끝(つま先ＩＫ)은 그대로 솔버가 발목 각도를 맞춘다.
    for (const leg of this.legs) this.model.ikSolverStates[leg.solverIndex] = 0;
  }
}
