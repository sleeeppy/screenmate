/**
 * 캐릭터 행동: 상태 머신 + 몸(발 위치) 물리. 순수 TS (Node에서 테스트).
 *
 * 좌표는 화면 CSS px (y 아래로 증가). 발 위치가 캐릭터의 기준점이다.
 *
 *   idle ──타이머──▶ walk ──시간/화면 끝──▶ idle
 *    │ ▲
 *    │ └── land ◀── fall ◀── 놓기(던지기) ── held ◀── 잡고 끌기 (어느 상태에서든)
 *    └── 클릭: 머리 → pat, 몸 → poke ──▶ idle
 *
 * 발판은 바닥(작업 영역 아래) 또는 창 위쪽 테두리(Ledge). 창 위에 서 있으면 창을 따라 움직이고,
 * 창이 사라지거나(닫힘·최소화·가려짐) 세게 흔들리거나 끝에서 발을 헛디디면 떨어진다.
 * 떨어질 때는 위에서 아래로 지나는 테두리에만 착지한다 (아래에서 올라갈 때는 통과).
 */
import { clamp, damp } from "../motion/math.ts";
import type { Ledge } from "./platforms.ts";

export type BehaviorState = "idle" | "walk" | "held" | "fall" | "land" | "react" | "act" | "sit" | "sleep" | "rise";

export interface BehaviorOptions {
  /**
   * 서 있다가 가끔 두리번거리기·기지개, 창 위에서 걸터앉기, 바닥에 앉기를 한다.
   * 난수를 더 쓰므로 기존 행동 테스트(고정 난수 순서)와 섞이지 않게 앱에서만 켠다.
   */
  variety?: boolean;
  /** 이 시간(초) 동안 사용자 입력이 없으면 앉아서 존다 (기본 10분) */
  sleepAfter?: number;
}
export type BehaviorActivity = "interact" | "near" | "idle";

export interface Arena {
  /** 발이 닿는 바닥 y (작업표시줄 위) */
  ground: number;
  left: number;
  right: number;
  top: number;
  /** 창 위쪽 테두리 발판 */
  ledges?: readonly Ledge[];
}

export interface Actor {
  /** 캐릭터 키 (頭 높이) px */
  readonly heightPx: number;
  /** 걷기 모션과 발이 미끄러지지 않는 몸 이동 속도 (정면 기준) px/s */
  readonly walkSpeedPx: number;
  play(motion: string, onFinished?: () => void): void;
  /** 걷다가 지금 멈춰도 되는지 (두 발이 몸 아래에서 엇갈리는 순간). 없으면 언제든 멈춘다. */
  canStopWalking?(): boolean;
}

export interface Point {
  x: number;
  y: number;
}

/** 걷기 때 몸을 돌리는 각도. 완전 옆모습(90°)보다 3/4가 표정이 보여 좋다. */
export const WALK_FACING = (70 * Math.PI) / 180;
const GRAVITY = 2600;
const MAX_THROW = 3000;
/** 이 속도(px/s) 이상으로 떨어지면 착지 모션 */
const LAND_IMPACT = 650;
const WALL_BOUNCE = 0.35;
/** 들린 채 흔들림: 진자 고유 진동수(Hz)와 감쇠비 */
const SWAY_HZ = 0.85;
const SWAY_DAMPING = 0.22;
const SWAY_MAX = (38 * Math.PI) / 180;
/** 진자 목표 기울기는 이 값에 부드럽게 다가간다 (tanh). SWAY_MAX에 딱 부딪혀 멈추지 않게. */
const SWAY_TARGET_MAX = SWAY_MAX * 0.75;
/** 끄는 속도에서 나온 목표 기울기를 이 반감기(초)로 거른다. 프레임 간격이 고르지 않으면 속도가 튄다. */
const SWAY_TARGET_SMOOTH = 0.05;
/** 진자를 이 고정 간격(초)으로 나눠 적분한다 (렌더 간격과 무관하게 매끄럽게) */
const SWAY_STEP = 1 / 240;
/** 끄는 속도 1000px/s당 기울기 */
const SWAY_PER_SPEED = (20 * Math.PI) / 180 / 1000;
/** 창 흔들림 판정: 최근 이 시간(s) 동안 창이 움직인 평균 속력으로 본다 */
const SHAKE_WINDOW = 0.25;
/** 이 속력(px/s) 이상으로 창이 움직이면 떨어진다. 보통 창 끌기는 1000 안팎. */
const SHAKE_SPEED = 2500;
/** 흔들려 떨어질 때 창 속도를 이만큼 물려받는다 */
const SHAKE_CARRY = 0.5;
/** 창 따라가기: 이 시간(초) 넘게 창 위치가 안 바뀌면 멈춘 것으로 본다 / 남은 오차를 메우는 반감기 */
const FOLLOW_STOP_AFTER = 0.05;
const FOLLOW_CATCH_UP = 0.04;
/** 창 속도 어림 상한 (px/s) */
const FOLLOW_MAX_SPEED = 4000;
/** 흔들려 떨어질 때 위로 튕기는 속도 (px/s) */
const SHAKE_HOP = 420;
/** 창 끝에 닿았을 때 발을 헛디뎌 떨어질 확률 (나머지는 돌아서기·멈추기) */
const STEP_OFF_CHANCE = 0.2;
/** 놓은 발이 테두리에서 이 범위(위 / 아래 px) 안이면 그 창 위에 바로 선다 */
const LEDGE_SNAP = { above: 12, below: 6 };
/** 걷다 멈출 때 발이 엇갈리는 순간을 이만큼(초)까지 기다린다 (반 걸음 = 0.5초) */
const STOP_WAIT_MAX = 0.6;
/**
 * 들고 있은 지 이만큼(초) 지나거나, 잡은 손의 평균 속력(0.3초 지수 평균, px/s)이 이 값을 넘으면 버둥거린다.
 * 진자(0.85Hz) 흔들림으로 재면 빠르게 흔들수록 오히려 작아져서 손 속력으로 잰다. 보통 끌기는 1000 안팎.
 */
