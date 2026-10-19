// T16 — the held queue's copy (external-play-held-copy.ts): one chip title and
// one sentence for EVERY member of the needs_reason vocabulary, in all four
// locales. The vocabulary is read from its declaration (`NEEDS_REASONS`, the
// list V451/V453's CHECK pins), never typed here, so a new reason fails this
// sweep until it has its copy. Pure: no DB, no render.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { NEEDS_REASONS, SEAT_HOLD_REASONS, type NeedsReason } from "@/server/external-play/types";
import { HELD_TITLE_KEYS, heldBody, namesByColour } from "../external-play-held-copy";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;

const SEATS = ["white", "black", "both", null] as const;
const NAMES = { whiteName: "Rafael Quintero", blackName: "Mei Lin Chu" };

/** Every sentence a held card can show: each reason, and each SEAT hold
 *  (token_revoked, account_changed — read from their declaration) once per
 *  seat V454 admits (plus unknown). */
function everyBody(): { label: string; reason: NeedsReason; key: string; vars?: { name: string } }[] {
  const out: { label: string; reason: NeedsReason; key: string; vars?: { name: string } }[] = [];
  for (const reason of NEEDS_REASONS) {
    const seats = (SEAT_HOLD_REASONS as readonly string[]).includes(reason) ? SEATS : ([null] as const);
    for (const seat of seats) {
      const b = heldBody({ reason, revokedSeat: seat, ...NAMES });
      out.push({ label: `${reason}/${seat ?? "-"}`, reason, key: b.key, vars: b.vars });
    }
  }
  return out;
}

