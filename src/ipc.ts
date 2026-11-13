import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  /** 전신 썸네일 (mate:// 기준 상대 경로). 아직 없으면 null */
  thumbnail: string | null;
  /** 카드 썸네일 (머리~허벅지, 3:4) */
  portrait: string | null;
  /** 썸네일에서 뽑은 모델 색 (카드 배경) */
  look: ModelLook | null;
}

/** 모델 색. 색상(hue, 0~360)과 옷의 밝기 */
export interface ModelLook {
  /** 가장 눈에 띄는 색 */
  accent: number;
  /** 두 번째 색 (없으면 accent 근처) */
  second: number;
  /** 옷이 어두운지 밝은지 */
  tone: "dark" | "light" | "mid";
}

export type ThumbnailKind = "full" | "card" | "look";

export interface Settings {
  modelId: string | null;
  heightPx: number;
  /** 두리번·기지개·걸터앉기 같은 동작을 섞는다 */
  variety: boolean;
  /** 창 위쪽 테두리에 올라서고 앉는다 */
  ledges: boolean;
  /** 입력이 없으면 이 시간(분) 뒤에 존다. 0이면 졸지 않는다 */
  sleepMinutes: number;
  /** 가까이 온 커서를 눈과 고개로 따라본다 */
  gaze: boolean;
}

/** 캐릭터 지금 상태 (메인 창 → 설정 창 아래 막대) */
export interface MateStatus {
  modelId: string | null;
  /** 재생 중인 모션 이름 */
  motion: string;
  /** 미리보기 중이면 그 모션, 자율 행동이면 "auto" */
  preview: string;
  /** 행동 상태 (idle, walk, sit …) */
  state: string;
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
  backdrop: boolean;
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

export const updateSettings = (patch: Partial<Omit<Settings, "modelId">>): Promise<Settings> =>
  invoke("update_settings", { patch });

export const selectModel = (id: string): Promise<Settings> => invoke("select_model", { id });

export const saveThumbnail = (id: string, kind: ThumbnailKind, bytes: ArrayBuffer): Promise<void> =>
  invoke("save_thumbnail", new Uint8Array(bytes), {
    headers: { "x-model-id": encodeURIComponent(id), "x-thumb-kind": kind },
  });

export const openSettingsWindow = (): Promise<void> => invoke("open_settings_window");
export const importModels = (): Promise<void> => invoke("import_models");
export const openModelsFolder = (): Promise<void> => invoke("open_models_folder");
export const openDataFolder = (): Promise<void> => invoke("open_data_folder");
export const reloadCharacter = (): Promise<void> => invoke("reload_character");
export const quitApp = (): Promise<void> => invoke("quit_app");

/** 설정 창 → 메인 창: 모션 미리보기 ("auto"면 자율 행동) */
export const requestMotionPreview = (name: string): Promise<void> => emit("motion-preview", name);
/** 설정 창 → 메인 창: 지금 상태를 알려 달라 */
export const requestStatus = (): Promise<void> => emit("status-request");
export const broadcastStatus = (status: MateStatus): Promise<void> => emit("mate-status", status);
export const onStatus = (handler: (status: MateStatus) => void): Promise<UnlistenFn> =>
  listen<MateStatus>("mate-status", (event) => handler(event.payload));
export const onStatusRequest = (handler: () => void): Promise<UnlistenFn> => listen("status-request", () => handler());


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
