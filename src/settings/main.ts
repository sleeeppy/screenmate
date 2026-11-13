/**
 * 설정 창 (트레이 메뉴 대신 쓰는 GUI).
 *
 * 왼쪽: 캐릭터 폴더(카가미네 린, 카가미네 렌 …) → 폴더를 열면 그 안의 모델 카드.
 * 오른쪽: 고른 모델 미리보기, "이 모델 쓰기", 캐릭터 설정(크기·커서 바라보기·다양한 동작·창 위에 올라가기·졸기).
 * 설정은 Rust(settings.json)가 갖고 있고, 바뀌면 "settings-changed"로 모든 창에 퍼진다.
 */
import { getVersion } from "@tauri-apps/api/app";
import appIcon from "../../src-tauri/icons/128x128.png";
import {
  diag,
  getSettings,
  importModels,
  listModels,
  mateUrl,
  onModelsChanged,
  onSettingsChanged,
  openModelsFolder,
  selectModel,
  updateSettings,
  type ModelListing,
  type Settings,
} from "../ipc";
import "./settings.css";
import { makeMissingThumbnails, needsThumbnail } from "./thumbnails";

const SIZES = [
  { label: "작게", value: 200 },
  { label: "보통", value: 260 },
  { label: "크게", value: 340 },
];
const HEIGHT_MIN = 160;
const HEIGHT_MAX = 440;
/** 슬라이더를 끄는 동안 화면 캐릭터에 보내는 간격 (ms). 크기를 바꿀 때마다 물리를 다시 놓아서 너무 자주 보내면 머리카락이 튄다 */
const HEIGHT_SEND_INTERVAL = 70;
const SLEEP_CHOICES = [
  { label: "끄기", value: 0 },
  { label: "5분", value: 5 },
  { label: "10분", value: 10 },
  { label: "30분", value: 30 },
];

/** 캐릭터 (폴더). 모델 이름으로 알아본다. 모르는 캐릭터는 가져온 폴더 이름으로 묶는다. */
const CHARACTERS: { name: string; match: RegExp }[] = [
  { name: "카가미네 린", match: /鏡音リン|kagamine\s*rin/i },
  { name: "카가미네 렌", match: /鏡音レン|kagamine\s*len/i },
  { name: "하츠네 미쿠", match: /初音ミク|hatsune\s*miku/i },
  { name: "KAITO", match: /KAITO/i },
];

function characterOf(model: ModelListing): string {
  // 모델 이름 → 파일 이름 → 가져온 폴더 이름 순서로 본다.
  // 폴더 이름에는 여러 캐릭터가 같이 들어 있을 수 있다 (Sour式鏡音リン・レン → 렌 모델이 린 폴더로 가면 안 됨).
  const fileName = model.file.split("/").pop() ?? "";
  for (const text of [model.name, fileName, model.group]) {
    const found = CHARACTERS.find((character) => character.match.test(text));
    if (found) return found.name;
  }
  return model.group;
}

/** 폴더 안에서 보여 줄 짧은 이름: 캐릭터 이름·버전 번호를 뺀다 (Sour式鏡音レンVer.2.01 White → Sour式 White) */
function shortName(model: ModelListing): string {
  const short = model.name
    .replace(/鏡音(リン|レン)|初音ミク/g, " ")
    .replace(/\s*(Ver\.?|v)\s*\d+(\.\d+)*\s*/gi, " ")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return short || model.name;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  check: '<path d="m5.5 12.5 4 4 9-9"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
};

function icon(name: keyof typeof ICONS, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// ------------------------------------------------------------------ 상태

const state = {
  models: [] as ModelListing[],
  settings: null as Settings | null,
  /** 열어 둔 캐릭터 폴더 (null이면 폴더 목록) */
  folder: null as string | null,
  /** 오른쪽에 보이는 모델 (없으면 쓰는 중인 모델) */
  inspectId: null as string | null,
  version: "",
  thumbVersion: Date.now(),
  /** 썸네일 만드는 중이면 진행 상황 */
  progress: null as { done: number; total: number } | null,
};

const root = document.querySelector<HTMLDivElement>("#app")!;
let toastTimer = 0;

function toast(message: string): void {
  let element = document.querySelector<HTMLDivElement>(".toast");
  if (!element) {
    element = document.createElement("div");
    element.className = "toast";
    document.body.append(element);
  }
  element.textContent = message;
  element.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element!.classList.remove("show"), 1600);
}

function hashOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/**
 * 모델 카드 배경: 썸네일에서 뽑은 옷 색으로 만든 그라디언트와 빛 (settings.css `.look`).
 * 바탕은 두 번째 색, 캐릭터 뒤 빛은 대표 색. 어두운 옷은 깊은 바탕, 밝은 옷은 밝은 바탕.
 */
function lookStyle(model: ModelListing): string {
  const seed = hashOf(model.id);
  const look = model.look ?? { accent: seed % 360, second: (seed + 40) % 360, tone: "mid" as const };
  const a = Math.round(look.accent);
  // 노랑·연두는 어둡게 칠하면 탁한 올리브가 되어 바탕으로는 맞은편 색을 쓴다. 같은 색끼리도 조금씩 다르게
  const nudge = ((seed % 3) - 1) * 14;
  const b = Math.round((isYellow(look.second) ? look.second + 180 : look.second) + nudge + 360) % 360;
  const [base, top, glow, glow2] =
    look.tone === "dark"
      ? [`hsl(${b}, 26%, 10%)`, `hsl(${b}, 24%, 18%)`, `hsla(${a}, 70%, 60%, 0.2)`, `hsla(${b}, 55%, 55%, 0.14)`]
      : look.tone === "light"
        ? [`hsl(${b}, 14%, 22%)`, `hsl(${b}, 16%, 33%)`, `hsla(${a}, 70%, 85%, 0.22)`, "hsla(0, 0%, 100%, 0.08)"]
        : [`hsl(${b}, 22%, 12%)`, `hsl(${b}, 22%, 21%)`, `hsla(${a}, 70%, 62%, 0.2)`, `hsla(${b}, 55%, 58%, 0.14)`];
  // 빛 방향을 모델마다 조금씩 다르게
  const tilt = (seed % 5) * 9 - 18;
  return `--base:${base};--top:${top};--glow:${glow};--glow2:${glow2};--tilt:${150 + tilt}deg`;
}

function isYellow(hue: number): boolean {
  return hue >= 30 && hue <= 100;
}

function picture(path: string | null): string {
  if (!path) return `<div class="placeholder"><span class="shimmer"></span></div>`;
  return `<img src="${mateUrl(path)}?v=${state.thumbVersion}" alt="" draggable="false" />`;
}

/** 카드 그림: 상반신 (없으면 전신) */
function portrait(model: ModelListing): string {
  return picture(model.portrait ?? model.thumbnail);
}

function folders(): { name: string; models: ModelListing[] }[] {
  const map = new Map<string, ModelListing[]>();
  for (const model of state.models) {
    const name = characterOf(model);
    map.set(name, [...(map.get(name) ?? []), model]);
  }
  return [...map.entries()].map(([name, models]) => ({ name, models }));
}

function activeModel(): ModelListing | undefined {
  return state.models.find((model) => model.id === state.settings?.modelId);
}

// ------------------------------------------------------------------ 그리기

function render(): void {
  rememberScroll();
  root.innerHTML = `
    <div class="app">
      <header class="titlebar" data-tauri-drag-region>
        <div class="brand" data-tauri-drag-region>
          <img src="${appIcon}" alt="" />ScreenMate <span class="version">${escape(state.version)}</span>
        </div>
        <div class="tools">
          <button class="chip" data-action="open-models" title="모델 폴더 열기">${icon("folder", 14)}</button>
          <button class="chip" data-action="import">${icon("plus", 14)}모델 가져오기</button>
        </div>
      </header>
      <main class="body">
        <section class="content">${state.folder ? renderFolder(state.folder) : renderFolders()}</section>
        <aside class="inspector">${renderInspector()}</aside>
      </main>
    </div>`;
  bind();
  // 다시 그려도 스크롤은 그대로 (왼쪽은 다른 폴더로 갔을 때만 맨 위로)
  const content = root.querySelector(".content");
  const inspector = root.querySelector(".inspector");
  if (content && state.folder === scroll.folder) content.scrollTop = scroll.content;
  // 폴더를 열면 오른쪽에서, 나오면 왼쪽에서 살짝 밀려 들어온다
  else content?.classList.add(state.folder ? "enter-forward" : "enter-back");
  if (inspector) inspector.scrollTop = scroll.inspector;
  scroll.folder = state.folder;
}

