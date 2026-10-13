// T16 — the held queue's copy (external-play-held-copy.ts): one chip title and
// one sentence for EVERY member of the needs_reason vocabulary, in all four
// locales. The vocabulary is read from its declaration (`NEEDS_REASONS`, the
// list V439/V441's CHECK pins), never typed here, so a new reason fails this
// sweep until it has its copy. Pure: no DB, no render.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { NEEDS_REASONS, type NeedsReason } from "@/server/external-play/types";
import { HELD_TITLE_KEYS, heldBody, namesByColour } from "../external-play-held-copy";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;

const SEATS = ["white", "black", "both", null] as const;
const NAMES = { whiteName: "Rafael Quintero", blackName: "Mei Lin Chu" };

/** Every sentence a held card can show: each reason, and token_revoked once
 *  per seat V442 admits (plus unknown). */
function everyBody(): { label: string; reason: NeedsReason; key: string; vars?: { name: string } }[] {
  const out: { label: string; reason: NeedsReason; key: string; vars?: { name: string } }[] = [];
  for (const reason of NEEDS_REASONS) {
    const seats = reason === "token_revoked" ? SEATS : ([null] as const);
    for (const seat of seats) {
      const b = heldBody({ reason, revokedSeat: seat, ...NAMES });
      out.push({ label: `${reason}/${seat ?? "-"}`, reason, key: b.key, vars: b.vars });
    }
  }
  return out;
}