const STRUGGLE_AFTER = 3;
const STRUGGLE_SHAKE = 1800;
/** 버둥거리기를 한 번 시작하면 최소 이만큼(초)은 계속한다 (깜빡이지 않게) */
const STRUGGLE_MIN = 1.2;
/** 서 있기가 끝났을 때 고르는 확률 (variety): 창 위 걸터앉기, 바닥 앉기, 두리번, 기지개. 나머지는 걷기 */
const IDLE_CHOICES = { sitEdge: 0.3, sitFloor: 0.06, look: 0.14, stretch: 0.08 };
/** 걸터앉거나 바닥에 앉아 있는 시간 (초) */
const SIT_SECONDS = { min: 8, max: 18 };
/** 앉을 때 몸을 돌리는 각도 (라디안, 약 18°) */
const SIT_FACING = (18 * Math.PI) / 180;
/** 앉았을 때 머리 꼭대기 높이 / 선 키 (clips/sit.ts SIT_HEAD_RATIO와 같게) */
const SIT_HEAD_RATIO = 0.42;

export class Behavior {
  state: BehaviorState = "idle";
  feet: Point = { x: 0, y: 0 };
  /** 몸 방향 (라디안, 0 = 정면, + = 화면 왼쪽을 봄) */
  facing = 0;
  /** 화면에서 반시계 방향 기울기 (라디안). 들렸을 때 흔들림 */
  roll = 0;
  /** true면 자율 행동을 멈추고 지정 모션만 (미리보기·검증) */
  paused = false;

  private velocity: Point = { x: 0, y: 0 };
  private targetFacing = 0;
  private stateTime = 0;
  private stateLength = 0;
  private walkDirection: 1 | -1 = 1;
  private rollVelocity = 0;
  /** 거른 진자 목표 기울기 */
  private swayTarget = 0;
  private grabOffset: Point = { x: 0, y: 0 };
  private pointer: Point = { x: 0, y: 0 };
  private held: Point = { x: 0, y: 0 };
  private samples: { x: number; y: number; t: number }[] = [];
  /** 서 있는 창 id (null = 바닥) */
  private ledgeId: number | null = null;
  /** 마지막으로 본 발판 창 위치 (창 이동량 계산용) */
  private ledgeAnchor: Point = { x: 0, y: 0 };
  /** 최근 창 이동 평균 속력 / 평균 속도 (SHAKE_WINDOW 지수 평균, px/s) */
  private ledgeSpeed = 0;
  private ledgeVelocity: Point = { x: 0, y: 0 };
  /** 화면에 보이는 발판 창 위치(부드럽게 따라감), 창 속도 어림, 마지막 위치 변화 뒤 시간 */
  private ledgeShown: Point = { x: 0, y: 0 };
  private ledgeEstimate: Point = { x: 0, y: 0 };
  private ledgeSampleAge = 0;
  /** 떨어져 나온 창: 바닥이나 다른 창에 닿을 때까지 그 창에는 착지하지 않는다 */
  private ignoredLedge: number | null = null;
  /** 걷기를 멈추려고 발이 엇갈리는 순간을 기다리는 중 (blocked면 제자리에서) */
  private stopping: { time: number; blocked: boolean } | null = null;
  /** 창 끝에서 발을 헛디뎌 걸어 나가는 중 */
  private steppingOff = false;