const scroll = { folder: null as string | null, content: 0, inspector: 0 };

function rememberScroll(): void {
  scroll.content = root.querySelector(".content")?.scrollTop ?? 0;
  scroll.inspector = root.querySelector(".inspector")?.scrollTop ?? 0;
}

function renderFolders(): string {
  if (state.models.length === 0) {
    return `<div class="empty">가져온 모델이 없어요.<br />오른쪽 위 <b>모델 가져오기</b>로 .pmx·.pmd가 들어 있는 폴더를 고르세요.</div>`;
  }
  const active = activeModel();
  const cards = folders()
    .map((folder) => {
      const using = active && folder.models.includes(active);
      // 쓰는 중인 모델을 맨 앞(왼쪽 위)에
      const ordered = using && active ? [active, ...folder.models.filter((model) => model !== active)] : folder.models;
      return `
        <button class="tile folder ${using ? "active" : ""}" data-folder="${escape(folder.name)}">
          <div class="art">
            ${mosaic(ordered)}
            ${using ? `<span class="badge">${icon("check", 11)}사용 중</span>` : ""}
          </div>
          <div class="name">${escape(folder.name)}</div>
          <div class="meta">모델 ${folder.models.length}개</div>
        </button>`;
    })
    .join("");
  return `<div class="crumbs"><span class="here">캐릭터</span>${progressNote()}</div><div class="grid">${cards}</div>`;
}

/**
 * 폴더 카드 그림: 안에 든 모델을 최대 4칸으로 나눠 보여 준다.
 * 1개는 통째로, 2개는 좌우 반씩, 3개는 왼쪽 큰 칸 + 오른쪽 두 칸, 4개 이상은 2×2 (넘치면 마지막 칸에 +N).
 * 세로로 긴 칸은 전신, 3:4에 가까운 칸은 카드(머리~허벅지) 그림을 쓴다.
 */
function mosaic(models: ModelListing[]): string {
  const shown = models.slice(0, 4);
  const extra = models.length - shown.length;
  const tall = (index: number) => shown.length === 2 || (shown.length === 3 && index === 0);
  const cells = shown
    .map((model, index) => {
      const art = tall(index) ? picture(model.thumbnail ?? model.portrait) : portrait(model);
      const more = extra > 0 && index === shown.length - 1 ? `<span class="more">+${extra}</span>` : "";
      return `<div class="cell look ${tall(index) ? "tall" : ""}" style="${lookStyle(model)}">${art}${more}</div>`;
    })
    .join("");
  return `<div class="mosaic n${shown.length}">${cells}</div>`;
}

function progressNote(): string {
  const progress = state.progress;
  if (!progress) return "";
  return `<span class="progress"><span class="spinner small"></span>썸네일 만드는 중 ${Math.min(progress.done + 1, progress.total)}/${progress.total}</span>`;
}

function renderFolder(name: string): string {
  const folder = folders().find((candidate) => candidate.name === name);
  if (!folder) {
    state.folder = null;
    return renderFolders();
  }
  const activeId = state.settings?.modelId;
  const inspected = state.inspectId ?? activeId;
  const cards = folder.models
    .map(
      (model) => `
        <button class="tile ${model.id === activeId ? "active" : ""} ${model.id === inspected ? "picked" : ""}" data-model="${escape(model.id)}" title="두 번 누르면 바로 써요">
          <div class="art look" style="${lookStyle(model)}">
            ${portrait(model)}
            ${model.id === activeId ? `<span class="badge">${icon("check", 11)}사용 중</span>` : ""}
          </div>
          <div class="name">${escape(shortName(model))}</div>
          <div class="meta">${escape(model.group)}</div>
        </button>`,
    )
    .join("");
  return `
    <div class="crumbs">
      <button class="crumb-back" data-folder="" title="뒤로 (esc)">${icon("back", 15)}캐릭터</button>
      <span class="sep">/</span><span class="here">${escape(folder.name)}</span>
      <span class="count">${folder.models.length}</span>
      ${progressNote()}
    </div>
    <div class="grid">${cards}</div>`;
}

