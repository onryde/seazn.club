// T17B fix 2 (D7, owner-reported 2026-10-14): the match room's and the arbiter panel's buttons showed the arrow, not
// the hand. Tailwind v4's preflight gives <button> `cursor: default`; the repo's convention is a per-component
// `cursor-pointer` (no site-wide rule: blast radius), and these files had none.
//
// A static scan, because apps/web vitest has no DOM: every <button> in these files carries `cursor-pointer` — written
// on the tag, or in the class constant the tag uses — and every one that can be disabled also carries
// `disabled:cursor-not-allowed`. Counted; zero buttons scanned is a failure.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS = join(__dirname, "..", "..", "..");
const ROOM_DIR = join(COMPONENTS, "public-site", "match-room");
/** Every component file of the room (each one with a button is scanned), and the arbiter panel's two. */
const FILES = [
  ...readdirSync(ROOM_DIR).filter((f) => f.endsWith(".tsx")).map((f) => join(ROOM_DIR, f)),
  join(COMPONENTS, "v2", "arbiter-panel.tsx"),
  join(COMPONENTS, "v2", "arbiter-flag-cards.tsx"),
];

/** `const NAME = "…"` / `export const NAME =\n  "…"` class constants, from every scanned file (the panel imports the
 *  flag cards' ones). */
function classConstants(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of FILES) {
    for (const m of readFileSync(f, "utf8").matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*\n?\s*(["`])([^"`]*)\2/g)) {
      out.set(m[1]!, m[3]!);
    }
  }
  return out;
}

/** Each <button …> opening tag of the JSX, braces balanced (a className template may hold `>`). Comments are
 *  dropped first: prose naming the element is not a button. */
function buttonTags(raw: string): string[] {
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const tags: string[] = [];
  let at = src.search(/<button[\s>]/);
  while (at >= 0) {
    let depth = 0;
    let i = at + "<button".length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push(src.slice(at, i + 1));
    const next = src.slice(i).search(/<button[\s>]/);
    at = next < 0 ? -1 : i + next;
  }
  return tags;
}

/** The tag's own classes, with every class constant it names spelled out — transitively (controls.tsx builds
 *  SECONDARY from `${BTN} …`). */
function classesOf(tag: string, consts: Map<string, string>): string {
  let classes = tag;
  const seen = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, value] of consts) {
      if (seen.has(name) || !new RegExp(`\\b${name}\\b`).test(classes)) continue;
      seen.add(name);
      classes += ` ${value}`;
      grew = true;
    }
  }
  return classes;
}

describe("buttons show the hand (T17B fix 2, D7)", () => {
  it("every button in the match room and the arbiter panel carries cursor-pointer, and a disableable one keeps cursor-not-allowed — counted per file", () => {
    const consts = classConstants();
    let buttons = 0;
    let disableable = 0;
    const perFile: Record<string, number> = {};
    for (const f of FILES) {
      const tags = buttonTags(readFileSync(f, "utf8"));
      for (const tag of tags) {
        const classes = classesOf(tag, consts);
        const where = `${f.slice(COMPONENTS.length + 1)}: ${tag.slice(0, 140).replace(/\s+/g, " ")}`;
        expect(classes, where).toMatch(/(^|[\s"`{])cursor-pointer\b/);
        // `\bdisabled=` also matches inside `aria-disabled=`, so the two are told apart: a native-disabled button
        // needs the `disabled:` variant, and an aria-disabled one (the arbiter's White/Black switch stays focusable to
        // say why a side is closed) needs the `aria-disabled:` variant, since `:disabled` never matches it.
        if (/(?<![-\w])disabled=/.test(tag)) {
          expect(classes, `${where} (disableable)`).toMatch(/(?<![-\w])disabled:cursor-not-allowed\b/);
          disableable++;
        }
        if (/\baria-disabled=/.test(tag)) {
          expect(classes, `${where} (aria-disableable)`).toMatch(/\baria-disabled:cursor-not-allowed\b/);
          disableable++;
        }
        buttons++;
      }
      if (tags.length > 0) perFile[f.slice(COMPONENTS.length + 1)] = tags.length;
    }
    expect(buttons, `anti-vacuity: buttons scanned ${JSON.stringify(perFile)}`).toBeGreaterThanOrEqual(20);
    expect(disableable, "anti-vacuity: disableable buttons scanned").toBeGreaterThan(0);
    // The scan reached every file the owner named: the room's check-in, controls and cards, and the panel.
    for (const f of ["public-site/match-room/checkin.tsx", "public-site/match-room/controls.tsx", "public-site/match-room/room-cards.tsx", "v2/arbiter-panel.tsx"]) {
      expect(perFile[f] ?? 0, f).toBeGreaterThan(0);
    }
  });
});