  // Node 타입 제거 모드는 생성자 매개변수 속성을 지원하지 않아 필드를 따로 둔다.
  private readonly actor: Actor;
  private readonly random: () => number;
  private readonly options: BehaviorOptions;
  /** 앉는 모션을 하는 중 (반복 모션으로 넘어가기 전) / 일어서는 중의 앉은 자세 */
  private seatMoving = false;
  private riseSeat: "edge" | "floor" = "floor";
  /** 미리보기에서 보여 줄 앉은 자세 */
  private previewSeat: "edge" | "floor" | null = null;
  /** 마지막 사용자 입력 이후 시간 (초) */
  private quietTime = 0;
  /** 들고 있은 시간, 진자 흔들림 속도 평균, 버둥거리기 중인지 */
  private heldTime = 0;
  private shake = 0;
  private struggling = false;
  private struggleTime = 0;

  constructor(actor: Actor, random: () => number = Math.random, options: BehaviorOptions = {}) {
    this.actor = actor;
    this.random = random;
    this.options = options;
  }

  /** 박스를 넉넉하게(회전·매달림 포함) 잡아야 하는 상태인지 */
  /**
   * 몸이 매달린 기준점 (CSS px): 들고 있으면 잡은 점(커서), 아니면 가슴 높이.
   * 물리용 월드 위치를 이 점 기준으로 줄인다 (engine.ts PHYSICS_TRAVEL). 발 기준으로 줄이면
   * 들고 흔들 때 화면에서는 가만히 있는 목이 물리 세계에서는 크게 휘둘린다.
   */
  get pivot(): Point {
    if (this.state === "held") return { ...this.held };
    const chest = rotateCss({ x: 0, y: -this.actor.heightPx * 0.6 }, this.roll);
    return { x: this.feet.x + chest.x, y: this.feet.y + chest.y };
  }

  get airborne(): boolean {
    return this.state === "held" || this.state === "fall";
  }

  /** 창 위에 서 있는지 (Rust 창 폴링을 빠르게 할지) */
  get onLedge(): boolean {
    return this.ledgeId !== null;
  }

  /** 앉은 자세: 창 테두리에 걸터앉았는지, 바닥에 앉았는지 (상자 모양·클릭 판정용) */
  get seat(): "edge" | "floor" | null {
    if (this.state === "rise") return this.riseSeat;
    if (this.state !== "sit" && this.state !== "sleep") return null;
    if (this.paused && this.previewSeat) return this.previewSeat;
    return this.ledgeId !== null ? "edge" : "floor";
  }

  /** 발 기준점에서 머리 꼭대기까지 높이 (px). 앉으면 낮아진다. */
  get headHeight(): number {
    return this.actor.heightPx * (this.seat ? SIT_HEAD_RATIO : 1);
  }

  /** 사용자 입력(커서 근처·클릭·끌기)이 있었다. 졸고 있었으면 깬다. */
  noteActivity(): void {
    this.quietTime = 0;
    if (this.state === "sleep" && !this.paused) this.rise();
  }

  activity(): BehaviorActivity {
    if (this.state === "held" || this.state === "fall" || this.state === "land" || this.state === "react") return "interact";
    if (this.state === "act") return "near";
    // 앉는 중·일어서는 중은 매 프레임 그린다
    if (this.state === "rise" || this.seatMoving) return "interact";
    // 서 있는 창이 움직이는 동안은 매 프레임 그려야 매끄럽게 따라간다
    if (this.ledgeId !== null && this.ledgeSpeed > 20) return "interact";
    if (this.state === "walk" || Math.abs(this.facing - this.targetFacing) > 0.02) return "near";
    return "idle";
  }

  /** 땅 위 지정 위치에서 시작 */
  place(x: number, arena: Arena): void {
    this.feet = { x: clamp(x, arena.left + this.margin(), arena.right - this.margin()), y: arena.ground };
    this.ledgeId = null;
    this.velocity = { x: 0, y: 0 };
    this.enter("idle", 3 + this.random() * 4);
  }

  /** 화면 크기가 바뀌었을 때: 땅에 있으면 새 바닥에 맞추고 화면 안으로 */
  fit(arena: Arena): void {
    const margin = this.margin();
    this.feet.x = clamp(this.feet.x, arena.left + margin, arena.right - margin);
    if (!this.airborne && this.ledgeId === null) this.feet.y = arena.ground;
  }

  /** 공중 한 점에서 떨어뜨린다 (검증용 `--drop-on-window`) */
  dropFrom(point: Point): void {
    this.feet = { ...point };
    this.ledgeId = null;
    this.ignoredLedge = null;
    this.velocity = { x: 0, y: 0 };
    this.targetFacing = 0;
    this.enter("fall");
    this.actor.play("fall");
  }