function renderInspector(): string {
  const settings = state.settings;
  if (!settings) return "";
  const model = state.models.find((candidate) => candidate.id === state.inspectId) ?? activeModel() ?? state.models[0];
  const using = model?.id === settings.modelId;
  const head = model
    ? `
      <div class="preview look" style="${lookStyle(model)}">${picture(model.thumbnail)}</div>
      <div class="title">
        <h2>${escape(shortName(model))}</h2>
        <div class="sub">${escape(characterOf(model))} · ${escape(model.group)} · ${model.format.toUpperCase()}</div>
      </div>
      <button class="button primary block" data-use="${escape(model.id)}" ${using ? "disabled" : ""}>
        ${using ? `${icon("check", 15)}적용 중` : `이 모델 쓰기<span class="kbd">↩</span>`}
      </button>`
    : "";
  return `
    ${head}
    <div class="panel">
      <div class="panel-row">
        <div class="text"><div class="label">크기</div></div>
        <div class="choices">${SIZES.map(
          (size) =>
            `<button data-size="${size.value}" class="${Math.abs(settings.heightPx - size.value) < 0.5 ? "active" : ""}">${size.label}</button>`,
        ).join("")}</div>
      </div>
      <div class="slider-row">
        <input id="height" type="range" min="${HEIGHT_MIN}" max="${HEIGHT_MAX}" step="1" value="${settings.heightPx}" style="--fill:${fillOf(settings.heightPx)}" />
        <span class="value" id="height-value">${Math.round(settings.heightPx)}px</span>
      </div>
      ${toggle("gaze", "커서 바라보기", "가까이 온 커서를 눈과 고개로 따라봐요", settings.gaze)}
      ${toggle("variety", "다양한 동작", "두리번거리기, 기지개, 앉아서 쉬기", settings.variety)}
      ${toggle("ledges", "창 위에 올라가기", "창 위에 내려앉고 걷고 걸터앉아요", settings.ledges)}
      <div class="panel-row stacked">
        <div class="text"><div class="label">입력이 없으면 졸기</div></div>
        <div class="choices">${SLEEP_CHOICES.map(
          (choice) => `<button data-sleep="${choice.value}" class="${settings.sleepMinutes === choice.value ? "active" : ""}">${choice.label}</button>`,
        ).join("")}</div>
      </div>
    </div>`;
}

function toggle(key: "gaze" | "variety" | "ledges", label: string, hint: string, on: boolean): string {
  return `
    <div class="panel-row clickable" data-toggle="${key}">
      <div class="text"><div class="label">${label}</div><div class="hint">${hint}</div></div>
      <span class="switch ${on ? "on" : ""}" role="switch" aria-checked="${on}" aria-label="${label}"></span>
    </div>`;
}

// ------------------------------------------------------------------ 입력

function bind(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-folder]").forEach((button) =>
    button.addEventListener("click", () => openFolder(button.dataset.folder || null)),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-model]").forEach((button) => {
    button.addEventListener("click", () => {
      state.inspectId = button.dataset.model!;
      render();
    });
    // 두 번 누르면 바로 쓰기
    button.addEventListener("dblclick", () => void use(button.dataset.model!));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-use]").forEach((button) =>
    button.addEventListener("click", () => void use(button.dataset.use!)),
  );
  root.querySelectorAll<HTMLElement>("[data-toggle]").forEach((row) =>
    row.addEventListener("click", () => {
      const key = row.dataset.toggle as ToggleKey;
      void change({ [key]: !state.settings?.[key] });
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-sleep]").forEach((button) =>
    button.addEventListener("click", () => void change({ sleepMinutes: Number(button.dataset.sleep) })),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((button) =>
    button.addEventListener("click", () => void change({ heightPx: Number(button.dataset.size) })),
  );
  const height = root.querySelector<HTMLInputElement>("#height");
  if (height) {
    height.addEventListener("pointerdown", () => {
      slider.dragging = true;
      slider.gliding = false;
      cancelAnimationFrame(slider.frame);
    });
    height.addEventListener("input", () => {
      const value = Number(height.value);
      showHeight(value, false);
      markSizeChoice(value);
      sendHeight(value);
    });
    // 놓을 때(키보드로 바꿀 때도) 마지막 값은 바로 보낸다
    height.addEventListener("change", () => {
      slider.dragging = false;
      sendHeight(Number(height.value), true);
    });
  }
  root.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) =>
    button.addEventListener("click", () => {
      if (button.dataset.action === "import") void importModels();
      else if (button.dataset.action === "open-models") void openModelsFolder();
    }),
  );
}

