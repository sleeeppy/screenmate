import assert from "node:assert/strict";
import { test } from "node:test";
import { Behavior, rotateCss, type Actor, type Arena } from "./behavior.ts";
import type { Ledge } from "./platforms.ts";

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

// ---------------------------------------------------------------- 창 발판 (M5)

const ledge = (id: number, y: number, left: number, right: number, windowX = left): Ledge => ({
  id,
  y,
  left,
  right,
  windowX,
});

test("떨어지다 창 위쪽 테두리를 지나면 그 창 위에 선다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  const withLedge: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, withLedge);
  behavior.grab({ x: 500, y: 800 }, 0); // 발은 잡은 점 아래 200
  behavior.drag({ x: 500, y: 100 }, 16); // 발이 y=300 (테두리 위)
  for (let i = 0; i < 30; i++) behavior.update(1 / 60, withLedge);
  behavior.release(1000, withLedge);
  for (let i = 0; i < 120; i++) behavior.update(1 / 60, withLedge);
  assert.ok(behavior.onLedge);
  assert.equal(behavior.feet.y, 600);
  assert.notEqual(behavior.state, "fall");
});

test("창 테두리 아래에서 놓으면 창을 통과해 바닥까지 떨어진다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  const withLedge: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, withLedge);
  behavior.grab({ x: 500, y: 700 }, 0); // 발 y=1000 → 잡은 점 아래로 300
  behavior.drag({ x: 500, y: 450 }, 16); // 발이 y=750 (테두리 아래)
  for (let i = 0; i < 30; i++) behavior.update(1 / 60, withLedge);
  behavior.release(1000, withLedge);
  for (let i = 0; i < 120; i++) behavior.update(1 / 60, withLedge);
  assert.ok(!behavior.onLedge);
  assert.equal(behavior.feet.y, arena.ground);
});

test("창 테두리 근처에서 놓으면 바로 그 창 위에 선다", () => {
  const { actor } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  const withLedge: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, withLedge);
  behavior.grab({ x: 500, y: 900 }, 0);
  behavior.drag({ x: 500, y: 495 }, 16); // 발 y≈595
  for (let i = 0; i < 60; i++) behavior.update(1 / 60, withLedge);
  behavior.release(2000, withLedge);
  assert.equal(behavior.state, "idle");
  assert.ok(behavior.onLedge);
  assert.equal(behavior.feet.y, 600);
});

/** 창 위(y=600, x 300~900)에 세운다 */
function standOnWindow(random = sequence(0.9)) {
  const made = makeActor();
  const behavior = new Behavior(made.actor, random);
  const start: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, start);
  behavior.grab({ x: 500, y: 900 }, 0);
  behavior.drag({ x: 500, y: 500 }, 16);
  for (let i = 0; i < 60; i++) behavior.update(1 / 60, start);
  behavior.release(2000, start);
  assert.ok(behavior.onLedge);
  return { ...made, behavior };
}

test("창이 움직이면 같이 움직인다", () => {
  const { behavior } = standOnWindow();
  const x = behavior.feet.x;
  const moved: Arena = { ...arena, ledges: [ledge(7, 550, 340, 940)] };
  run2(behavior, 0.4, moved); // 매끄럽게 따라가므로 잠깐 뒤에 맞춘다
  assert.ok(behavior.onLedge);
  assert.ok(Math.abs(behavior.feet.x - (x + 40)) < 0.5, `x=${behavior.feet.x}`);
  assert.ok(Math.abs(behavior.feet.y - 550) < 0.5, `y=${behavior.feet.y}`);
});

test("창이 사라지면 떨어져서 바닥에 선다", () => {
  const { behavior, played } = standOnWindow();
  behavior.update(1 / 60, { ...arena, ledges: [] });
  assert.equal(behavior.state, "fall");
  assert.equal(played.at(-1), "fall");
  run(behavior, 2);
  assert.ok(!behavior.onLedge);
  assert.equal(behavior.feet.y, arena.ground);
});

