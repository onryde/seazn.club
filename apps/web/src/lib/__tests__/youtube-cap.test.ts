// YouTube Connect T12 fix round 1 (m6, m3): the ten-streams cap has ONE authority, and the copy, the pool and the database floor all
// answer to it; and the YouTube mark sits only on a link that goes to YouTube.
//
// Expected values here come from the rulebook, not from the code under test: the cap is YouTube's own "10 active streams per channel"
// as the migration V479 wrote it into `youtube_stream_keys_slot_range` — the database's floor is an INDEPENDENT statement of the same
// number, so reading it back out of the SQL is a real check that the constant has not drifted from it.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL, isYoutubeUrl } from "../youtube";
import { createErrorText } from "../stream-session-view";

const WEB = join(import.meta.dirname, "..", "..", "..");
const DICT_DIR = join(WEB, "src", "dictionaries");
const LOCALES = ["en", "es", "fr", "nl"] as const;
const dict = (l: string): Record<string, string> => JSON.parse(readFileSync(join(DICT_DIR, l, "ui.json"), "utf8"));
const KEY = "stream.error.youtube_channel_busy";

describe("the ten-streams cap: one number, three places that must agree", () => {
  it("equals the database's own floor — V479's slot range is 1..N and N is the constant", () => {
    const sql = readFileSync(join(WEB, "..", "..", "db", "migration", "deltas", "V479__youtube_connect.sql"), "utf8");
    const hit = /youtube_stream_keys_slot_range\s+check\s*\(\s*slot\s+between\s+1\s+and\s+(\d+)\s*\)/i.exec(sql);
    expect(hit, "anti-vacuity: the constraint was found in the migration").not.toBeNull();
    expect(YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL).toBe(Number(hit![1]));
    expect(YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL, "a plain positive integer").toBeGreaterThan(0);
    expect(Number.isInteger(YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL)).toBe(true);
  });

  it("the pool imports the constant — no second literal, every guard and the slot series read the one name", () => {
    const src = readFileSync(join(WEB, "src", "server", "youtube", "prepare.ts"), "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bYOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL\b[^}]*\}\s*from\s*"@\/lib\/youtube"/);
    expect(src, "the local alias is derived from the import, not retyped").toMatch(/const MAX_LIVE_KEYS_PER_CHANNEL\s*=\s*YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL\s*;/);
    // The three places the cap bites, each by name: the busy guard, the grow decision and the slot series.
    const uses = [...src.matchAll(/\bMAX_LIVE_KEYS_PER_CHANNEL\b/g)].length;
    expect(uses, "anti-vacuity: the alias is declared once and used at the three guards").toBeGreaterThanOrEqual(4);
    expect(src, "no `< 10` or series bound typed as a literal").not.toMatch(/liveKeyCount\([^)]*\)\)\s*<\s*\d+/);
    expect(src).not.toMatch(/generate_series\(\s*1\s*,\s*\d+/);
  });

  it("the copy for the busy refusal CARRIES the number in all four locales — a placeholder, never a typed digit — and renders it", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const template = dict(l)[KEY]!;
      expect(template, `${l}: the sentence exists`).toBeTypeOf("string");
      expect(template.match(/\{max\}/g), `${l}: exactly one {max}`).toHaveLength(1);
      expect(template, `${l}: no digit typed into the sentence, so the cap cannot drift from the copy`).not.toMatch(/\d/);
      const rendered = createErrorText({ code: "youtube_channel_busy", holder: null }, (k, vars) => {
        const raw = dict(l)[k]!;
        return Object.entries(vars ?? {}).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), raw);
      });
      expect(rendered, `${l}: the cap is in the sentence a customer reads`).toContain(String(YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL));
      expect(rendered, `${l}: no placeholder left on screen`).not.toMatch(/[{}]/);
      checked++;
    }
    expect(checked, "all four locales").toBe(LOCALES.length);
  });

  it("another cap would be in the copy too — the number is read from the constant at render, not baked into the sentence", () => {
    // `createErrorText` passes `{max}` to every refusal's message; a key without the placeholder ignores it (so the other sentences
    // are unchanged), and the busy one fills it. Prove both halves with a recording `msg`.
    const seen: Array<{ key: string; vars: Record<string, string | number> | undefined }> = [];
    createErrorText({ code: "youtube_channel_busy", holder: null }, (key, vars) => (seen.push({ key, vars }), key));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe(KEY);
    expect(seen[0]!.vars).toEqual({ max: YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL });
    // A refusal whose sentence has no placeholder stays word-for-word its dictionary entry.
    for (const l of LOCALES) {
      const unavailable = createErrorText({ code: "youtube_unavailable", holder: null }, (k, vars) =>
        Object.entries(vars ?? {}).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), dict(l)[k]!));
      expect(unavailable, l).toBe(dict(l)["stream.error.youtube_unavailable"]);
    }
  });
});

describe("the copy follows the constant, not a typed number", () => {
  it("with the cap moved to a number nothing in the code spells, the busy sentence says THAT number in every locale", async () => {
    const MOVED = 7;
    expect(MOVED, "premise: not the real cap, so a typed literal cannot pass for the constant").not.toBe(YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL);
    vi.resetModules();
    vi.doMock("../youtube", async (original) => ({ ...(await original<typeof import("../youtube")>()), YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL: MOVED }));
    try {
      const moved = await import("../stream-session-view");
      let checked = 0;
      for (const l of LOCALES) {
        const text = moved.createErrorText({ code: "youtube_channel_busy", holder: null }, (k, vars) =>
          Object.entries(vars ?? {}).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), dict(l)[k]!));
        expect(text, `${l}: says the moved cap`).toContain(String(MOVED));
        expect(text, `${l}: and not the real one`).not.toContain(String(YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL));
        checked++;
      }
      expect(checked).toBe(LOCALES.length);
    } finally {
      vi.doUnmock("../youtube");
      vi.resetModules();
    }
  });
});

describe("isYoutubeUrl: the mark rides only on a link that goes to YouTube", () => {
  const YES = [
    "https://www.youtube.com/watch?v=abc",
    "https://youtube.com/watch?v=abc",
    "https://m.youtube.com/watch?v=abc",
    "https://studio.youtube.com/video/abc/livestreaming",
    "https://youtu.be/abc",
    "https://YOUTU.BE/abc",
    "https://WWW.YouTube.com/live/abc",
  ];
  const NO = [
    "https://www.twitch.tv/videos/1",
    "https://example.com/watch?v=abc",
    "https://notyoutube.com/watch?v=abc",          // suffix without the dot boundary
    "https://youtube.com.evil.example/watch",      // youtube.com as a LABEL of another domain
    "https://evil.example/youtube.com",            // youtube.com only in the path
    "https://evil.example/?u=https://youtu.be/abc",
    "http://www.youtube.com/watch?v=abc",          // not https
    "ftp://youtube.com/abc",
    "javascript:alert(1)//youtube.com",
    "//www.youtube.com/watch?v=abc",               // no scheme: not a parseable absolute URL
    "www.youtube.com/watch?v=abc",
    "https://",
    "",
    "not a url",
  ];

  it("accepts every YouTube host form and rejects every look-alike", () => {
    let checked = 0;
    for (const u of YES) { expect(isYoutubeUrl(u), u).toBe(true); checked++; }
    for (const u of NO) { expect(isYoutubeUrl(u), u).toBe(false); checked++; }
    expect(checked, "anti-vacuity: every row was asserted").toBe(YES.length + NO.length);
    expect(YES.length).toBeGreaterThan(5);
    expect(NO.length).toBeGreaterThan(10);
  });
});
