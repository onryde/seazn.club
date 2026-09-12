import { describe, expect, it } from "vitest";
import {
  crestMonogram,
  kindEyebrow,
  parseScoreline,
  scoreboardFor,
  TONE_ON_DARK,
  TONE_ON_LIGHT,
} from "@/lib/news-presentation";

// SPEC-2 signature: a result post IS a scorebug. The parse pulls the two sides +
// numerals back out of the "{home} {a}–{b} {away}" title so the card/hero can
// render the scoreline — and it must REFUSE anything that is not a clean numeric
// score, so a manual "news" post never mangles into a broken scorebug.
describe("parseScoreline", () => {
  it("splits a football scoreline on the en dash", () => {
    expect(parseScoreline("Riverside 3–1 Northside")).toEqual({
      home: "Riverside",
      homeScore: "3",
      awayScore: "1",
      away: "Northside",
    });
  });

  it("keeps multi-word side names", () => {
    expect(parseScoreline("Home United 2–0 Away Rangers")).toEqual({
      home: "Home United",
      homeScore: "2",
      awayScore: "0",
      away: "Away Rangers",
    });
  });

  it("accepts slash/decimal scores (cricket totals)", () => {
    expect(parseScoreline("A CC 252/8–140 B CC")).toEqual({
      home: "A CC",
      homeScore: "252/8",
      awayScore: "140",
      away: "B CC",
    });
  });

  it("returns null for a non-numeric side (cricket overs, forfeit words)", () => {
    expect(parseScoreline("A CC 252/8 (50)–140 B CC")).toBeNull();
    expect(parseScoreline("Rovers W/O City")).toBeNull();
  });

  it("returns null for a plain headline with no scoreline", () => {
    expect(parseScoreline("New season kicks off Saturday")).toBeNull();
  });
});

describe("scoreboardFor", () => {
  it("scorebugs only result posts", () => {
    expect(scoreboardFor("result", "Riverside 3–1 Northside")).not.toBeNull();
    // A round recap title is prose — never a scorebug even if it contained a dash.
    expect(scoreboardFor("round_recap", "Round 3 recap: Prem")).toBeNull();
    expect(scoreboardFor("announcement", "Riverside 3–1 Northside")).toBeNull();
    expect(scoreboardFor("news", "Riverside 3–1 Northside")).toBeNull();
  });
});

describe("kindEyebrow", () => {
  it("maps each kind to its tone + label key", () => {
    expect(kindEyebrow("result")).toEqual({ labelKey: "news.kind.result", tone: "lime" });
    expect(kindEyebrow("round_recap")).toEqual({ labelKey: "news.kind.recap", tone: "white" });
    expect(kindEyebrow("announcement")).toEqual({
      labelKey: "news.kind.announcement",
      tone: "red",
    });
    expect(kindEyebrow("news")).toEqual({ labelKey: "news.kind.news", tone: "muted" });
  });
});

describe("crestMonogram", () => {
  it("takes up to two initials", () => {
    expect(crestMonogram("Riverside Rovers")).toBe("RR");
    expect(crestMonogram("City")).toBe("C");
    expect(crestMonogram("  ")).toBe("?");
  });
});

describe("the eyebrow tones, by the ground they are painted on", () => {
  // WHY THIS EXISTS. The tone vocabulary was written for the night-mode slab,
  // and three surfaces then copied ONE map between them. Two used the dark
  // values on a LIGHT card: `white` is `#f7f5fb` against `bg-surface`'s
  // `#ffffff` — about 1.07:1 — so a `round_recap` or `weekly_digest` post with
  // no hero rendered its eyebrow invisible. Observed live on the news feed,
  // not inferred from the source.
  //
  // `apps/web` vitest is `environment: "node"`, so a contrast RATIO cannot be
  // computed here. What is checkable, and what actually broke, is that the two
  // grounds do not share a value for the tones whose whole job is contrast.

  it("no tone paints the same on both grounds except the deliberately neutral one", () => {
    // `muted` is `text-ink-muted` on both by design — a token that already
    // resolves per ground. Every other tone MUST differ, because a tone that
    // is identical on white and on the court slab is one of the two by
    // accident, which is exactly the bug.
    for (const tone of ["lime", "white", "red"] as const) {
      expect(TONE_ON_DARK[tone], tone).not.toBe(TONE_ON_LIGHT[tone]);
    }
    expect(TONE_ON_LIGHT.muted).toBe(TONE_ON_DARK.muted);
  });

  it("the light ground never uses a near-white ink", () => {
    // The specific failure: `white` resolving to `text-court-ink` (#f7f5fb) on
    // a white card. Pinned by NAME rather than by ratio — the token is the
    // thing that was wrong, and it is the thing a future copy-paste would
    // reintroduce.
    expect(TONE_ON_LIGHT.white).toBe("text-ink");
    expect(Object.values(TONE_ON_LIGHT)).not.toContain("text-court-ink");
    // …and its positive pair: on the SLAB, white really is the near-white ink.
    expect(TONE_ON_DARK.white).toBe("text-court-ink");
  });
});