  /** 미리보기: 자율 행동을 멈추고 모션만 재생 (걷기는 제자리에서 옆으로 돈 채로) */
  preview(motion: string): void {
    this.paused = true;
    // 앉기 미리보기는 앉은 상태로 둔다 (캔버스 상자·클릭 판정이 앉은 자세에 맞게)
    const seated = motion.startsWith("sit_") || motion.startsWith("sleep_");
    this.previewSeat = seated ? (motion.endsWith("_edge") ? "edge" : "floor") : null;
    this.enter(seated ? (motion.startsWith("sleep_") ? "sleep" : "sit") : "idle");
    const turning = seated || motion.startsWith("sit_down_") || motion.startsWith("stand_up_");
    this.targetFacing = motion === "walk" ? -WALK_FACING : turning ? -SIT_FACING : 0;
    // 앉는 모션은 실제 행동처럼 끝나면 앉기 반복으로 이어서 보여 준다
    if (motion.startsWith("sit_down_")) {
      const seat = motion.endsWith("_edge") ? "edge" : "floor";
      this.previewSeat = seat;
      this.enter("sit");
      this.actor.play(motion, () => this.actor.play(`sit_${seat}`));
      return;
    }
    this.actor.play(motion);
  }

  /** 미리보기 끝: 자율 행동으로 */
  resume(): void {
    this.paused = false;
    this.toIdle();
  }

  update(dt: number, arena: Arena): void {
    this.stateTime += dt;
    if (!this.airborne && this.ledgeId !== null) this.followLedge(dt, arena);
    switch (this.state) {
      case "idle":
        this.updateIdle();
        break;
      case "walk":
        this.updateWalk(dt, arena);
        break;
      case "held":
        this.updateHeld(dt);
        break;
      case "fall":
        this.updateFall(dt, arena);
        break;
      case "sit":
        if (!this.paused && !this.seatMoving && this.stateTime >= this.stateLength) this.rise();
        break;
      case "rise":
        break;
      case "land":
      case "react":
      case "act":
      case "sleep":
        break;
    }
    // 오래 아무 입력이 없으면 그 자리에 앉아 존다 (창 위면 걸터앉아서)
    if (!this.airborne && !this.paused) {
      this.quietTime += dt;
      const sleepAfter = this.options.sleepAfter ?? 600;
      if (this.quietTime >= sleepAfter && (this.state === "idle" || this.state === "sit")) this.sit(true);
    }
    if (!this.airborne) {
      this.roll = damp(this.roll, 0, 0.08, dt);
      this.rollVelocity = 0;
    }
    this.facing = damp(this.facing, this.targetFacing, this.state === "walk" ? 0.1 : 0.16, dt);
  }

  // ---------------------------------------------------------------- 입력

  /** 캐릭터 위에서 눌러 끌기 시작 */
  grab(pointer: Point, now: number): void {
    this.grabOffset = { x: this.feet.x - pointer.x, y: this.feet.y - pointer.y };
    this.pointer = { ...pointer };
    this.held = { ...pointer };
    this.samples = [{ ...pointer, t: now }];
    this.velocity = { x: 0, y: 0 };
    this.rollVelocity = 0;
    this.swayTarget = 0;
    this.targetFacing = 0;
    this.ledgeId = null;
    this.ignoredLedge = null;
    this.heldTime = 0;
    this.shake = 0;
    this.struggling = false;
    this.quietTime = 0;
    this.enter("held");
    this.actor.play("hang");
  }

  drag(pointer: Point, now: number): void {
    if (this.state !== "held") return;
    this.pointer = { ...pointer };
    this.samples.push({ ...pointer, t: now });
    // 최근 0.1초만 남겨 던지는 속도를 잰다
    while (this.samples.length > 2 && now - this.samples[0].t > 100) this.samples.shift();
  }

  release(now: number, arena: Arena): void {
    if (this.state !== "held") return;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const span = (last.t - first.t) / 1000;
    const stale = now - last.t > 80; // 멈췄다 놓으면 속도 0
    const velocity =
      span > 0.01 && !stale ? { x: (last.x - first.x) / span, y: (last.y - first.y) / span } : { x: 0, y: 0 };
    const speed = Math.hypot(velocity.x, velocity.y);
    const scale = speed > MAX_THROW ? MAX_THROW / speed : 1;
    this.velocity = { x: velocity.x * scale, y: velocity.y * scale };
    const ledge =
      this.velocity.y >= 0
        ? arena.ledges?.find(
            (candidate) =>
              this.feet.x >= candidate.left &&
              this.feet.x <= candidate.right &&
              this.feet.y >= candidate.y - LEDGE_SNAP.above &&
              this.feet.y <= candidate.y + LEDGE_SNAP.below,
          )
        : undefined;
    if (ledge) {
      this.standOn(ledge);
      this.velocity = { x: 0, y: 0 };
      this.toIdle();
      return;
    }
    if (this.feet.y >= arena.ground - 2 && this.velocity.y >= 0) {
      this.feet.y = arena.ground;
      this.velocity = { x: 0, y: 0 };
      this.toIdle();
      return;
    }
    this.enter("fall");
    this.actor.play("fall");
  }

