// Invite words: what the arbiter sees for a seat's chess invite (spec 2026-10-24-arbiter-round-column-design.md, 6.1/6.2).
//
// Expected values come from the rulebook, never from the code under test:
//  - the word for each status is typed below from spec 6.1's table (and the table is checked to cover every non-replaced
//    status the outbox declares, so a thirteenth status cannot slip past it);
//  - "does this word hold the seat" is asked of the shipped classifier `seatOutcome` and the hook's
//    `SEAT_HOLDING_STATUSES`, which are what actually stamp and release a seat.
import { describe, expect, it } from "vitest";
import { LIVE_STATUSES, OUTBOX_STATUSES, type OutboxStatus } from "@/server/email-outbox/constants";
import { seatOutcome } from "@/server/usecases/external-play/invite";
import { SEAT_HOLDING_STATUSES } from "@/server/usecases/external-play/invite-outbox-hook";
import { LOCALES } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import {
  HOLDING_WORDS,
  INVITE_WORDS,
  INVITE_WORD_KEYS,
  inviteWordOf,
  seatInviteWords,
  type InviteWord,
  type SeatInviteWord,
} from "../invite-status";

/** Spec 6.1, row for row. `Record<Exclude<...>>` makes tsc refuse a thirteenth status that this table lacks. */
const SPEC_6_1: Readonly<Record<Exclude<OutboxStatus, "replaced">, InviteWord>> = {
  delivered: "delivered",
  complained: "delivered",
  sent: "sent",
  delayed: "delayed",
  queued: "delayed",
  sending: "delayed",
  bounced: "bounced",
  failed: "not_delivered",
  suppressed: "not_delivered",
  expired: "not_delivered",
  dead: "not_delivered",
};

/** The characters the column's copy may never carry (spec 9): em dash, and the three arrows. Built from code points so
 *  the test source itself holds no dash or arrow. */
const FORBIDDEN_CHARS = [0x2014, 0x2192, 0x2190, 0x2197].map((code) => String.fromCharCode(code));

const DICTS: Readonly<Record<string, Readonly<Record<string, string>>>> = { en, es, fr, nl };