test("창이 앞 창에 가려 발밑 구간이 없어지면 떨어진다", () => {
  const { behavior } = standOnWindow();
  // 같은 창이지만 보이는 구간이 발에서 먼 오른쪽만 남음
  behavior.update(1 / 60, { ...arena, ledges: [ledge(7, 600, 750, 900, 300)] });
  assert.equal(behavior.state, "fall");
});

test("창을 세게 흔들면 떨어진다", () => {
  const { behavior } = standOnWindow();
  let x = 300;
  for (let i = 0; i < 20 && behavior.state !== "fall"; i++) {
    x += i % 2 === 0 ? 160 : -160; // 30Hz로 160px씩 좌우 = 4800px/s
    const shaken: Arena = { ...arena, ledges: [ledge(7, 600, x, x + 600)] };
    behavior.update(1 / 30, shaken);
  }
  assert.equal(behavior.state, "fall");
  // 떨어져 나온 창에는 다시 앉지 않고 바닥까지
  const still: Arena = { ...arena, ledges: [ledge(7, 600, x, x + 600)] };
  run2(behavior, 2, still);
  assert.ok(!behavior.onLedge);
  assert.equal(behavior.feet.y, arena.ground);
});

test("창 위를 걷다가 끝에서 돌아선다 (창 밖으로 걸어 나가지 않음)", () => {
  // 놓았을 때 대기 4초(0), 방향 오른쪽(0.1), 걷기 길이 최대(1), 끝에서 돌아서기(0.3: 헛디딤 0.2 이상, 0.6 미만)
  const { behavior } = standOnWindow(sequence(0.9, 0, 0.1, 1, 0.3));
  const onWindow: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  run2(behavior, 12, onWindow);
  assert.ok(behavior.onLedge, `state=${behavior.state}`);
  assert.ok(behavior.feet.x <= 900 - 260 * 0.12 + 1e-6, `x=${behavior.feet.x}`);
});

test("창 끝에서 헛디디면 떨어진다", () => {
  // 놓았을 때 대기 4초(0), 방향 오른쪽(0.1), 걷기 길이 최대(1), 헛디딤(0.05)
  const { behavior, played } = standOnWindow(sequence(0.9, 0, 0.1, 1, 0.05));
  const onWindow: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  run2(behavior, 12, onWindow);
  assert.ok(played.includes("fall"));
  assert.ok(!behavior.onLedge);
  assert.equal(behavior.feet.y, arena.ground);
  assert.ok(behavior.feet.x > 900);
});

function run2(behavior: Behavior, seconds: number, where: Arena, step = 1 / 60): void {
  for (let t = 0; t < seconds; t += step) behavior.update(step, where);
}

test("걷다 멈출 때는 두 발이 엇갈리는 순간까지 마저 걷는다 (최대 0.6초)", () => {
  const { actor, played } = makeActor();
  let passing = false;
  actor.canStopWalking = () => passing;
  // 대기 3초(0), 방향 오른쪽(0.1), 걷기 길이 최소 2초(0)
  const behavior = new Behavior(actor, sequence(0, 0.1, 0, 0.9));
  behavior.place(500, arena);
  run(behavior, 3.1);
  assert.equal(behavior.state, "walk");
  run(behavior, 2.1); // 걷기 시간은 끝났지만 아직 발이 엇갈리지 않음
  assert.equal(behavior.state, "walk");
  const x = behavior.feet.x;
  run(behavior, 0.1);
  assert.ok(behavior.feet.x > x, "기다리는 동안에도 걷는다");
  passing = true;
  behavior.update(1 / 60, arena);
  assert.equal(behavior.state, "idle");
  assert.equal(played.at(-1), "idle");

  // 엇갈리는 순간이 안 오면 0.6초 뒤에 그냥 멈춘다
  passing = false;
  const again = new Behavior(actor, sequence(0, 0.1, 0, 0.9));
  again.place(500, arena);
  run(again, 3.1 + 2.1);
  assert.equal(again.state, "walk");
  run(again, 0.65);
  assert.equal(again.state, "idle");
});

