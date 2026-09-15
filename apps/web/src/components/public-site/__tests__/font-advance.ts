// A dependency-free advance-width reader for the repo's committed font files
// (`apps/web/assets/fonts`), used by `schedule-rail-fits.test.ts` to prove the
// public Schedule's fixed-width time/status rail actually holds the words the
// dictionaries put in it (spectator N1f f1/f3).
//
// Why measure at all: `apps/web` vitest is `environment: "node"`, so no test
// can see a text run overflow its grid column. The rail is a fixed track and
// the words inside it are translations, so the only thing that can witness the
// overflow before a browser does is the font's own metrics.
//
// Why no library: `fontkit` is hoisted into the workspace root but is not a
// dependency of `apps/web`, and the faces `next/font` serves (`.next/static/
// media/*.woff2`) only exist after a build — neither is safe for a test that
// has to run on a fresh checkout. The committed files are the faces the build
// ships:
// - `BarlowCondensed-SemiBold.ttf`: measured against the built
//   `Barlow Condensed SemiBold` woff2, every rail string agrees to 0.00px
//   (spectator N1f).
// - `Geist-Regular.ttf` / `Geist-Bold.ttf` (N1g g3): the body face is a
//   VARIABLE font that `next/font/google` fetches at build time, and nothing
//   of it was committed, so the rail's body-face lines used to be measured in
//   Inter as a stand-in — which put the bold live chip 0.9px narrower than it
//   paints. These two are static instances (wght 400 and 700, fontTools
//   `instantiateVariableFont`) of the build's own latin Geist woff2; every
//   advance in them equals HarfBuzz's on the variable file at the same weight
//   (225 codepoints, 0 font units apart). OFL 1.1, no Reserved Font Name:
//   `assets/fonts/OFL-Geist.txt`.
//
// Accepted drift (review-n1f m4, parked): `next/font/google` fetches BOTH
// families at build time, so an upstream update can move the shipped metrics
// away from these copies without a test noticing. Nothing detects that; if
// either family is updated, re-derive the copies from `.next/static/media`.
//
// This reads only `head`, `maxp`, `hhea`, `hmtx`, `cmap` and `OS/2` — so it
// works on both sfnt flavours (glyf `.ttf` and CFF `.otf`). It applies no
// GPOS kerning, and kerning only NARROWS the rail's words (HarfBuzz on Geist
// 400/700: unkerned minus kerned is 0 to 142 font units per word, never
// negative; Barlow Condensed at most 1.35px at 14px), so every width here is
// an over-estimate — the safe direction for a "fits" gate.
import { readFileSync } from "node:fs";

export interface Face {
  /** Advance width of one codepoint, in font units. */
  advance(codePoint: number): number;
  unitsPerEm: number;
  /** `OS/2.usWeightClass`: the CSS weight this file IS (400, 600, 700…). */
  weightClass: number;
  name: string;
}

const tag = (buf: Buffer, off: number) => buf.toString("latin1", off, off + 4);

/** Codepoint -> glyph id, from the best Unicode `cmap` subtable present. */
function readCmap(buf: Buffer, off: number): Map<number, number> {
  const numTables = buf.readUInt16BE(off + 2);
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = off + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const sub = off + buf.readUInt32BE(rec + 4);
    // Prefer a full-repertoire table, then the Windows BMP one, then any
    // Unicode table at all.
    const score =
      platform === 3 && encoding === 10 ? 3 : platform === 3 && encoding === 1 ? 2 : platform === 0 ? 1 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = sub;
    }
  }
  if (best < 0) throw new Error("no unicode cmap subtable");
  const map = new Map<number, number>();
  const format = buf.readUInt16BE(best);
  if (format === 4) {
    const segCount = buf.readUInt16BE(best + 6) / 2;
    const endAt = best + 14;
    const startAt = endAt + segCount * 2 + 2;
    const deltaAt = startAt + segCount * 2;
    const rangeAt = deltaAt + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = buf.readUInt16BE(endAt + s * 2);
      const start = buf.readUInt16BE(startAt + s * 2);
      const delta = buf.readInt16BE(deltaAt + s * 2);
      const rangeOffset = buf.readUInt16BE(rangeAt + s * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let gid: number;
        if (rangeOffset === 0) {
          gid = (c + delta) & 0xffff;
        } else {
          const at = rangeAt + s * 2 + rangeOffset + (c - start) * 2;
          if (at + 1 >= buf.length) continue;
          const raw = buf.readUInt16BE(at);
          gid = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }
        if (gid !== 0) map.set(c, gid);
      }
    }
  } else if (format === 12) {
    const nGroups = buf.readUInt32BE(best + 12);
    for (let g = 0; g < nGroups; g++) {
      const at = best + 16 + g * 12;
      const start = buf.readUInt32BE(at);
      const end = buf.readUInt32BE(at + 4);
      const startGid = buf.readUInt32BE(at + 8);
      for (let c = start; c <= end; c++) map.set(c, startGid + (c - start));
    }
  } else {
    throw new Error(`unsupported cmap format ${format}`);
  }
  return map;
}

/** Open a committed `.ttf`/`.otf` and expose its horizontal metrics. */
export function openFace(path: string, name: string): Face {
  const buf = readFileSync(path);
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(tag(buf, rec), buf.readUInt32BE(rec + 8));
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const maxp = tables.get("maxp");
  const cmap = tables.get("cmap");
  const os2 = tables.get("OS/2");
  if (head == null || hhea == null || hmtx == null || maxp == null || cmap == null || os2 == null) {
    throw new Error(`${name}: missing a required sfnt table`);
  }
  const unitsPerEm = buf.readUInt16BE(head + 18);
  const numGlyphs = buf.readUInt16BE(maxp + 4);
  const numHMetrics = buf.readUInt16BE(hhea + 34);
  const chars = readCmap(buf, cmap);
  const advanceOf = (gid: number): number => {
    const i = Math.min(gid, numHMetrics - 1);
    return buf.readUInt16BE(hmtx + i * 4);
  };
  return {
    unitsPerEm,
    weightClass: buf.readUInt16BE(os2 + 4),
    name,
    advance(codePoint: number): number {
      const gid = chars.get(codePoint);
      if (gid == null || gid >= numGlyphs) {
        throw new Error(`${name}: no glyph for U+${codePoint.toString(16).toUpperCase()}`);
      }
      return advanceOf(gid);
    },
  };
}

/**
 * Painted width of `text` in CSS px.
 *
 * @param sizePx  the computed `font-size`.
 * @param trackingEm  `letter-spacing` in em (Tailwind's `tracking-wide` is
 *   0.025em); CSS adds it after every character, the last one included.
 */
export function textWidth(face: Face, text: string, sizePx: number, trackingEm = 0): number {
  const chars = [...text];
  const units = chars.reduce((a, c) => a + face.advance(c.codePointAt(0)!), 0);
  return (units / face.unitsPerEm) * sizePx + trackingEm * sizePx * chars.length;
}

/**
 * The narrowest a box can be without the text painting outside it — CSS
 * `min-content`: the widest run with no soft wrap opportunity in it. A phrase
 * wider than its column is fine if it can WRAP inside the column; a single
 * word wider than the column is what paints into the neighbouring one.
 */
export function minContentWidth(face: Face, text: string, sizePx: number, trackingEm = 0): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  return Math.max(...words.map((w) => textWidth(face, w, sizePx, trackingEm)));
}
