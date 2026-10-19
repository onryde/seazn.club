// T20 fix round 1, m5 — every outcome a Lichess linking flow reports on its landing page (`?lichess=<code>`, from the
// start route and the callback alike) has a sentence in all four locales, and nothing else is turned into a key.
// The codes come from the module's own declaration (LICHESS_FLASH_CODES); the routes are typed against it, so a code
// they emit cannot fall outside this sweep.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LICHESS_FLASH_CODES,
  LICHESS_FLASH_NEXT_KEYS,
  lichessFlashCode,
  lichessFlashKey,
  lichessFlashNextKey,
  lichessLanding,
  withoutLichessParam,
} from "@/lib/lichess-link";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;

describe("the Lichess linking flash", () => {
  it("every reported outcome maps to a sentence present and non-empty in all four locales", () => {
    let checked = 0;
    for (const code of LICHESS_FLASH_CODES) {
      const key = lichessFlashKey(code);
      expect(key, code).toBe(`settings.account.lichess.flash.${code}`);
      for (const loc of LOCALES) {
        const text = DICTS[loc][key!];
        expect(typeof text === "string" && text.trim().length > 0, `${loc} ${key}`).toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 4 locales × every code").toBe(4 * LICHESS_FLASH_CODES.length);
    expect(LICHESS_FLASH_CODES, "the start's own refusal is one of them").toContain("unavailable");
  });

  it("anything else is no key at all: absent, empty, hand-typed, or a code's look-alike", () => {
    let checked = 0;
    for (const v of [undefined, null, "", "Unavailable", "unavailable ", "flash.linked", "<script>"]) {
      expect(lichessFlashKey(v), JSON.stringify(v)).toBeNull();
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("lands on next — keeping its own query — or on /me", () => {
    expect(lichessLanding(null, "unavailable")).toBe("/me?lichess=unavailable");
    expect(lichessLanding("/settings?tab=account", "unavailable")).toBe("/settings?tab=account&lichess=unavailable");
    expect(lichessLanding("/shared/o/c/d/fixtures/f1/play", "linked")).toBe("/shared/o/c/d/fixtures/f1/play?lichess=linked");
  });
});

// The room reads the same `?lichess=` the settings page and /me read - through the SAME narrowing, so a hand-typed
// value is the same nothing everywhere - and tells a player what to DO about the collision (already_linked).
// Owner requirement (2026-10-19): the already_linked page names nobody - no Lichess username, nothing of the other Seazn
// account - so the landing URL the callback and the start build carries the CODE and nothing a page could show.
describe("lichessLanding carries the outcome code alone", () => {
  it("every code: the landing's query is next's own plus one lichess=<code> (no username, no id, no email)", () => {
    let checked = 0;
    for (const code of LICHESS_FLASH_CODES) {
      for (const next of [null, "/settings?tab=account", "/shared/o/c/d/fixtures/f1/play?t=tok.en"]) {
        const before = new URL(next ?? "/me", "http://x");
        const after = new URL(lichessLanding(next, code), "http://x");
        expect(after.pathname, `${code} ${next}`).toBe(before.pathname);
        expect([...after.searchParams.keys()].sort(), `${code} ${next}`).toEqual([...before.searchParams.keys(), "lichess"].sort());
        expect(after.searchParams.get("lichess"), `${code} ${next}`).toBe(code);
        expect(after.searchParams.get("lichess"), "a bare token, nothing smuggled after it").toMatch(/^[a-z_]+$/);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every code against three nexts").toBe(3 * LICHESS_FLASH_CODES.length);
  });
});

describe("lichessFlashCode - the one narrowing every page reads the param through", () => {
  it("returns exactly the codes the flow reports, and nothing else (the empty case first)", () => {
    let checked = 0;
    for (const v of [undefined, null, "", "Linked", "linked ", "<script>", "already_linked&x=1"]) {
      expect(lichessFlashCode(v), JSON.stringify(v)).toBeNull();
      checked++;
    }
    for (const code of LICHESS_FLASH_CODES) {
      expect(lichessFlashCode(code), code).toBe(code);
      // And the key is DERIVED from it: one narrowing, not two that can drift.
      expect(lichessFlashKey(code), code).toBe(`settings.account.lichess.flash.${lichessFlashCode(code)}`);
      checked++;
    }
    expect(checked, "anti-vacuity: 7 rejects + every code").toBe(7 + LICHESS_FLASH_CODES.length);
  });
});

describe("lichessFlashNextKey - the next step a failure owes the player", () => {
  it("already_linked has one, in all four locales, each in its own words; the other outcomes have none", () => {
    expect(lichessFlashNextKey("already_linked")).toBe("settings.account.lichess.flashNext.already_linked");
    const words = new Set<string>();
    let checked = 0;
    for (const loc of LOCALES) {
      const text = DICTS[loc][lichessFlashNextKey("already_linked")!];
      expect(typeof text === "string" && text.trim().length > 0, loc).toBe(true);
      words.add(text!);
      checked++;
    }
    expect(words.size, "four languages, four sentences").toBe(4);
    expect(checked).toBe(4);
    // Every other code: none. Derived from the declaration, so a code added later is swept without editing this.
    let others = 0;
    for (const code of LICHESS_FLASH_CODES) {
      if (code === "already_linked") continue;
      expect(lichessFlashNextKey(code), code).toBeNull();
      others++;
    }
    expect(others, "anti-vacuity: every other code").toBe(LICHESS_FLASH_CODES.length - 1);
    expect(lichessFlashNextKey("<script>")).toBeNull();
    expect(lichessFlashNextKey(null)).toBeNull();
  });

  it("the table names only codes the flow reports, and every key in it is in all four locales (no orphan, no gap)", () => {
    let checked = 0;
    for (const [code, key] of Object.entries(LICHESS_FLASH_NEXT_KEYS)) {
      expect(LICHESS_FLASH_CODES as readonly string[], code).toContain(code);
      for (const loc of LOCALES) {
        expect(DICTS[loc][key as string], `${loc} ${key}`).toBeTruthy();
        checked++;
      }
    }
    expect(checked, "anti-vacuity: at least one next step, four locales each").toBeGreaterThanOrEqual(4);
  });
});

describe("withoutLichessParam - the address bar after the outcome has been read", () => {
  const TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload-with_chars.sig";
  it("drops lichess= and keeps t= byte for byte (the personal link is the room's only way in)", () => {
    const room = `/shared/o/c/d/fixtures/f1/play?t=${encodeURIComponent(TOKEN)}`;
    expect(withoutLichessParam(`${room}&lichess=already_linked`)).toBe(room);
    // Param first: the rest keeps its order and its own encoding.
    expect(withoutLichessParam(`/p?lichess=linked&t=${TOKEN}&x=a%20b+c`)).toBe(`/p?t=${TOKEN}&x=a%20b+c`);
    // The fragment rides along.
    expect(withoutLichessParam(`${room}&lichess=token#top`)).toBe(`${room}#top`);
  });

  it("nothing left of the query leaves no dangling ?, and a URL without the param comes back unchanged", () => {
    expect(withoutLichessParam("/p?lichess=linked")).toBe("/p");
    expect(withoutLichessParam("/p?lichess=linked#h")).toBe("/p#h");
    let same = 0;
    for (const u of ["/p", "/p?t=abc", "/p?t=abc#h", "/p?xlichess=1", "/p?lichessx=1&t=2"]) {
      expect(withoutLichessParam(u), u).toBe(u);
      same++;
    }
    expect(same).toBe(5);
  });

  it("strips every copy of the param, hand-typed values included (an unknown code is stripped too)", () => {
    expect(withoutLichessParam("/p?lichess=nonsense&t=1&lichess=linked")).toBe("/p?t=1");
    // The empty value, and the bare name.
    expect(withoutLichessParam("/p?t=1&lichess=")).toBe("/p?t=1");
    expect(withoutLichessParam("/p?t=1&lichess")).toBe("/p?t=1");
  });
});
