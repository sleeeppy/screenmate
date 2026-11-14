import {
  broadcastStatus,
  diag,
  fullscreenState,
  onFullscreen,
  onStatusRequest,
  getSettings,
  launchOptions,
  listModels,
  onMotionPreview,
  registerMotions,
  onModelsChanged,
  onReload,
  onSettingsChanged,
  saveProfile,
  stageInfo,
  type ModelListing,
  type Settings,
} from "./ipc";
import type { LoadedCharacter } from "./mmd/loadModel";
import { readOverrides, type ModelProfile } from "./mmd/profile";
import { MOTIONS } from "./motion/clips/index.ts";
import { Stage } from "./stage/engine";
import "./styles.css";

const canvas = document.querySelector<HTMLCanvasElement>("#stage");
if (!canvas) {
  throw new Error("#stage canvas is missing");
}

function setHint(text: string): void {
  const hint = document.querySelector("#hint");
  if (hint) {
    hint.textContent = text;
  }
}

async function boot(target: HTMLCanvasElement): Promise<void> {
  const stage = new Stage(target, await stageInfo());
  let settings = await getSettings();
  let models = await listModels();
  let loadedId: string | null = null;

  stage.applySettings(settings);
  // 전체화면 앱(게임·영상)이 떠 있으면 숨는다
  void onFullscreen((fullscreen) => stage.setHidden(fullscreen));
  stage.setHidden(await fullscreenState().catch(() => false));
  // 설정 창: 지금 상태를 알리고, 물으면 다시 알린다
  stage.onStatus = (status) => void broadcastStatus(status).catch(() => {});
  void onStatusRequest(() => void broadcastStatus(stage.status()).catch(() => {}));

  // 기본은 자율 행동. 실행 옵션(--motion)이 있거나 트레이에서 고르면 그 모션만 미리보기한다.
  const options = await launchOptions();
  stage.benchIdle = options.benchIdle;
  stage.dropOnWindow = options.dropOnWindow;
  stage.demoHang = options.demoHang;
  // 검증용: 캔버스 뒤 단색(마젠타). 캡처에서 이 색 영역만 잘라 다른 창이 섞이지 않게 한다.
  if (options.backdrop) target.style.background = "#ff00ff";
  if (options.motion) stage.playMotion(options.motion);
  const syncMotionMenu = () =>
    void registerMotions(
      [
        { name: "auto", label: "자동 (행동)" },
        ...MOTIONS.map((motion) => ({ name: motion.name, label: motion.label })),
      ],
      stage.currentMotion,
    );
  syncMotionMenu();
  void onMotionPreview((name) => {
    stage.playMotion(name);
    syncMotionMenu();
  });
  stage.onMotionChanged = syncMotionMenu;

  const selected = (): ModelListing | undefined =>
    models.find((entry) => entry.id === settings.modelId) ?? models[0];

  const loadSelected = async (force = false) => {
    const entry = selected();
    if (!entry) {
      stage.unload();
      loadedId = null;
      setHint("트레이 아이콘 → 모델 가져오기… 로 MMD 모델 폴더를 선택하세요");
      return;
    }
    if (!force && entry.id === loadedId) {
      return;
    }
    loadedId = entry.id;
    setHint(`${entry.name} 불러오는 중`);
    try {
      const loaded = await stage.load(entry);
      if (loaded) {
        setHint("");
        report(loaded);
      }
    } catch (error) {
      loadedId = null;
      const message = error instanceof Error ? error.message : String(error);
      setHint(`${entry.name}: ${message}`);
      diag(`load-failed ${entry.id}: ${message}`);
    }
  };

  void onSettingsChanged((next: Settings) => {
    settings = next;
    stage.applySettings(next);
    void loadSelected();
  });
  void onModelsChanged(async () => {
    models = await listModels();
    void loadSelected();
  });
  void onReload(async () => {
    models = await listModels();
    void loadSelected(true);
  });
  window.addEventListener("resize", async () => {
    stage.updateInfo(await stageInfo());
  });

  await loadSelected();
}

/** 프로필 파일을 갱신하고 진단 로그를 남긴다. */
function report(loaded: LoadedCharacter): void {
  const { entry, computedCalibration: calibration, computedMorphs: morphs } = loaded;
  const profile: ModelProfile = {
    version: 1,
    name: entry.name,
    computed: { calibration, morphs, morphCount: loaded.morphNames.length, loadMs: loaded.loadMs },
    overrides: readOverrides(entry.profile),
  };
  void saveProfile(entry.id, profile);
  const missingEmotions = ["blink", "smile", "joy", "surprise", "shy", "sleepy", "trouble", "angry"].filter(
    (emotion) => !(emotion in morphs),
  );
  diag(
    `loaded ${entry.id} in ${loaded.loadMs}ms headY=${calibration.headY} legScale=${calibration.legScale} ` +
      `armOffset=${calibration.armOffsetDeg.left}/${calibration.armOffsetDeg.right} ` +
      `blink=${JSON.stringify(morphs.blink)} missingEmotions=[${missingEmotions.join(",")}] ` +
      `missingBones=[${calibration.missingBones.join(",")}]`,
  );
}

// Tauri IPC가 주입되기 전에 시작하면 invoke가 실패한다.
const tauriReady = () =>
  (window as Window & { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__?.metadata != null;

function start(): void {
  boot(canvas!).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setHint(message);
    diag(`boot-failed: ${message}`);
  });
}

if (tauriReady()) {
  start();
} else {
  const timer = window.setInterval(() => {
    if (tauriReady()) {
      window.clearInterval(timer);
      start();
    }
  }, 50);
}