// ---------------------------------------------------------------- M6: 버둥거리기·두리번·앉기·졸기

test("오래 들고 있으면 버둥거리고, 놓으면 떨어진다", () => {
  const { actor, played } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 700 }, 0);
  behavior.drag({ x: 500, y: 500 }, 16);
  run(behavior, 2.5);
  assert.equal(played.at(-1), "hang");
  run(behavior, 1);
  assert.equal(played.at(-1), "hang_struggle");
  behavior.release(10_000, arena);
  assert.equal(played.at(-1), "fall");
});

test("세게 흔들면 바로 버둥거린다", () => {
  const { actor, played } = makeActor();
  const behavior = new Behavior(actor, sequence(0.9));
  behavior.place(500, arena);
  behavior.grab({ x: 500, y: 700 }, 0);
  // 3Hz로 ±300px 흔들기 (손 속력 평균 약 3600px/s), 1초
  for (let i = 1; i <= 60; i++) {
    const t = i / 60;
    behavior.drag({ x: 500 + 300 * Math.sin(2 * Math.PI * 3 * t), y: 600 }, t * 1000);
    behavior.update(1 / 60, arena);
  }
  assert.ok(played.includes("hang_struggle"));
  // 천천히 끄는 건 버둥거리지 않는다 (0.5Hz ±150px, 2초)
  const slow = makeActor();
  const calm = new Behavior(slow.actor, sequence(0.9));
  calm.place(500, arena);
  calm.grab({ x: 500, y: 700 }, 0);
  for (let i = 1; i <= 120; i++) {
    const t = i / 60;
    calm.drag({ x: 500 + 150 * Math.sin(2 * Math.PI * 0.5 * t), y: 600 }, t * 1000);
    calm.update(1 / 60, arena);
  }
  assert.ok(!slow.played.includes("hang_struggle"));
});

test("variety: 서 있기가 끝나면 가끔 두리번거리거나 기지개를 켜고 다시 선다", () => {
  const { actor, played, finishMotion } = makeActor();
  // 첫 대기(0 → 3초), 고르기 0.95(기지개), 다음 대기 0, 고르기 0.82(두리번)
  const behavior = new Behavior(actor, sequence(0, 0.95, 0, 0.82), { variety: true });
  behavior.place(500, arena);
  run(behavior, 3.1);
  assert.equal(behavior.state, "act");
  assert.equal(played.at(-1), "idle_stretch");
  finishMotion();
  assert.equal(behavior.state, "idle");
  run(behavior, 4.1);
  assert.equal(played.at(-1), "idle_look");
});

test("variety: 창 위에서 쉬다가 걸터앉고, 앉은 채 창을 따라가다 시간이 지나면 선다", () => {
  const made = makeActor();
  // 놓을 때 대기(0 → 4초), 고르기 0.1(걸터앉기), 앉는 시간 0(8초)
  const behavior = new Behavior(made.actor, sequence(0.9, 0, 0.1, 0), { variety: true });
  const onWindow: Arena = { ...arena, ledges: [ledge(7, 600, 300, 900)] };
  behavior.place(500, onWindow);
  behavior.grab({ x: 500, y: 900 }, 0);
  behavior.drag({ x: 500, y: 500 }, 16);
  run2(behavior, 1, onWindow);
  behavior.release(2000, onWindow);
  run2(behavior, 4.1, onWindow);
  assert.equal(behavior.state, "sit");
  assert.equal(behavior.seat, "edge");
  // 먼저 앉는 모션, 끝나면 걸터앉기 반복
  assert.equal(made.played.at(-1), "sit_down_edge");
  assert.equal(behavior.activity(), "interact");
  made.finishMotion();
  assert.equal(made.played.at(-1), "sit_edge");
  assert.ok(behavior.headHeight < 260 * 0.5, "앉으면 머리가 낮다");
  const x = behavior.feet.x;
  run2(behavior, 0.4, { ...arena, ledges: [ledge(7, 600, 350, 950)] });
  assert.ok(Math.abs(behavior.feet.x - (x + 50)) < 0.5, "앉은 채 창을 따라간다");
  run2(behavior, 8.2, { ...arena, ledges: [ledge(7, 600, 350, 950)] });
  // 시간이 지나면 일어서는 모션, 끝나면 서 있기
  assert.equal(behavior.state, "rise");
  assert.equal(behavior.seat, "edge");
  assert.equal(made.played.at(-1), "stand_up_edge");
  made.finishMotion();
  assert.equal(behavior.state, "idle");
});

