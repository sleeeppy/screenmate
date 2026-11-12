import assert from "node:assert/strict";
import { test } from "node:test";
import { Behavior, rotateCss, type Actor, type Arena } from "./behavior.ts";

const arena: Arena = { ground: 1000, left: 0, right: 2000, top: 0 };

function makeActor() {
  const played: string[] = [];
  let finish: (() => void) | undefined;
  const actor: Actor = {
    heightPx: 260,
    walkSpeedPx: 100,
    play(motion, onFinished) {
      played.push(motion);
      finish = onFinished;
    },
  };
  return { actor, played, finishMotion: () => finish?.() };
}

/** 고정 난수: 순서대로 돌려준다 */
const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length];
};

function run(behavior: Behavior, seconds: number, step = 1 / 60): void {
  for (let t = 0; t < seconds; t += step) behavior.update(step, arena);
}

test("CSS 회전: 아래쪽 점을 반시계로 돌리면 오른쪽으로 간다", () => {
  const rotated = rotateCss({ x: 0, y: 100 }, Math.PI / 2);
  assert.ok(Math.abs(rotated.x - 100) < 1e-9 && Math.abs(rotated.y) < 1e-9);
});

test("잡아서 오른쪽으로 던지면 포물선으로 날아가 오른쪽에 착지한다", () => {
  const { actor, played } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 800 }, 0);
  for (let i = 1; i <= 6; i++) {
    behavior.drag({ x: 500 + i * 20, y: 800 - i * 10 }, i * 16);
    behavior.update(1 / 60, arena);
  }
  behavior.release(6 * 16 + 5, arena);
  assert.equal(behavior.state, "fall");
  let peak = behavior.feet.y;
  for (let i = 0; i < 600 && behavior.state === "fall"; i++) {
    behavior.update(1 / 60, arena);
    peak = Math.min(peak, behavior.feet.y);
  }
  assert.notEqual(behavior.state, "fall");
  assert.equal(behavior.feet.y, arena.ground);
  assert.ok(behavior.feet.x > 650, `x=${behavior.feet.x}`);
  // 위로 625px/s → 약 75px 솟는다 (잡은 순간 발 높이 940 기준)
  assert.ok(peak < 940 - 40, `위로 솟았다가 떨어진다 (peak=${peak})`);
  assert.deepEqual(played.slice(0, 2), ["hang", "fall"]);
});

test("세게 떨어지면 착지 모션, 끝나면 서 있기", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 800 }, 0);
  behavior.drag({ x: 500, y: 100 }, 16); // 들어 올림 → 발이 y=300
  run(behavior, 0.3);
  behavior.release(1000, arena); // 멈춘 채 놓음 → 자유 낙하
  run(behavior, 2);
  assert.equal(behavior.state, "land");
  finishMotion();
  assert.equal(behavior.state, "idle");
  assert.equal(played.at(-1), "idle");
});

test("바닥 근처에서 살짝 놓으면 바로 서 있기", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 900 }, 0);
  behavior.update(1 / 60, arena);
  behavior.release(500, arena);
  assert.equal(behavior.state, "idle");
});

test("오른쪽으로 끌면 발이 왼쪽으로 처진다 (진자)", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor);
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 700 }, 0);
  for (let i = 1; i <= 20; i++) {
    behavior.drag({ x: 500 + i * 25, y: 700 }, i * 16);
    behavior.update(1 / 60, arena);
  }
  assert.ok(behavior.roll < -0.05, `roll=${behavior.roll}`);
  assert.ok(behavior.feet.x < 500 + 20 * 25, "발이 잡은 점보다 왼쪽");
});

test("서 있다가 걷기 시작하고, 화면 끝에서 돌아선다", () => {
  const { actor, played } = makeActor();
  // 첫 대기 길이(최소 3초), 방향(<0.5 오른쪽), 걷기 길이(최대), 끝에서 돌아서기(<0.6)
  const behavior = new Behavior(actor, sequence(0, 0.1, 1, 0.1));
  behavior.place(1900, arena);
  run(behavior, 3.2);
  assert.equal(behavior.state, "walk");
  assert.ok(played.includes("walk"));
  assert.ok(behavior.facing < -0.5, "오른쪽을 보고 걷는다");
  run(behavior, 2);
  assert.ok(behavior.facing > 0.5, `돌아서서 왼쪽을 본다 (facing=${behavior.facing})`);
  assert.ok(behavior.feet.x <= 2000 - 260 * 0.3);
});

test("클릭: 머리는 쓰다듬기, 몸은 찌르기", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.click({ x: 500, y: 1000 - 260 - 10 });
  assert.equal(played.at(-1), "pat");
  finishMotion();
  behavior.click({ x: 500, y: 1000 - 120 });
  assert.equal(played.at(-1), "poke");
  assert.equal(behavior.state, "react");
});
