/**
 * 모션을 VMD 파일로 내보낸다. MMD·MikuMikuMoving에서 모델에 불러와 확인하는 용도.
 *
 *   npm run export-vmd            → out/vmd/<모션>.vmd
 *   npm run export-vmd -- walk    → 걷기만
 *
 * 기준 모델 값(다리 길이 9.3, 팔 기본각 37°)으로 내보낸다. 앱은 모델마다 보정을 더한다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MORPH_NAMES } from "../src/mmd/morphMap.ts";
import { MOTIONS } from "../src/motion/clips/index.ts";
import { motionToVmd } from "../src/motion/vmd.ts";

const wanted = process.argv.slice(2);
const directory = join(import.meta.dirname, "..", "out", "vmd");
mkdirSync(directory, { recursive: true });

for (const motion of MOTIONS) {
  if (wanted.length > 0 && !wanted.includes(motion.name)) continue;
  const bytes = motionToVmd(motion, { morphNames: DEFAULT_MORPH_NAMES });
  const path = join(directory, `${motion.name}.vmd`);
  writeFileSync(path, bytes);
  console.log(`${motion.name.padEnd(6)} ${motion.label}  ${bytes.length} bytes → ${path}`);
}