test("오래 입력이 없으면 앉아서 졸고, 입력이 오면 일어선다", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.99), { sleepAfter: 5 });
  behavior.place(500, arena);
  run(behavior, 5.2);
  assert.equal(behavior.state, "sleep");
  assert.equal(behavior.seat, "floor");
  assert.equal(played.at(-1), "sit_down_floor");
  finishMotion();
  assert.equal(played.at(-1), "sleep_floor");
  behavior.noteActivity();
  assert.equal(behavior.state, "rise");
  assert.equal(played.at(-1), "stand_up_floor");
  finishMotion();
  assert.equal(behavior.state, "idle");
  assert.equal(played.at(-1), "idle");
});

test("앉는 도중에 잡으면 매달리고, 놓아도 앉기 반복으로 넘어가지 않는다", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.99), { sleepAfter: 1 });
  behavior.place(500, arena);
  run(behavior, 1.2);
  assert.equal(played.at(-1), "sit_down_floor");
  behavior.grab({ x: 500, y: 900 }, 0);
  finishMotion(); // (드라이버는 새 모션을 재생하면 이전 콜백을 버리지만, 와도 무시해야 한다)
  assert.equal(behavior.state, "held");
  assert.equal(played.at(-1), "hang");
  assert.equal(behavior.activity(), "interact");
});

test("앉아 있을 때는 낮아진 머리를 쓰다듬는다", () => {
  const { actor, played, finishMotion } = makeActor();
  const behavior = new Behavior(actor, sequence(0.99), { sleepAfter: 1 });
  behavior.place(500, arena);
  run(behavior, 1.2);
  assert.equal(behavior.state, "sleep");
  // 앉은 머리 높이(키 0.42배) 근처 → 쓰다듬기, 서 있을 때 기준(0.9배)이면 머리 위 허공이다.
  // 앉아 있으면 먼저 일어서고, 다 일어서면 쓰다듬기 반응
  behavior.click({ x: 500, y: 1000 - 260 * 0.4 });
  assert.equal(played.at(-1), "stand_up_floor");
  finishMotion();
  assert.equal(played.at(-1), "pat");
});

test("창이 일정하게 움직이면 매 프레임 고르게 따라간다 (창 위치가 두 프레임에 한 번 바뀌어도)", () => {
  const { behavior } = standOnWindow();
  const start = behavior.feet.x;
  let windowX = 300;
  const steps: number[] = [];
  let last = behavior.feet.x;
  for (let frame = 0; frame < 120; frame++) {
    if (frame % 2 === 0) windowX += 250 / 30; // 250px/s, 30Hz로만 바뀜
    behavior.update(1 / 60, { ...arena, ledges: [ledge(7, 600, windowX, windowX + 600)] });
    if (frame >= 30) steps.push(behavior.feet.x - last);
    last = behavior.feet.x;
  }
  const mean = steps.reduce((sum, step) => sum + step, 0) / steps.length;
  const spread = Math.sqrt(steps.reduce((sum, step) => sum + (step - mean) ** 2, 0) / steps.length);
  close2(mean, 250 / 60, 0.3);
  assert.ok(spread < mean * 0.15, `프레임마다 이동량 ${mean.toFixed(2)} ± ${spread.toFixed(2)}`);
  // 창보다 크게 뒤처지지 않는다
  assert.ok(Math.abs(behavior.feet.x - start - (windowX - 300)) < 10, "뒤처짐 10px 이내");
});

function close2(actual: number, expected: number, epsilon: number): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
}