  /** 끌지 않고 짧게 클릭 */
  click(pointer: Point): void {
    if (this.airborne || this.state === "land" || this.state === "rise") return;
    this.quietTime = 0;
    // 머리 꼭대기(서 있으면 頭 높이 = heightPx, 앉으면 더 낮다)보다 살짝 아래부터 머리로 본다.
    const head = pointer.y < this.feet.y - this.headHeight * 0.9;
    // 앉아 있으면 먼저 일어선 다음 반응한다 (앉은 채로 선 자세 반응을 하면 튄다)
    if (this.seat && !this.paused) {
      this.rise(head ? "pat" : "poke");
      return;
    }
    this.targetFacing = 0;
    this.enter("react");
    this.actor.play(head ? "pat" : "poke", () => this.toIdle());
  }

  // ---------------------------------------------------------------- 상태별

  private updateIdle(): void {
    if (this.paused || this.stateTime < this.stateLength) return;
    if (this.options.variety) {
      const pick = this.random();
      const { sitEdge, sitFloor, look, stretch } = IDLE_CHOICES;
      if (this.ledgeId !== null && pick < sitEdge) {
        this.sit(false);
        return;
      }
      if (this.ledgeId === null && pick < sitFloor) {
        this.sit(false);
        return;
      }
      if (pick >= 1 - look - stretch) {
        this.targetFacing = 0;
        this.enter("act");
        this.actor.play(pick >= 1 - stretch ? "idle_stretch" : "idle_look", () => this.toIdle());
        return;
      }
    }
    this.walkDirection = this.random() < 0.5 ? 1 : -1;
    this.enter("walk", 2 + this.random() * 4);
    this.actor.play("walk");
  }

  private updateWalk(dt: number, arena: Arena): void {
    this.targetFacing = -this.walkDirection * WALK_FACING;
    // 멈추기: 걸음 중간에 바로 서면 앞뒤로 벌린 발이 서 있기 자세로 미끄러진다.
    // 두 발이 몸 아래에서 엇갈리는 순간까지 마저 걷고 멈춘다 (들린 발은 그대로 내려놓는다).
    if (this.stopping) {
      this.stopping.time += dt;
      if ((this.actor.canStopWalking?.() ?? true) || this.stopping.time >= STOP_WAIT_MAX) {
        this.toIdle();
        return;
      }
    }
    // 몸이 거의 돌아선 뒤에 출발 (돌면서 미끄러지지 않게)
    const turned = Math.abs(this.facing - this.targetFacing) < 0.25;
    if (turned && !this.stopping?.blocked) {
      // 몸을 돌린 만큼 다리 보폭의 화면 가로 성분이 줄어든다
      const speed = this.actor.walkSpeedPx * Math.sin(Math.abs(this.facing));
      this.feet.x += this.walkDirection * speed * dt;
    }
    const { left, right } = this.walkBounds(arena);
    // 끝을 향해 걷고 있을 때만 판정한다 (돌아서는 동안 매 프레임 다시 걸리지 않게)
    const atLeft = this.walkDirection < 0 && this.feet.x <= left;
    const atRight = this.walkDirection > 0 && this.feet.x >= right;
    if ((atLeft || atRight) && !this.steppingOff) {
      // 화면·창 끝: 창 위면 가끔 발을 헛디디고, 아니면 돌아서서 계속 걷거나 멈춘다
      const roll = this.random();
      // 화면 끝과 겹친 창 끝에서는 헛디디지 않는다 (화면 밖으로 떨어지지 않게)
      const margin = this.margin();
      const screenEdge = atRight ? this.feet.x >= arena.right - margin - 1 : this.feet.x <= arena.left + margin + 1;
      if (this.ledgeId !== null && roll < STEP_OFF_CHANCE && !screenEdge) {
        this.steppingOff = true;
        return;
      }
      this.feet.x = clamp(this.feet.x, left, right);
      if (roll < 0.6) {
        this.walkDirection = atLeft ? 1 : -1;
      } else {
        this.stopping = { time: 0, blocked: true };
        return;
      }
    }
    if (!this.paused && !this.stopping && this.stateTime >= this.stateLength) this.stopping = { time: 0, blocked: false };
  }