/** 폴더를 연다 (null이면 폴더 목록). 오른쪽에는 그 폴더에서 쓰는 중인 모델, 없으면 첫 모델을 보여 준다 */
function openFolder(name: string | null): void {
  state.folder = name;
  const folder = name ? folders().find((candidate) => candidate.name === name) : undefined;
  if (folder) {
    const using = folder.models.find((model) => model.id === state.settings?.modelId);
    state.inspectId = (using ?? folder.models[0]).id;
  }
  render();
}

/** esc: 폴더에서 나가기, ←→: 폴더 안 모델 고르기, return: 고른 모델 쓰기 */
function onKey(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "Escape" && state.folder) {
    openFolder(null);
    return;
  }
  const folder = state.folder ? folders().find((candidate) => candidate.name === state.folder) : undefined;
  if (!folder) return;
  const current = state.inspectId ?? state.settings?.modelId ?? null;
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    const index = folder.models.findIndex((model) => model.id === current);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = folder.models[(index + step + folder.models.length) % folder.models.length];
    state.inspectId = next.id;
    render();
  } else if (event.key === "Enter" && current && current !== state.settings?.modelId) {
    event.preventDefault();
    void use(current);
  }
}

async function use(id: string): Promise<void> {
  state.settings = await selectModel(id);
  state.inspectId = id;
  render();
  toast("모델을 바꿨어요");
}

type ToggleKey = "gaze" | "variety" | "ledges";

/** 가장 최근 요청 번호. 늦게 온 예전 응답이 화면을 되돌리지 않게 */
let changeSeq = 0;
/** 아직 응답이 안 온 요청 수 */
let pendingChanges = 0;

/**
 * 설정을 바꾼다. 화면은 먼저 바꿔 두고(토글 트랜지션이 바로 돈다) 저장 결과로 맞춘다.
 * 통째로 다시 그리지 않아서 스크롤·슬라이더 손잡이가 그대로 있다.
 */
async function change(patch: Partial<Omit<Settings, "modelId">>): Promise<void> {
  if (!state.settings) return;
  const seq = ++changeSeq;
  state.settings = { ...state.settings, ...patch };
  syncSettings();
  pendingChanges++;
  const saved = await updateSettings(patch).finally(() => pendingChanges--);
  if (seq !== changeSeq) return;
  state.settings = saved;
  syncSettings();
}

/** 설정 패널의 토글·선택·슬라이더를 지금 설정에 맞춘다 (요소는 그대로 두고 상태만) */
function syncSettings(): void {
  const settings = state.settings;
  if (!settings) return;
  root.querySelectorAll<HTMLElement>("[data-toggle]").forEach((row) => {
    const on = settings[row.dataset.toggle as ToggleKey];
    const button = row.querySelector(".switch");
    button?.classList.toggle("on", on);
    button?.setAttribute("aria-checked", String(on));
  });
  root.querySelectorAll<HTMLButtonElement>("[data-sleep]").forEach((button) =>
    button.classList.toggle("active", settings.sleepMinutes === Number(button.dataset.sleep)),
  );
  if (!slider.dragging) {
    markSizeChoice(settings.heightPx);
    glideHeight(settings.heightPx);
  }
}

const slider = { dragging: false, lastSent: 0, timer: 0, frame: 0, gliding: false, target: 0 };
/** 작게·보통·크게를 눌렀을 때 손잡이가 미끄러지는 시간 (ms) */
const GLIDE_MS = 260;

