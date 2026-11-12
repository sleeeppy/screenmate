/**
 * 모션 → VMD (MikuMikuDance 모션 파일) 변환 (순수 TS, Node·브라우저 공용).
 *
 * MMD·MikuMikuMoving에서 모델에 불러와 모션을 눈으로 확인하는 용도다.
 * 기준 모델 값으로 내보낸다: 다리 길이 보정(legScale)과 팔 기본각 보정은 앱에서만 적용된다.
 *
 * 형식 참고: babylon-mmd Loader/Parser/vmdObject.js
 */
import type { Motion } from "./dsl.ts";

const HEADER = "Vocaloid Motion Data 0002";
const LEG_IK_BONES = ["左足ＩＫ", "右足ＩＫ", "左つま先ＩＫ", "右つま先ＩＫ"];

export interface VmdOptions {
  /** 감정 이름 → 실제 모프 이름. 없으면 감정 이름을 그대로 쓴다. */
  morphNames?: Record<string, string>;
  modelName?: string;
}

export function motionToVmd(motion: Motion, options: VmdOptions = {}): Uint8Array {
  const writer = new Writer();
  writer.fixedString(HEADER, 30, false);
  writer.fixedString(options.modelName ?? "screenmate", 20);

  const boneFrames = motion.bones.flatMap((track) => track.keys.map((key) => ({ track, key })));
  writer.u32(boneFrames.length);
  for (const { track, key } of boneFrames) {
    writer.fixedString(track.name, 15);
    writer.u32(key.frame);
    writer.f32(key.position[0]);
    writer.f32(key.position[1]);
    writer.f32(key.position[2]);
    writer.f32(key.rotation[0]);
    writer.f32(key.rotation[1]);
    writer.f32(key.rotation[2]);
    writer.f32(key.rotation[3]);
    writer.bytes(interpolationBytes(key.curve));
  }

  const morphFrames = motion.morphs.flatMap((track) => track.keys.map((key) => ({ track, key })));
  writer.u32(morphFrames.length);
  for (const { track, key } of morphFrames) {
    writer.fixedString(options.morphNames?.[track.name] ?? track.name, 15);
    writer.u32(key.frame);
    writer.f32(key.weight);
  }

  writer.u32(0); // camera
  writer.u32(0); // light
  writer.u32(0); // self shadow

  // 다리 IK를 끄는 모션은 0프레임에 IK off 키를 남긴다.
  if (!motion.legIk) {
    writer.u32(1);
    writer.u32(0);
    writer.u8(1); // 표시
    writer.u32(LEG_IK_BONES.length);
    for (const name of LEG_IK_BONES) {
      writer.fixedString(name, 20);
      writer.u8(0);
    }
  } else {
    writer.u32(0);
  }
  return writer.finish();
}

/** 4채널(X·Y·Z·회전)에 같은 곡선을 쓰는 64바이트 보간 데이터 */
export function interpolationBytes(curve: readonly [number, number, number, number]): Uint8Array {
  const [x1, y1, x2, y2] = curve.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 127));
  // X_x1,Y_x1,Z_x1,R_x1, X_y1,…, X_x2,…, X_y2,…
  const base = [x1, x1, x1, x1, y1, y1, y1, y1, x2, x2, x2, x2, y2, y2, y2, y2];
  const out = new Uint8Array(64);
  for (let row = 0; row < 4; row++) {
    for (let index = 0; index < 16 - row; index++) out[row * 16 + index] = base[index + row];
  }
  // 0행의 3·4번째 바이트는 물리 토글 (on)
  out[2] = 0x63;
  out[3] = 0x0f;
  return out;
}

class Writer {
  private chunks: Uint8Array[] = [];

  u8(value: number): void {
    this.chunks.push(Uint8Array.of(value));
  }

  u32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    this.chunks.push(bytes);
  }

  f32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    this.chunks.push(bytes);
  }

  bytes(value: Uint8Array): void {
    this.chunks.push(value);
  }

  /** 고정 길이 문자열. VMD 이름은 Shift-JIS, 남는 칸은 0. */
  fixedString(value: string, length: number, shiftJis = true): void {
    const encoded = shiftJis ? encodeShiftJis(value) : new TextEncoder().encode(value);
    const out = new Uint8Array(length);
    out.set(encoded.subarray(0, length));
    this.chunks.push(out);
  }

  finish(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

let shiftJisTable: Map<string, number[]> | null = null;

/** TextDecoder("shift_jis")로 역표를 만들어 인코딩한다 (TextEncoder는 UTF-8만 지원). */
export function encodeShiftJis(value: string): Uint8Array {
  if (!shiftJisTable) {
    shiftJisTable = new Map();
    const decoder = new TextDecoder("shift_jis", { fatal: true });
    const single = (byte: number) => {
      try {
        shiftJisTable!.set(decoder.decode(Uint8Array.of(byte)), [byte]);
      } catch {
        // 정의되지 않은 바이트
      }
    };
    for (let byte = 0x20; byte < 0x7f; byte++) single(byte);
    for (let byte = 0xa1; byte <= 0xdf; byte++) single(byte);
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead > 0x9f && lead < 0xe0) continue;
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail === 0x7f) continue;
        try {
          const char = decoder.decode(Uint8Array.of(lead, trail));
          if (!shiftJisTable.has(char)) shiftJisTable.set(char, [lead, trail]);
        } catch {
          // 정의되지 않은 코드
        }
      }
    }
  }
  const bytes: number[] = [];
  for (const char of value) {
    const code = shiftJisTable.get(char);
    if (!code) throw new Error(`Shift-JIS로 쓸 수 없는 문자: ${char} (${value})`);
    bytes.push(...code);
  }
  return Uint8Array.from(bytes);
}