  private updateHeld(dt: number): void {
    // 커서를 바로 따라가되 한 프레임 튀는 값은 조금 눌러 준다 (물리 폭주 방지)
    const previous = { ...this.held };
    this.held.x = damp(this.held.x, this.pointer.x, 0.025, dt);
    this.held.y = damp(this.held.y, this.pointer.y, 0.025, dt);
    const vx = dt > 0 ? (this.held.x - previous.x) / dt : 0;

    // 진자: 끄는 방향 반대로 발이 처진다. 회전 중심은 잡은 점.
    // 프레임 간격이 ±10%만 들쭉날쭉해도 한 프레임 속도로 만든 목표가 튀어 기울기가 떨렸다 (3차 차분 12배).
    // 목표를 tanh로 눌러 거르고, 진자는 고정 간격으로 나눠 적분한다.
    const omega = 2 * Math.PI * SWAY_HZ;
    const raw = -vx * SWAY_PER_SPEED;
    this.swayTarget = damp(this.swayTarget, SWAY_TARGET_MAX * Math.tanh(raw / SWAY_TARGET_MAX), SWAY_TARGET_SMOOTH, dt);
    const steps = Math.max(1, Math.ceil(dt / SWAY_STEP));
    const h = dt / steps;
    for (let step = 0; step < steps; step++) {
      let acceleration = -omega * omega * (this.roll - this.swayTarget) - 2 * SWAY_DAMPING * omega * this.rollVelocity;
      // 한계 근처에서는 단단한 스프링으로 밀어낸다 (딱 멈추는 대신)
      const over = Math.abs(this.roll) - SWAY_MAX * 0.9;
      if (over > 0) acceleration -= Math.sign(this.roll) * over * omega * omega * 8;
      this.rollVelocity += acceleration * h;
      this.roll += this.rollVelocity * h;
    }
    this.roll = clamp(this.roll, -SWAY_MAX, SWAY_MAX);

    const rotated = rotateCss(this.grabOffset, this.roll);
    this.feet = { x: this.held.x + rotated.x, y: this.held.y + rotated.y };

    // 오래 들고 있거나 세게 흔들면 버둥거린다
    this.heldTime += dt;
    const vy = dt > 0 ? (this.held.y - previous.y) / dt : 0;
    this.shake = damp(this.shake, Math.hypot(vx, vy), 0.3, dt);
    const wants = this.heldTime >= STRUGGLE_AFTER || this.shake >= STRUGGLE_SHAKE;
    if (this.struggling) this.struggleTime += dt;
    if (wants && !this.struggling) {
      this.struggling = true;
      this.struggleTime = 0;
      this.actor.play("hang_struggle");
    } else if (!wants && this.struggling && this.struggleTime >= STRUGGLE_MIN) {
      this.struggling = false;
      this.actor.play("hang");
    }
  }

  private updateFall(dt: number, arena: Arena): void {
    const previousY = this.feet.y;
    this.velocity.y += GRAVITY * dt;
    this.feet.x += this.velocity.x * dt;
    this.feet.y += this.velocity.y * dt;
    this.roll = damp(this.roll, 0, 0.18, dt);

    const margin = this.margin();
    if (this.feet.x < arena.left + margin || this.feet.x > arena.right - margin) {
      this.feet.x = clamp(this.feet.x, arena.left + margin, arena.right - margin);
      this.velocity.x = -this.velocity.x * WALL_BOUNCE;
    }
    // 머리가 화면 위로 나가지 않게
    const topLimit = arena.top + this.actor.heightPx * 1.15;
    if (this.feet.y < topLimit && this.velocity.y < 0) {
      this.feet.y = topLimit;
      this.velocity.y = 0;
    }
    // 위에서 아래로 지난 테두리 중 가장 먼저 지난(가장 높은) 것에 착지
    let landing: Ledge | null = null;
    if (this.velocity.y > 0) {
      for (const ledge of arena.ledges ?? []) {
        const crossed = previousY <= ledge.y + 0.5 && this.feet.y >= ledge.y;
        const over = this.feet.x >= ledge.left && this.feet.x <= ledge.right;
        if (ledge.id === this.ignoredLedge) continue;
        if (crossed && over && (!landing || ledge.y < landing.y)) landing = ledge;
      }
    }
    if (landing || this.feet.y >= arena.ground) {
      const impact = this.velocity.y;
      if (landing) {
        this.standOn(landing);
      } else {
        this.feet.y = arena.ground;
        this.ledgeId = null;
        this.ignoredLedge = null;
      }
      this.velocity = { x: 0, y: 0 };
      if (impact >= LAND_IMPACT) {
        this.enter("land");
        this.actor.play("land", () => this.toIdle());
      } else {
        this.toIdle();
      }
    }
  }

  private toIdle(): void {
    this.targetFacing = 0;
    this.enter("idle", 4 + this.random() * 6);
    this.actor.play("idle");
  }

