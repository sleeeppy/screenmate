import type { Motion } from "../dsl.ts";
import fall from "./fall.ts";
import hang from "./hang.ts";
import idle from "./idle.ts";
import land from "./land.ts";
import walk from "./walk.ts";

export const MOTIONS: readonly Motion[] = [idle, walk, hang, fall, land];

export function motionByName(name: string): Motion | undefined {
  return MOTIONS.find((motion) => motion.name === name);
}

export { fall, hang, idle, land, walk };
