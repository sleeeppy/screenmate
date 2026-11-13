import assert from "node:assert/strict";
import { test } from "node:test";
import { computeLedges, type LedgeLimits, type WindowRect } from "./platforms.ts";

const limits: LedgeLimits = { top: 0, ground: 1000, left: 0, right: 2000, headroom: 260, minWidth: 100 };
const win = (id: number, x: number, y: number, width: number, height: number): WindowRect => ({ id, x, y, width, height });

test("가리는 창이 없으면 위쪽 테두리 전체가 발판", () => {
  assert.deepEqual(computeLedges([win(1, 100, 400, 600, 300)], limits), [
    { id: 1, y: 400, left: 100, right: 700, windowX: 100 },
  ]);
});

test("앞 창이 테두리 가운데를 덮으면 양쪽 두 구간으로 나뉜다", () => {
  const ledges = computeLedges([win(2, 300, 350, 200, 300), win(1, 100, 400, 600, 300)], limits);
  const back = ledges.filter((ledge) => ledge.id === 1).map((ledge) => [ledge.left, ledge.right]);
  assert.deepEqual(back, [
    [100, 300],
    [500, 700],
  ]);
});

test("앞 창이 테두리보다 아래에서 시작하면 가리지 않는다", () => {
  const ledges = computeLedges([win(2, 300, 450, 200, 300), win(1, 100, 400, 600, 300)], limits);
  assert.deepEqual(
    ledges.filter((ledge) => ledge.id === 1).map((ledge) => [ledge.left, ledge.right]),
    [[100, 700]],
  );
});

test("뒤 창은 앞 창을 가리지 않는다", () => {
  const ledges = computeLedges([win(1, 100, 400, 600, 300), win(2, 300, 350, 200, 300)], limits);
  assert.deepEqual(
    ledges.filter((ledge) => ledge.id === 1).map((ledge) => [ledge.left, ledge.right]),
    [[100, 700]],
  );
});

test("머리 위 공간이 없는 창(최대화 등)과 좁은 구간은 버린다", () => {
  const ledges = computeLedges(
    [win(1, 0, 0, 2000, 1000), win(2, 100, 500, 60, 200), win(3, 100, 950, 400, 50)],
    limits,
  );
  assert.deepEqual(ledges, []);
});

test("화면 밖으로 나간 부분은 잘라낸다", () => {
  const [ledge] = computeLedges([win(1, -200, 400, 600, 300)], limits);
  assert.deepEqual([ledge.left, ledge.right, ledge.windowX], [0, 400, -200]);
});