/** 손잡이를 지금 자리에서 value까지 부드럽게 옮긴다 (range input 값은 CSS로 트랜지션이 안 된다) */
function glideHeight(value: number): void {
  const input = root.querySelector<HTMLInputElement>("#height");
  if (!input) return;
  if (slider.gliding && Math.abs(slider.target - value) < 0.5) return;
  cancelAnimationFrame(slider.frame);
  slider.gliding = false;
  const from = Number(input.value);
  if (Math.abs(from - value) < 0.5) {
    showHeight(value, true);
    return;
  }
  slider.gliding = true;
  slider.target = value;
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min((now - start) / GLIDE_MS, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    showHeight(from + (value - from) * eased, true);
    if (t < 1) slider.frame = requestAnimationFrame(step);
    else slider.gliding = false;
  };
  slider.frame = requestAnimationFrame(step);
}

/** 슬라이더 숫자·채운 부분 (moveThumb: 손잡이도 옮긴다. 끄는 중엔 손잡이를 건드리지 않는다) */
function showHeight(value: number, moveThumb: boolean): void {
  const input = root.querySelector<HTMLInputElement>("#height");
  if (!input) return;
  if (moveThumb) input.value = String(value);
  input.style.setProperty("--fill", fillOf(value));
  root.querySelector("#height-value")!.textContent = `${Math.round(value)}px`;
}

function markSizeChoice(value: number): void {
  root.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((button) =>
    button.classList.toggle("active", Math.abs(value - Number(button.dataset.size)) < 0.5),
  );
}

function fillOf(value: number): string {
  return `${(((value - HEIGHT_MIN) / (HEIGHT_MAX - HEIGHT_MIN)) * 100).toFixed(2)}%`;
}

/** 끄는 동안 화면 캐릭터 크기를 일정 간격으로 따라 바꾼다. now면 기다리지 않고 보낸다 */
function sendHeight(value: number, now = false): void {
  window.clearTimeout(slider.timer);
  const send = () => {
    slider.lastSent = performance.now();
    void change({ heightPx: value });
  };
  const wait = HEIGHT_SEND_INTERVAL - (performance.now() - slider.lastSent);
  if (now || wait <= 0) send();
  else slider.timer = window.setTimeout(send, wait);
}

// ------------------------------------------------------------------ 시작

async function refreshModels(): Promise<void> {
  state.models = await listModels();
  state.thumbVersion = Date.now();
  render();
  ensureThumbnails();
}

/** 썸네일이 없는 모델은 이 창에서 찍는다 (화면 위 캐릭터는 그대로). 하나 저장할 때마다 Rust가 models-changed를 보낸다 */
function ensureThumbnails(): void {
  if (!state.models.some(needsThumbnail)) return;
  void makeMissingThumbnails(state.models, (done, total) => {
    state.progress = done < total ? { done, total } : null;
    render();
  }).catch((error) => {
    state.progress = null;
    diag(`thumbnails crashed ${String(error)}`);
  });
}

async function start(): Promise<void> {
  const [settings, models, version] = await Promise.all([getSettings(), listModels(), getVersion().catch(() => "")]);
  state.settings = settings;
  state.models = models;
  state.version = version;
  // 쓰는 중인 모델의 캐릭터 폴더를 열어 둔다
  const active = activeModel();
  if (active) state.folder = characterOf(active);
  render();
  // 트레이 등 다른 곳에서 바꾼 설정. 모델이 바뀌면 카드 배지까지 다시 그리고, 아니면 패널만 맞춘다.
  // 이 창이 보낸 요청이 아직 안 끝났으면 그 응답을 기다린다 (예전 값으로 튀지 않게).
  void onSettingsChanged((next) => {
    const modelChanged = next.modelId !== state.settings?.modelId;
    if (!modelChanged && (slider.dragging || pendingChanges > 0)) return;
    state.settings = next;
    if (modelChanged) render();
    else syncSettings();
  });
  window.addEventListener("pointerup", () => {
    slider.dragging = false;
  });
  void onModelsChanged(() => void refreshModels());
  window.addEventListener("keydown", onKey);
  ensureThumbnails();
}

// Tauri IPC가 주입되기 전에 시작하면 invoke가 실패한다.
const ready = () => (window as Window & { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata != null;
if (ready()) {
  void start();
} else {
  const timer = window.setInterval(() => {
    if (ready()) {
      window.clearInterval(timer);
      void start();
    }
  }, 50);
}