describe("inviteWordOf", () => {
  it("is total over OUTBOX_STATUSES: every status but `replaced` has one of the five words, `replaced` has none", () => {
    let checked = 0;
    for (const s of OUTBOX_STATUSES) {
      const word = inviteWordOf(s);
      if (s === "replaced") {
        expect(word, "a replaced row is never an answer").toBeNull();
      } else {
        expect(INVITE_WORDS, `[${s}] -> ${String(word)}`).toContain(word);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every status of the outbox vocabulary").toBe(OUTBOX_STATUSES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("a status outside the vocabulary is refused loudly, never answered with undefined (the exhaustive arm)", () => {
    // The `never` check makes a thirteenth status a compile error; this is the runtime half, for a value that got past
    // the types (a row written by a newer migration than this build).
    expect(() => inviteWordOf("thirteenth" as OutboxStatus)).toThrow(/thirteenth/);
  });

  it("the five words, as spec 6.1 rules", () => {
    // The word list is closed at five (spec 6.1); typed here, not read back from INVITE_WORDS.
    expect([...INVITE_WORDS]).toEqual(["sent", "delivered", "delayed", "bounced", "not_delivered"]);
    // The table is complete: it names every status except `replaced`, and nothing else.
    expect(Object.keys(SPEC_6_1).sort()).toEqual(OUTBOX_STATUSES.filter((s) => s !== "replaced").sort());
    // ... and it uses all five words, so a missing word cannot hide behind a short table.
    expect([...new Set(Object.values(SPEC_6_1))].sort()).toEqual([...INVITE_WORDS].sort());

    let checked = 0;
    for (const [status, want] of Object.entries(SPEC_6_1) as [OutboxStatus, InviteWord][]) {
      expect(inviteWordOf(status), status).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: all eleven answering statuses").toBe(OUTBOX_STATUSES.length - 1);
  });

  it("a holding word exactly when seatOutcome holds the seat", () => {
    let checked = 0;
    let holding = 0;
    let released = 0;
    for (const s of OUTBOX_STATUSES) {
      if (s === "replaced") continue;
      const word = inviteWordOf(s);
      expect(word, s).not.toBeNull();
      const isHoldingWord = HOLDING_WORDS.includes(word as InviteWord);
      // The classifier (invited | retrying hold the seat, failed releases it) ...
      expect(isHoldingWord, `${s} -> ${String(word)} vs seatOutcome([${s}])`).toBe(seatOutcome([s]) !== "failed");
      // ... and the hook's own list, which is what actually releases the stamp.
      expect(isHoldingWord, `${s} -> ${String(word)} vs SEAT_HOLDING_STATUSES`).toBe(SEAT_HOLDING_STATUSES.includes(s));
      if (isHoldingWord) holding += 1;
      else released += 1;
      checked += 1;
    }
    expect(checked, "anti-vacuity: every status that answers").toBe(OUTBOX_STATUSES.length - 1);
    expect(checked).toBeGreaterThan(0);
    // Both sides of the equivalence were exercised, or a constant answer would pass.
    expect(holding, "statuses with a holding word").toBeGreaterThan(0);
    expect(released, "statuses with a releasing word").toBeGreaterThan(0);
  });

  it("the e2e kit's holding list is the hook's (C3)", () => {
    // Task 12's kit builds its list as [...LIVE_STATUSES, "complained"]; this pins the hook to that expression.
    expect([...SEAT_HOLDING_STATUSES]).toEqual([...LIVE_STATUSES, "complained"]);
  });
});

describe("seatInviteWords", () => {
  it("empty case first: no rows is Not invited before the stamp and Not delivered after it", () => {
    expect(seatInviteWords({ rows: [], mailboxes: ["a@x"], stamped: false })).toEqual(["not_invited"]);
    const stamped = seatInviteWords({ rows: [], mailboxes: ["a@x"], stamped: true });
    expect(stamped).toEqual(["not_delivered"]);
    // A held stamp with no mail reads like a seat whose every row ended badly: seatOutcome([]) is `failed`.
    expect(seatOutcome([])).toBe("failed");
    expect(stamped).toEqual([inviteWordOf("failed")]);
  });

  it("empty case, no mailbox at all (a seat with no linked address)", () => {
    expect(seatInviteWords({ rows: [], mailboxes: [], stamped: false })).toEqual(["not_invited"]);
    expect(seatInviteWords({ rows: [], mailboxes: [], stamped: true })).toEqual(["not_delivered"]);
    // A row for an address the seat no longer has counts for nothing, whatever the mailbox list.
    expect(seatInviteWords({ rows: [{ recipient: "a@x", status: "delivered" }], mailboxes: [], stamped: false })).toEqual([
      "not_invited",
    ]);
  });

  it("only the seat's current mailboxes count, folded on both sides (C1)", () => {
    const row = { recipient: "Old@X", status: "delivered" as const };
    // A re-paired board: the previous player's mail is not this seat's word.
    expect(seatInviteWords({ rows: [row], mailboxes: ["new@x"], stamped: false })).toEqual(["not_invited"]);
    // ... and a stamped seat whose only mail belongs to someone else is a seat nobody could reach.
    expect(seatInviteWords({ rows: [row], mailboxes: ["new@x"], stamped: true })).toEqual(["not_delivered"]);
    // The same row, matched through case and whitespace on the mailbox side.
    expect(seatInviteWords({ rows: [row], mailboxes: [" OLD@x "], stamped: false })).toEqual(["delivered"]);
    // The converse: a lower-case mailbox against a mixed-case, padded stored recipient.
    expect(
      seatInviteWords({ rows: [{ recipient: "  Old@X ", status: "bounced" }], mailboxes: ["old@x"], stamped: false }),
    ).toEqual(["bounced"]);
  });

  it("a replaced row is dropped, never given a word (C1)", () => {
    // Only a replaced row: nothing answers, so the stamp decides.
    expect(seatInviteWords({ rows: [{ recipient: "a@x", status: "replaced" }], mailboxes: ["a@x"], stamped: true })).toEqual([
      "not_delivered",
    ]);
    expect(seatInviteWords({ rows: [{ recipient: "a@x", status: "replaced" }], mailboxes: ["a@x"], stamped: false })).toEqual([
      "not_invited",
    ]);
    // A replaced row beside the live one for the same recipient, in either order: the live row answers.
    const replaced = { recipient: "a@x", status: "replaced" as const };
    const live = { recipient: "A@x", status: "delivered" as const };
    expect(seatInviteWords({ rows: [replaced, live], mailboxes: ["a@x"], stamped: true })).toEqual(["delivered"]);
    expect(seatInviteWords({ rows: [live, replaced], mailboxes: ["a@x"], stamped: true })).toEqual(["delivered"]);
  });

  it("one word per recipient, in mailbox order (not row order)", () => {
    const rows = [
      { recipient: "b@x", status: "bounced" as const },
      { recipient: "a@x", status: "sent" as const },
    ];
    expect(seatInviteWords({ rows, mailboxes: ["a@x", "b@x"], stamped: true })).toEqual(["sent", "bounced"]);
    expect(seatInviteWords({ rows, mailboxes: ["b@x", "a@x"], stamped: true })).toEqual(["bounced", "sent"]);
  });

  it("a mailbox listed twice (any case) is one recipient, so one word", () => {
    expect(
      seatInviteWords({
        rows: [{ recipient: "a@x", status: "delivered" }],
        mailboxes: ["a@x", " A@X"],
        stamped: true,
      }),
    ).toEqual(["delivered"]);
  });

  it("two mailboxes, one row: exactly that row's word, no chip for the rowless sibling (spec 6.2 item 3)", () => {
    const rows = [{ recipient: "a@x", status: "sent" as const }];
    // Stamped or not, and whichever side of the mailbox list the rowless address sits on.
    expect(seatInviteWords({ rows, mailboxes: ["a@x", "b@x"], stamped: true })).toEqual(["sent"]);
    expect(seatInviteWords({ rows, mailboxes: ["b@x", "a@x"], stamped: true })).toEqual(["sent"]);
    expect(seatInviteWords({ rows, mailboxes: ["a@x", "b@x"], stamped: false })).toEqual(["sent"]);
    // The stamp speaks only for a seat with NO mail left: two rowless mailboxes are still one word, not two.
    expect(seatInviteWords({ rows: [], mailboxes: ["a@x", "b@x"], stamped: true })).toEqual(["not_delivered"]);
    expect(seatInviteWords({ rows: [], mailboxes: ["a@x", "b@x"], stamped: false })).toEqual(["not_invited"]);
  });

  it("two live rows folding to one mailbox: the later row in `rows` answers (callers pass newest last)", () => {
    // The two words differ, so the test can tell which row won; both orders are driven.
    const padded = { recipient: " A@x ", status: "delivered" as const };
    const plain = { recipient: "a@x", status: "bounced" as const };
    expect(seatInviteWords({ rows: [padded, plain], mailboxes: ["a@x"], stamped: true })).toEqual(["bounced"]);
    expect(seatInviteWords({ rows: [plain, padded], mailboxes: ["a@x"], stamped: true })).toEqual(["delivered"]);
    // One word either way, never one per row.
    expect(seatInviteWords({ rows: [padded, plain], mailboxes: ["a@x"], stamped: true })).toHaveLength(1);
  });

  it("every status through the seat, one row each: the word is spec 6.1's, and `replaced` falls to the stamp", () => {
    // Expected from the typed spec table, not from inviteWordOf; `replaced` is not in the table, so it falls to the stamp.
    const specWord: Partial<Record<OutboxStatus, InviteWord>> = SPEC_6_1;
    let checked = 0;
    for (const status of OUTBOX_STATUSES) {
      const rows = [{ recipient: "p@x", status }];
      const got = seatInviteWords({ rows, mailboxes: ["p@x"], stamped: true });
      expect(got, status).toEqual([specWord[status] ?? "not_delivered"]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every status of the outbox vocabulary").toBe(OUTBOX_STATUSES.length);
  });
});

describe("INVITE_WORD_KEYS", () => {
  it('"Not invited" is the run sheet\'s existing key, and there is no second copy of it', () => {
    expect(INVITE_WORD_KEYS.not_invited).toBe("runsheet.round.notInvited");
    for (const locale of LOCALES) {
      expect(Object.keys(DICTS[locale]!), `${locale}: one key for "Not invited"`).not.toContain("arbiter.invite.notInvited");
    }
  });

  it("has a key for every word the seat can show, and all of them resolve in all four locales", () => {
    const seatWords: SeatInviteWord[] = [...INVITE_WORDS, "not_invited"];
    expect(Object.keys(INVITE_WORD_KEYS).sort()).toEqual([...seatWords].sort());
    expect([...LOCALES].sort(), "the dictionaries imported here are every locale").toEqual(Object.keys(DICTS).sort());

    let checked = 0;
    for (const locale of LOCALES) {
      for (const word of seatWords) {
        const value = DICTS[locale]![INVITE_WORD_KEYS[word]];
        expect(typeof value, `${locale}: ${INVITE_WORD_KEYS[word]}`).toBe("string");
        expect((value ?? "").trim().length, `${locale}: ${INVITE_WORD_KEYS[word]}`).toBeGreaterThan(0);
        for (const ch of FORBIDDEN_CHARS) expect(value, `${locale}: ${INVITE_WORD_KEYS[word]}`).not.toContain(ch);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: six words in each of four locales").toBe(seatWords.length * LOCALES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the help line exists in all four locales, with no dash or arrow in any of them", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const help = DICTS[locale]!["arbiter.invite.help"];
      expect(typeof help, locale).toBe("string");
      for (const ch of FORBIDDEN_CHARS) expect(help, `${locale}: U+${ch.charCodeAt(0).toString(16)}`).not.toContain(ch);
      checked += 1;
    }
    expect(checked).toBe(LOCALES.length);
    // Real translations, not four copies of the English.
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      expect(DICTS[locale]!["arbiter.invite.help"], `${locale} is translated`).not.toBe(en["arbiter.invite.help" as keyof typeof en]);
    }
  });
});
