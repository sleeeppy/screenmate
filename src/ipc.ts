import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { WindowRect } from "./behavior/platforms.ts";

/** 웹뷰 좌표(CSS px, 창 왼쪽 위 기준) 사각형 */
export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CursorEvent {
  x: number;
  y: number;
  /** 커서가 캐릭터 관심 영역 안에 있는지 */
  near: boolean;
}

export interface StageInfo {
  width: number;
  height: number;
  scale: number;
  workArea: CssRect;
}

export interface ModelListing {
  id: string;
  name: string;
  group: string;
  /** models/ 기준 상대 경로 ('/' 구분) */
  file: string;
  format: "pmx" | "pmd";
  hasCache: boolean;
  profile: unknown;
}

export interface Settings {
  modelId: string | null;
  heightPx: number;
}

export const onCursor = (handler: (cursor: CursorEvent) => void): Promise<UnlistenFn> =>
  listen<CursorEvent>("cursor", (event) => handler(event.payload));

export const onSettingsChanged = (handler: (settings: Settings) => void): Promise<UnlistenFn> =>
  listen<Settings>("settings-changed", (event) => handler(event.payload));

export const onModelsChanged = (handler: () => void): Promise<UnlistenFn> =>
  listen("models-changed", () => handler());

export const onReload = (handler: () => void): Promise<UnlistenFn> => listen("reload", () => handler());

export const stageInfo = (): Promise<StageInfo> => invoke("stage_info");

/** 보이는 최상위 창 목록 (앞 → 뒤). 바뀔 때만 온다. */
export const onWindows = (handler: (windows: WindowRect[]) => void): Promise<UnlistenFn> =>
  listen<WindowRect[]>("windows", (event) => handler(event.payload));

/** 창 목록 폴링 속도: 캐릭터가 창 위에 있으면 빠르게 (창을 따라가야 해서) */
export const setPlatformRate = (fast: boolean): Promise<void> => invoke("set_platform_rate", { fast });

export const launchOptions = (): Promise<{
  motion: string | null;
  benchIdle: boolean;
  dropOnWindow: boolean;
  demoHang: boolean;
}> =>
  invoke("launch_options");

/** 트레이 "모션 미리보기" 메뉴를 채운다. */
export const registerMotions = (items: { name: string; label: string }[], current: string | null): Promise<void> =>
  invoke("register_motions", { items, current });

export const onMotionPreview = (handler: (name: string) => void): Promise<UnlistenFn> =>
  listen<string>("motion-preview", (event) => handler(event.payload));

/** 진단 로그를 Rust 표준 출력으로 보낸다 (개발 중 성능 측정용) */
export function diag(message: string): void {
  void invoke("diag", { message }).catch(() => {});
}

export const setInterestRect = (rect: CssRect | null): Promise<void> =>
  invoke("set_interest_rect", { rect });

export const listModels = (): Promise<ModelListing[]> => invoke("list_models");

export const getSettings = (): Promise<Settings> => invoke("get_settings");

export const saveProfile = (id: string, profile: unknown): Promise<void> =>
  invoke("save_profile", { id, profile });

export const clearModelCache = (id: string): Promise<void> => invoke("clear_model_cache", { id });

export const saveModelCache = (id: string, bytes: ArrayBuffer): Promise<void> =>
  invoke("save_model_cache", new Uint8Array(bytes), {
    headers: { "x-model-id": encodeURIComponent(id) },
  });

/**
 * mate:// 프로토콜 URL. 경로 구분자를 살려야 텍스처 상대 경로가 풀린다.
 * 기본 주소는 플랫폼마다 다르다: Windows `http://mate.localhost/`, macOS·Linux `mate://localhost/`.
 */
export function mateUrl(relativePath: string): string {
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/");
  return `${convertFileSrc("", "mate")}${encoded}`;
}
