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

export type BehaviorState = "idle" | "walk" | "held" | "fall" | "land" | "react";
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
/** 끄는 속도 1000px/s당 기울기 */
const SWAY_PER_SPEED = (20 * Math.PI) / 180 / 1000;
/** 창 흔들림 판정: 최근 이 시간(s) 동안 창이 움직인 평균 속력으로 본다 */
const SHAKE_WINDOW = 0.25;
/** 이 속력(px/s) 이상으로 창이 움직이면 떨어진다. 보통 창 끌기는 1000 안팎. */
const SHAKE_SPEED = 2500;
/** 흔들려 떨어질 때 창 속도를 이만큼 물려받는다 */
const SHAKE_CARRY = 0.5;
/** 흔들려 떨어질 때 위로 튕기는 속도 (px/s) */
const SHAKE_HOP = 420;
/** 창 끝에 닿았을 때 발을 헛디뎌 떨어질 확률 (나머지는 돌아서기·멈추기) */
const STEP_OFF_CHANCE = 0.2;
/** 놓은 발이 테두리에서 이 범위(위 / 아래 px) 안이면 그 창 위에 바로 선다 */
const LEDGE_SNAP = { above: 12, below: 6 };

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
  /** 떨어져 나온 창: 바닥이나 다른 창에 닿을 때까지 그 창에는 착지하지 않는다 */
  private ignoredLedge: number | null = null;
  /** 창 끝에서 발을 헛디뎌 걸어 나가는 중 */
  private steppingOff = false;

  // Node 타입 제거 모드는 생성자 매개변수 속성을 지원하지 않아 필드를 따로 둔다.
  private readonly actor: Actor;
  private readonly random: () => number;

  constructor(actor: Actor, random: () => number = Math.random) {
    this.actor = actor;
    this.random = random;
  }

  /** 박스를 넉넉하게(회전·매달림 포함) 잡아야 하는 상태인지 */
  get airborne(): boolean {
    return this.state === "held" || this.state === "fall";
  }

  /** 창 위에 서 있는지 (Rust 창 폴링을 빠르게 할지) */
  get onLedge(): boolean {
    return this.ledgeId !== null;
  }

  activity(): BehaviorActivity {
    if (this.state === "held" || this.state === "fall" || this.state === "land" || this.state === "react") return "interact";
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
    this.enter("idle");
    this.targetFacing = motion === "walk" ? -WALK_FACING : 0;
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
      case "land":
      case "react":
        break;
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
    this.targetFacing = 0;
    this.ledgeId = null;
    this.ignoredLedge = null;
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
    if (this.airborne || this.state === "land") return;
    // 頭 높이 = heightPx. 그보다 살짝 아래부터 머리로 본다.
    const head = pointer.y < this.feet.y - this.actor.heightPx * 0.9;
    this.targetFacing = 0;
    this.enter("react");
    this.actor.play(head ? "pat" : "poke", () => this.toIdle());
  }

  // ---------------------------------------------------------------- 상태별

  private updateIdle(): void {
    if (this.paused || this.stateTime < this.stateLength) return;
    this.walkDirection = this.random() < 0.5 ? 1 : -1;
    this.enter("walk", 2 + this.random() * 4);
    this.actor.play("walk");
  }

  private updateWalk(dt: number, arena: Arena): void {
    this.targetFacing = -this.walkDirection * WALK_FACING;
    // 몸이 거의 돌아선 뒤에 출발 (돌면서 미끄러지지 않게)
    const turned = Math.abs(this.facing - this.targetFacing) < 0.25;
    if (turned) {
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
        this.toIdle();
        return;
      }
    }
    if (!this.paused && this.stateTime >= this.stateLength) this.toIdle();
  }

  private updateHeld(dt: number): void {
    // 커서를 바로 따라가되 한 프레임 튀는 값은 조금 눌러 준다 (물리 폭주 방지)
    const previous = { ...this.held };
    this.held.x = damp(this.held.x, this.pointer.x, 0.025, dt);
    this.held.y = damp(this.held.y, this.pointer.y, 0.025, dt);
    const vx = dt > 0 ? (this.held.x - previous.x) / dt : 0;

    // 진자: 끄는 방향 반대로 발이 처진다. 회전 중심은 잡은 점.
    const omega = 2 * Math.PI * SWAY_HZ;
    const target = clamp(-vx * SWAY_PER_SPEED, -SWAY_MAX, SWAY_MAX);
    const acceleration = -omega * omega * (this.roll - target) - 2 * SWAY_DAMPING * omega * this.rollVelocity;
    this.rollVelocity += acceleration * dt;
    this.roll = clamp(this.roll + this.rollVelocity * dt, -SWAY_MAX, SWAY_MAX);

    const rotated = rotateCss(this.grabOffset, this.roll);
    this.feet = { x: this.held.x + rotated.x, y: this.held.y + rotated.y };
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

  // ---------------------------------------------------------------- 창 발판

  private standOn(ledge: Ledge): void {
    this.ledgeId = ledge.id;
    this.ignoredLedge = null;
    this.ledgeAnchor = { x: ledge.windowX, y: ledge.y };
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
    const dx = segments[0].windowX - this.ledgeAnchor.x;
    const dy = segments[0].y - this.ledgeAnchor.y;
    this.ledgeAnchor = { x: segments[0].windowX, y: segments[0].y };
    this.feet.x += dx;
    this.feet.y = segments[0].y;

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
