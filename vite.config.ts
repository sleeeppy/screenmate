import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;
const debug = process.env.TAURI_ENV_DEBUG === "true";

/**
 * babylon-mmd 1.3.0 PMD 로더 버그 수정.
 *
 * 본 순서를 바로잡는 단계(pmdReader.js "fix bone indices")에서 부모가 없는 본의
 * parentBoneIndex -1을 `boneToIndexTable.get(oldFinalBones[-1])`로 바꿔 undefined가 된다.
 * 그러면 스켈레톤을 만들 때 `bonesInfo[undefined].parentBoneIndex`에서 터진다.
 * (예: Lat Kagamine Len v1.3 — センター, 足ＩＫ 등 루트 본 5개)
 * 음수 인덱스는 그대로 두도록 바꾼다. 상위 버전에서 고쳐지면 이 플러그인을 지운다.
 */
function fixBabylonMmdPmdBoneRemap(): Plugin {
  const broken = "pmxBone.parentBoneIndex = boneToIndexTable.get(oldFinalBones[pmxBone.parentBoneIndex]);";
  const fixed =
    "pmxBone.parentBoneIndex = pmxBone.parentBoneIndex < 0 ? pmxBone.parentBoneIndex : (boneToIndexTable.get(oldFinalBones[pmxBone.parentBoneIndex]) ?? -1);";
  return {
    name: "fix-babylon-mmd-pmd-bone-remap",
    enforce: "pre",
    transform(code, id) {
      // 개발 서버는 id 뒤에 ?v=… 같은 쿼리를 붙인다.
      const path = id.split("?")[0].replace(/\\/g, "/");
      if (!path.endsWith("babylon-mmd/esm/Loader/Parser/pmdReader.js")) {
        return null;
      }
      if (!code.includes(broken)) {
        this.warn("babylon-mmd pmdReader 패치 대상 코드가 없습니다. 버전이 바뀌었으면 이 플러그인을 확인하세요.");
        return null;
      }
      return { code: code.replace(broken, fixed), map: null };
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [fixBabylonMmdPmdBoneRemap()],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: {
    exclude: ["@babylonjs/core", "babylon-mmd"],
  },
  build: {
    // 오버레이(index.html)와 설정 창(settings.html) 두 페이지
    rollupOptions: {
      input: { main: "index.html", settings: "settings.html" },
    },
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !debug, // Vite 8 기본 최소화(oxc). "esbuild"는 esbuild를 따로 깔아야 해서 빌드가 실패했다
    sourcemap: debug,
  },
});
