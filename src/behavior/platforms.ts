/**
 * 창 발판: 창 사각형 목록(앞 → 뒤)에서 실제로 보이는 위쪽 테두리 구간을 계산한다. 순수 TS.
 *
 * 창 A의 위쪽 테두리 y에서, A보다 앞에 있는 창 중 그 높이를 덮는 창의 가로 구간을 뺀다.
 * 남은 구간이 캐릭터가 설 수 있는 발판(Ledge)이다.
 */

/** 창 사각형 (CSS px, 오버레이 기준). Rust `platforms.rs`가 보낸다. */
export interface WindowRect {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 창 위쪽 테두리 중 보이는 한 구간 */
export interface Ledge {
  /** 창 id. 창 하나가 가려져 여러 구간으로 나뉘면 같은 id가 여러 개다. */
  id: number;
  y: number;
  left: number;
  right: number;
  /** 창 왼쪽 x. 창이 움직이면 캐릭터를 같은 만큼 옮긴다. */
  windowX: number;
}

export interface LedgeLimits {
  /** 화면(작업 영역) 위 y. 이보다 키만큼 아래여야 머리가 화면 안에 들어온다. */
  top: number;
  /** 바닥 y. 이 근처나 아래의 테두리는 의미 없다. */
  ground: number;
  left: number;
  right: number;
  /** 머리 위 여유 (캐릭터 키 정도) */
  headroom: number;
  /** 이보다 좁은 구간은 버린다 */
  minWidth: number;
}

/** 앞 창이 테두리 바로 위에서 시작해도 가린 것으로 본다 (창 그림자·제목 표시줄 겹침) */
const COVER_TOLERANCE = 2;

export function computeLedges(windows: readonly WindowRect[], limits: LedgeLimits): Ledge[] {
  const ledges: Ledge[] = [];
  windows.forEach((window, index) => {
    const y = window.y;
    if (y - limits.headroom < limits.top || y > limits.ground - limits.headroom * 0.25) return;

    let segments: [number, number][] = [
      [Math.max(window.x, limits.left), Math.min(window.x + window.width, limits.right)],
    ];
    for (let front = 0; front < index && segments.length > 0; front++) {
      const cover = windows[front];
      if (cover.y - COVER_TOLERANCE > y || cover.y + cover.height <= y) continue;
      segments = subtract(segments, cover.x, cover.x + cover.width);
    }
    for (const [left, right] of segments) {
      if (right - left >= limits.minWidth) ledges.push({ id: window.id, y, left, right, windowX: window.x });
    }
  });
  return ledges;
}

function subtract(segments: [number, number][], from: number, to: number): [number, number][] {
  const result: [number, number][] = [];
  for (const [left, right] of segments) {
    if (to <= left || from >= right) {
      result.push([left, right]);
      continue;
    }
    if (from > left) result.push([left, from]);
    if (to < right) result.push([to, right]);
  }
  return result;
}
