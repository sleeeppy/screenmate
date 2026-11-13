import type { Motion } from "../dsl.ts";
import fall from "./fall.ts";
import hang from "./hang.ts";
import hangStruggle from "./hangStruggle.ts";
import idle from "./idle.ts";
import { idleLook, idleStretch } from "./idleVariants.ts";
import land from "./land.ts";
import pat from "./pat.ts";
import poke from "./poke.ts";
import { sitDownEdge, sitDownFloor, sitEdge, sitFloor, sleepEdge, sleepFloor, standUpEdge, standUpFloor } from "./sit.ts";
import walk from "./walk.ts";

export const MOTIONS: readonly Motion[] = [
  idle,
  idleLook,
  idleStretch,
  walk,
  hang,
  hangStruggle,
  fall,
  land,
  pat,
  poke,
  sitEdge,
  sitFloor,
  sleepEdge,
  sleepFloor,
  sitDownEdge,
  sitDownFloor,
  standUpEdge,
  standUpFloor,
];

export function motionByName(name: string): Motion | undefined {
  return MOTIONS.find((motion) => motion.name === name);
}

export {
  fall,
  hang,
  hangStruggle,
  idle,
  idleLook,
  idleStretch,
  land,
  pat,
  poke,
  sitDownEdge,
  sitDownFloor,
  sitEdge,
  sitFloor,
  sleepEdge,
  sleepFloor,
  standUpEdge,
  standUpFloor,
  walk,
};