  /** 그 자리에 앉는다 (창 위면 걸터앉기, 바닥이면 다리 뻗고). sleepy면 존다. */
  /**
   * 그 자리에 앉는다 (창 위면 걸터앉기, 바닥이면 다리 뻗고). sleepy면 존다.
   * 서 있었으면 앉는 모션(sit_down_*)을 먼저 하고, 이미 앉아 있으면 바로 반복 모션으로 바꾼다.
   */
  private sit(sleepy: boolean): void {
    // 정면 카메라라 정면으로 앉으면 무릎이 화면 쪽을 향해 다리가 짧아 보인다. 걷던 쪽으로 살짝 돌아앉는다.
    this.targetFacing = -this.walkDirection * SIT_FACING;
    const seat = this.ledgeId !== null ? "edge" : "floor";
    const loop = `${sleepy ? "sleep" : "sit"}_${seat}`;
    const alreadySeated = this.state === "sit" || this.state === "sleep";
    if (sleepy) this.enter("sleep");
    else this.enter("sit", SIT_SECONDS.min + this.random() * (SIT_SECONDS.max - SIT_SECONDS.min));
    if (alreadySeated) {
      this.actor.play(loop);
      return;
    }
    this.seatMoving = true;
    this.actor.play(`sit_down_${seat}`, () => {
      this.seatMoving = false;
      if (this.state === "sit" || this.state === "sleep") this.actor.play(loop);
    });
  }

  /** 앉은 자리에서 일어선다 (stand_up_*). 끝나면 서 있기, 클릭으로 일어났으면 그 반응을 이어서 한다. */
  private rise(reaction?: "pat" | "poke"): void {
    const seat = this.seat ?? "floor";
    this.enter("rise");
    this.riseSeat = seat;
    this.actor.play(`stand_up_${seat}`, () => {
      if (this.state !== "rise") return;
      if (reaction) {
        this.enter("react");
        this.actor.play(reaction, () => this.toIdle());
      } else {
        this.toIdle();
      }
    });
  }

  // ---------------------------------------------------------------- 창 발판

  /**
   * 창 위치를 매끄럽게 따라간다. 창 위치는 폴링 간격(8ms)과 창이 실제로 움직이는 간격(보통 화면 주사율)이
   * 렌더 프레임과 맞지 않아, 그대로 쓰면 어떤 프레임은 두 칸, 어떤 프레임은 0칸 움직여 뚝뚝 끊겨 보인다.
   * 샘플 사이 간격으로 창 속도를 어림해 그 속도로 움직이고, 남는 오차는 40ms 반감기로 메운다.
   * 일정한 속도면 거의 늦지 않는다. 크게 튀면(창 스냅·화면 전환) 바로 옮긴다.
   */
  private followWindow(raw: Point, dx: number, dy: number, dt: number): void {
    this.ledgeSampleAge += dt;
    if (dx !== 0 || dy !== 0) {
      // 가만히 있던 창의 첫 변화로는 속도를 알 수 없다 (한 번에 옮긴 것일 수도 있다). 둘째 샘플부터 어림한다.
      if (this.ledgeSampleAge <= FOLLOW_STOP_AFTER) {
        const span = Math.max(this.ledgeSampleAge, 1 / 240);
        const limit = (value: number) => clamp(value, -FOLLOW_MAX_SPEED, FOLLOW_MAX_SPEED);
        this.ledgeEstimate = {
          x: this.ledgeEstimate.x * 0.5 + limit(dx / span) * 0.5,
          y: this.ledgeEstimate.y * 0.5 + limit(dy / span) * 0.5,
        };
      }
      this.ledgeSampleAge = 0;
    } else if (this.ledgeSampleAge > FOLLOW_STOP_AFTER) {
      // 한동안 안 바뀌었으면 멈춘 것: 어림 속도를 빠르게 줄인다
      const keep = Math.pow(0.5, dt / 0.03);
      this.ledgeEstimate = { x: this.ledgeEstimate.x * keep, y: this.ledgeEstimate.y * keep };
    }
    const ahead = Math.min(this.ledgeSampleAge, FOLLOW_STOP_AFTER);
    const predicted = { x: raw.x + this.ledgeEstimate.x * ahead, y: raw.y + this.ledgeEstimate.y * ahead };
    const previous = { ...this.ledgeShown };
    if (Math.hypot(predicted.x - this.ledgeShown.x, predicted.y - this.ledgeShown.y) > this.actor.heightPx * 0.5) {
      this.ledgeShown = predicted;
    } else {
      const catchUp = 1 - Math.pow(0.5, dt / FOLLOW_CATCH_UP);
      this.ledgeShown = {
        x: this.ledgeShown.x + this.ledgeEstimate.x * dt,
        y: this.ledgeShown.y + this.ledgeEstimate.y * dt,
      };
      this.ledgeShown.x += (predicted.x - this.ledgeShown.x) * catchUp;
      this.ledgeShown.y += (predicted.y - this.ledgeShown.y) * catchUp;
    }
    this.feet.x += this.ledgeShown.x - previous.x;
    this.feet.y = this.ledgeShown.y;
  }