describe("held copy: every reason, every locale", () => {
  it("the vocabulary itself is not empty (12 reasons at V441) — the sweeps below are not vacuous", () => {
    expect(NEEDS_REASONS.length).toBeGreaterThanOrEqual(12);
  });

  it("a chip title per reason: present in each locale, translated, and distinct from every other reason's — counted", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const seen = new Map<string, NeedsReason>();
      for (const reason of NEEDS_REASONS) {
        const text = DICTS[l][HELD_TITLE_KEYS[reason]];
        expect(text, `${l} ${reason}`).toBeTruthy();
        if (l !== "en") expect(text, `${l} ${reason}: translated`).not.toBe(DICTS.en[HELD_TITLE_KEYS[reason]]);
        expect(seen.get(text!), `${l}: ${reason} reads the same as`).toBeUndefined();
        seen.set(text!, reason);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * NEEDS_REASONS.length);
  });

  it("a sentence per reason (and per revoked seat): present, translated, its {name} filled — counted", () => {
    const bodies = everyBody();
    expect(bodies.length, "12 reasons + 3 more token_revoked seats").toBe(NEEDS_REASONS.length + SEATS.length - 1);
    let checked = 0;
    for (const l of LOCALES) {
      for (const b of bodies) {
        const raw = DICTS[l][b.key];
        expect(raw, `${l} ${b.label} (${b.key})`).toBeTruthy();
        if (l !== "en") expect(raw, `${l} ${b.label}: translated`).not.toBe(DICTS.en[b.key]);
        // A sentence that takes a name has the slot, in every locale; one that
        // does not, has none to leave raw.
        expect(raw!.includes("{name}"), `${l} ${b.label}: the {name} slot`).toBe(b.vars !== undefined);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * everyBody().length);
  });

  it("the English chip titles, as the design names them (canvas HoldQueue + the T16 brief) — not derived from the map", () => {
    // Typed from the design, so a key pointed at the wrong sentence fails here.
    const EXPECTED: Record<NeedsReason, string> = {
      no_show_white: "White didn't check in",
      no_show_black: "Black didn't check in",
      no_show_both: "Nobody checked in",
      not_started: "Game never started",
      aborted: "Game aborted",
      mismatch: "Accounts don't match",
      provider_error: "Lichess couldn't be read",
      token_revoked: "Lichess link revoked",
      double_walkover_blocked: "Double no-show",
      create_outcome_unknown: "Game may already exist",
      tiebreak_owed: "Winner to be decided",
      fair_play: "Fair-play ending",
    };
    let checked = 0;
    for (const reason of NEEDS_REASONS) {
      expect(DICTS.en[HELD_TITLE_KEYS[reason]], reason).toBe(EXPECTED[reason]);
      checked++;
    }
    expect(checked).toBe(NEEDS_REASONS.length);
  });

  it("a revoked token is NEVER a no-show (design §3.6): each seat's sentence says so, and none is a no-show's sentence", () => {
    const noShow = new Set(
      (["no_show_white", "no_show_black", "no_show_both", "double_walkover_blocked"] as const).map((r) => heldBody({ reason: r, revokedSeat: null, ...NAMES }).key),
    );
    let checked = 0;
    for (const seat of SEATS) {
      const b = heldBody({ reason: "token_revoked", revokedSeat: seat, ...NAMES });
      expect(noShow.has(b.key), `${seat}`).toBe(false);
      expect(DICTS.en[b.key], `${seat}`).toContain("This is not a no-show.");
      checked++;
    }
    expect(checked).toBe(SEATS.length);
  });

  it("the name a sentence carries is the seat's own, by colour: White's for white, Black's for black, nobody's for both or unknown", () => {
    const cases: [NeedsReason, (typeof SEATS)[number], string | undefined][] = [
      ["no_show_white", null, "Rafael Quintero"],
      ["no_show_black", null, "Mei Lin Chu"],
      ["token_revoked", "white", "Rafael Quintero"],
      ["token_revoked", "black", "Mei Lin Chu"],
      ["token_revoked", "both", undefined],
      ["token_revoked", null, undefined],
    ];
    let checked = 0;
    for (const [reason, seat, name] of cases) {
      expect(heldBody({ reason, revokedSeat: seat, ...NAMES }).vars?.name, `${reason}/${seat}`).toBe(name);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("names by colour follow the side that plays White — both ways", () => {
    expect(namesByColour({ whiteSide: "home", homeName: "H", awayName: "A" })).toEqual({ whiteName: "H", blackName: "A" });
    expect(namesByColour({ whiteSide: "away", homeName: "H", awayName: "A" })).toEqual({ whiteName: "A", blackName: "H" });
  });

  it("no generic fallback exists to paint over a drift: the retired keys are gone from every locale", () => {
    const RETIRED = [
      "externalPlay.reason.generic",
      "externalPlay.reason.noShow",
      "externalPlay.reason.delayUnsupported",
      "externalPlay.reason.unfinished",
      "externalPlay.reason.linkMissing",
      "externalPlay.resolve.homeForfeit",
      "externalPlay.resolve.awayForfeit",
    ];
    let checked = 0;
    for (const l of LOCALES) {
      for (const k of RETIRED) {
        expect(DICTS[l][k], `${l} ${k}`).toBeUndefined();
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * RETIRED.length);
  });
});

describe("FINDING (T16): `mismatch` has no producer", () => {
  // The vocabulary carries `mismatch` (V439) and the queue has its copy, but
  // no writer in the server holds a board for it: every other reason is read
  // back through its real producer in the sweep/result suites (T16
  // `expectQueued`); this one cannot be. Pinned so the day a producer lands,
  // this fails and its real-producer read-back is written.
  it("the literal appears only in the vocabulary's declaration — across every non-test server source of online play, counted", () => {
    const root = join(__dirname, "..", "..", "..");
    const dirs = [join(root, "server", "external-play"), join(root, "server", "usecases", "external-play")];
    const files: string[] = [];
    const visit = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (e.name !== "__tests__") visit(join(d, e.name));
        } else if (e.name.endsWith(".ts")) files.push(join(d, e.name));
      }
    };
    dirs.forEach(visit);
    expect(files.length, "anti-vacuity: sources scanned").toBeGreaterThan(10);
    const writers = files.filter((f) => /["'`]mismatch["'`]/.test(readFileSync(f, "utf8"))).map((f) => relative(root, f));
    expect(writers).toEqual([join("server", "external-play", "types.ts")]);
  });
});