describe("held copy: every reason, every locale", () => {
  it("the vocabulary itself is not empty (13 reasons at V453, P11) — the sweeps below are not vacuous", () => {
    expect(NEEDS_REASONS.length).toBeGreaterThanOrEqual(13);
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
    expect(SEAT_HOLD_REASONS, "the seat holds the sweep widens (final re-review P11 (1))").toEqual(["token_revoked", "account_changed"]);
    expect(bodies.length, "13 reasons + 3 more seats for each of the 2 seat holds").toBe(NEEDS_REASONS.length + SEAT_HOLD_REASONS.length * (SEATS.length - 1));
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
      // Final review P11 (the brief: "an organiser hold account_changed").
      account_changed: "Lichess account changed",
      // T17B fix 2, D11 + controller ruling (2026-10-14): the organiser is confirming it, never "not confirmed" — the
      // player's room reads "Time's up — your organiser is confirming the result"; the desk asks for that confirmation.
      clock_flag_unsettled: "Time's up — confirm the result",
    };
    let checked = 0;
    for (const reason of NEEDS_REASONS) {
      expect(DICTS.en[HELD_TITLE_KEYS[reason]], reason).toBe(EXPECTED[reason]);
      checked++;
    }
    expect(checked).toBe(NEEDS_REASONS.length);
  });

  it("final review P11: the account change's sentence is its own, as the brief words it — not another hold's", () => {
    // No seat recorded: a create in flight (no colours yet), where the hold freezes both seats.
    const b = heldBody({ reason: "account_changed", revokedSeat: null, ...NAMES });
    expect(DICTS.en[b.key]).toBe(
      "A player linked a different Lichess account while this game was being played or set up. It can no longer be played from Seazn. The game may still be running on Lichess.",
    );
    expect(b.vars, "it names nobody: no seat is recorded").toBeUndefined();
  });

  it("final re-review P11 (2): the account change names the seat it froze — White's or Black's player by name, the opponent left able to play; both seats names nobody — counted", () => {
    // Typed from the ruling (P11 (1): the opponent plays on; P11 (2): name the side), not read from the map.
    const EXPECTED = {
      white: "Rafael Quintero (White) linked a different Lichess account during this game, so their moves can no longer be made from Seazn. The game may still be running on Lichess.",
      black: "Mei Lin Chu (Black) linked a different Lichess account during this game, so their moves can no longer be made from Seazn. The game may still be running on Lichess.",
      // "both" is reached by a second seat hold widening the first, or a provider error on a held board — so it names
      // the first cause only, and says what is true of every path: neither seat plays from Seazn.
      both: "A player linked a different Lichess account during this game, and neither player's moves can now be made from Seazn. The game may still be running on Lichess.",
    } as const;
    const tokenKeys = new Set(SEATS.map((seat) => heldBody({ reason: "token_revoked", revokedSeat: seat, ...NAMES }).key));
    const keys = new Set<string>();
    let checked = 0;
    for (const seat of ["white", "black", "both"] as const) {
      const b = heldBody({ reason: "account_changed", revokedSeat: seat, ...NAMES });
      const en = DICTS.en[b.key]!.replace("{name}", b.vars?.name ?? "{name}");
      expect(en, seat).toBe(EXPECTED[seat]);
      expect(tokenKeys.has(b.key), `${seat}: not a revoked token's sentence`).toBe(false);
      keys.add(b.key);
      checked++;
    }
    keys.add(heldBody({ reason: "account_changed", revokedSeat: null, ...NAMES }).key);
    expect(keys.size, "four seats, four sentences").toBe(4);
    expect(checked).toBe(3);
  });

  it("fix round 2b: a revoked token on BOTH seats blames no one — true of every path that widens a hold to both — counted", () => {
    // Typed from the ruling. "both" is reached by two revokes, but also by a provider error or an account change on the
    // OTHER seat widening a one-seat revoke, so "Both players revoked…" can be false. The sentence says only what is
    // true of every path: neither seat plays from Seazn, it is not a no-show, the game may still run on Lichess.
    const RULED = {
      en: "Neither player's moves can now be made from Seazn. This is not a no-show. The game may still be running on Lichess.",
      es: "Ya ninguno de los dos jugadores puede hacer jugadas desde Seazn. No es una incomparecencia. Puede que la partida siga en curso en Lichess.",
      fr: "Aucun des deux joueurs ne peut plus jouer de coups depuis Seazn. Ce n'est pas un forfait. La partie se poursuit peut-être sur Lichess.",
      nl: "Geen van beide spelers kan nog zetten doen vanuit Seazn. Dit is geen no-show. De partij loopt misschien nog op Lichess.",
    } as const;
    // The revoke verb each locale's one-seat sentence uses — proven present there, so refusing it below can fail.
    const BLAME = { en: "revoked", es: "revoc", fr: "retiré", nl: "ingetrokken" } as const;
    const both = heldBody({ reason: "token_revoked", revokedSeat: "both", ...NAMES });
    const oneSeat = heldBody({ reason: "token_revoked", revokedSeat: null, ...NAMES });
    expect(both.vars, "it names nobody").toBeUndefined();
    let checked = 0;
    for (const l of LOCALES) {
      expect(DICTS[l][both.key], l).toBe(RULED[l]);
      expect(DICTS[l][oneSeat.key], `${l}: the one-seat sentence carries the verb`).toContain(BLAME[l]);
      expect(DICTS[l][both.key]!.toLowerCase(), `${l}: no one is said to have revoked`).not.toContain(BLAME[l]);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
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
      ["account_changed", "white", "Rafael Quintero"],
      ["account_changed", "black", "Mei Lin Chu"],
      ["account_changed", "both", undefined],
      ["account_changed", null, undefined],
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
  // The vocabulary carries `mismatch` (V451) and the queue has its copy, but
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

describe("D11 + D13 (controller ruling): the player's flag card and the organiser's desk chip agree", () => {
  it("in every locale both open with the same time's-up clause, the desk never says 'not confirmed' — counted", () => {
    const lead = (s: string) => s.split(/\s[—:]\s|:\s/)[0]!.trim();
    let checked = 0;
    for (const l of LOCALES) {
      const room = DICTS[l]["externalPlay.room.flag.organiser"]!;
      const desk = DICTS[l][HELD_TITLE_KEYS.clock_flag_unsettled]!;
      expect([room, desk].every(Boolean), l).toBe(true);
      expect(lead(desk), `${l}: "${desk}" vs "${room}"`).toBe(lead(room));
      expect(desk.length, `${l}: the clause is not the whole line`).toBeGreaterThan(lead(desk).length);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    // The ruling's English, typed from it (never read from the dictionary first).
    expect(DICTS.en["externalPlay.room.flag.organiser"]).toBe("Time's up — your organiser is confirming the result");
    expect(DICTS.en[HELD_TITLE_KEYS.clock_flag_unsettled]!.toLowerCase()).not.toContain("not confirmed");
  });
});