  private standOn(ledge: Ledge): void {
    this.ledgeId = ledge.id;
    this.ignoredLedge = null;
    this.ledgeAnchor = { x: ledge.windowX, y: ledge.y };
    this.ledgeShown = { x: ledge.windowX, y: ledge.y };
    this.ledgeEstimate = { x: 0, y: 0 };
    this.ledgeSampleAge = Number.POSITIVE_INFINITY;
    this.ledgeSpeed = 0;
    this.ledgeVelocity = { x: 0, y: 0 };
    this.feet.y = ledge.y;
  }

  /** 창이 움직이면 따라가고, 사라지거나 세게 흔들리거나 발이 끝을 벗어나면 떨어진다. */
  private followLedge(dt: number, arena: Arena): void {
    const segments = (arena.ledges ?? []).filter((ledge) => ledge.id === this.ledgeId);
    if (segments.length === 0) {
      this.drop({ x: 0, y: 0 });
      return;
    }
    const raw: Point = { x: segments[0].windowX, y: segments[0].y };
    const dx = raw.x - this.ledgeAnchor.x;
    const dy = raw.y - this.ledgeAnchor.y;
    this.ledgeAnchor = raw;
    this.followWindow(raw, dx, dy, dt);

    // 창 위치는 폴링 주기(30Hz)마다 계단식으로 바뀐다. 프레임마다의 순간 속도를 시간 가중
    // 지수 평균하면 프레임 수와 상관없이 실제 평균 속력이 된다.
    if (dt > 0) {
      const keep = Math.exp(-dt / SHAKE_WINDOW);
      const take = 1 - keep;
      this.ledgeSpeed = this.ledgeSpeed * keep + (Math.hypot(dx, dy) / dt) * take;
      this.ledgeVelocity = {
        x: this.ledgeVelocity.x * keep + (dx / dt) * take,
        y: this.ledgeVelocity.y * keep + (dy / dt) * take,
      };
    }
    if (this.ledgeSpeed > SHAKE_SPEED) {
      // 흔들리는 방향으로 튕겨 나간다 (아래로는 물려받지 않음: 창 속으로 박히지 않게)
      this.drop({
        x: this.ledgeVelocity.x * SHAKE_CARRY,
        y: Math.min(0, this.ledgeVelocity.y * SHAKE_CARRY) - SHAKE_HOP,
      });
      return;
    }

    const slack = this.actor.heightPx * 0.04;
    const standing = segments.some((ledge) => this.feet.x >= ledge.left - slack && this.feet.x <= ledge.right + slack);
    if (!standing) {
      const carry = this.state === "walk" ? this.walkDirection * this.actor.walkSpeedPx * 0.5 : 0;
      this.drop({ x: carry, y: 0 });
    }
  }

  private drop(velocity: Point): void {
    this.ignoredLedge = this.ledgeId;
    this.ledgeId = null;
    this.velocity = { ...velocity };
    this.targetFacing = 0;
    this.enter("fall");
    this.actor.play("fall");
  }

  /** 걸을 수 있는 가로 범위: 바닥이면 화면, 창 위면 발이 놓인 보이는 구간 */
  private walkBounds(arena: Arena): { left: number; right: number } {
    const margin = this.margin();
    let left = arena.left + margin;
    let right = arena.right - margin;
    if (this.ledgeId !== null) {
      const edge = this.actor.heightPx * 0.12;
      const segment = arena.ledges?.find(
        (ledge) => ledge.id === this.ledgeId && this.feet.x >= ledge.left - edge && this.feet.x <= ledge.right + edge,
      );
      if (segment) {
        left = Math.max(left, segment.left + edge);
        right = Math.min(right, segment.right - edge);
      }
    }
    return { left, right: Math.max(left, right) };
  }

  private enter(state: BehaviorState, length = 0): void {
    this.steppingOff = false;
    this.stopping = null;
    // 앉는 도중 잡히거나 떨어지면 콜백이 안 오므로 상태가 바뀔 때마다 푼다 (sit()은 enter 뒤에 다시 켠다)
    this.seatMoving = false;
    this.state = state;
    this.stateTime = 0;
    this.stateLength = length;
  }

  /** 화면 끝 여백: 몸 절반 정도 */
  private margin(): number {
    return this.actor.heightPx * 0.3;
  }
}

/** CSS 좌표(y 아래)에서 화면 반시계 방향으로 회전 */
export function rotateCss(point: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos };
}
