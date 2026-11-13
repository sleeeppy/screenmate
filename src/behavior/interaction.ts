import type { Point } from "./behavior";

/** 이만큼 움직이면 클릭이 아니라 끌기 */
const DRAG_THRESHOLD_PX = 6;
/** 이보다 오래 누르고 있다 떼면 클릭으로 치지 않는다 */
const CLICK_MAX_MS = 400;

export interface PointerHandlers {
  grab(start: Point, now: number): void;
  drag(point: Point, now: number): void;
  release(now: number): void;
  click(point: Point): void;
}

/**
 * 캐릭터 위 마우스 입력. 클릭 통과가 꺼져 있을 때(캐릭터 픽셀 위)만 창이 이벤트를 받는다.
 * 창이 화면 전체라 끄는 동안 커서가 캐릭터를 벗어나도 이벤트가 계속 들어온다.
 */
export function attachPointer(handlers: PointerHandlers): void {
  let start: (Point & { t: number }) | null = null;
  let dragging = false;

  window.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY, t: event.timeStamp };
    dragging = false;
  });

  window.addEventListener("pointermove", (event) => {
    if (!start) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!dragging && Math.hypot(point.x - start.x, point.y - start.y) >= DRAG_THRESHOLD_PX) {
      dragging = true;
      handlers.grab(start, start.t);
    }
    if (dragging) handlers.drag(point, event.timeStamp);
  });

  const finish = (event: PointerEvent) => {
    if (!start) return;
    if (dragging) {
      handlers.release(event.timeStamp);
    } else if (event.type === "pointerup" && event.timeStamp - start.t <= CLICK_MAX_MS) {
      handlers.click(start);
    }
    start = null;
    dragging = false;
  };
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);

  // WebView 기본 우클릭 메뉴(뒤로·새로고침·검사)를 막는다. 캐릭터 메뉴는 M6에서.
  window.addEventListener("contextmenu", (event) => event.preventDefault());
  // 끌 때 글자 선택·드래그 이미지가 생기지 않게
  window.addEventListener("dragstart", (event) => event.preventDefault());
  window.addEventListener("selectstart", (event) => event.preventDefault());
}
