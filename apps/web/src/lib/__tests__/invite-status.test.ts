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
  SEAT_WORD_KEYS,
  seatInviteWords,
  seatWords,
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

// G-2 (phase 3 wave 1, T4): a chess invite is now an ACCOUNT's mail. Its row carries `recipient_user_id`, and the address on the row
// is the one the account had when the row was queued (or was rewritten to at send, when the key was clean). The seat's current
// mailbox is whatever the account has NOW, so matching by address alone reads a mail that went out (or is still on its way) to
// the old address as "Not delivered". A seat matches its rows by the player's user id first, and falls back to the address only
// when the row or the seat has no user id.
describe("seatInviteWords: an account's mail follows the account, not the address (G-2)", () => {
  const U1 = "11111111-1111-4111-8111-111111111111";
  const U2 = "22222222-2222-4222-8222-222222222222";
  const old = (status: OutboxStatus, userId: string | null = U1) => ({ recipient: "old@x", status, recipientUserId: userId });

  it("a mail sent to the OLD address is the seat's word after the player changed address (D2)", () => {
    // Every status that carries an outcome, so the test cannot pass on a single lucky word. Expected words come from the
    // existing status -> word map; the point of this test is WHICH row answers, not what the words are.
    let checked = 0;
    for (const status of OUTBOX_STATUSES) {
      const word = inviteWordOf(status);
      if (word === null) continue; // `replaced` is never an answer
      // `stamped: false`: a row that ended badly says `not_delivered` itself, and with a held stamp the fallback for "no matching row"
      // says the same word. Unstamped, the fallback is `not_invited`, so a row that failed to match cannot pass as its own word.
      const got = seatInviteWords({ rows: [old(status)], mailboxes: [{ email: "new@x", userId: U1 }], stamped: false });
      expect(got, status).toEqual([word]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every status but `replaced`").toBe(OUTBOX_STATUSES.length - 1);
  });

  it("a row still queued at the old address reads as the queued word, not Not delivered", () => {
    const got = seatInviteWords({ rows: [old("queued")], mailboxes: [{ email: "new@x", userId: U1 }], stamped: true });
    expect(got).toEqual([inviteWordOf("queued")]);
    expect(got, "the two words differ, so the test can tell a match from the stamp's fallback").not.toEqual(["not_delivered"]);
  });

  it("the same two rows without the user id on either side read as before: the address is the key (the mutant's witness)", () => {
    // The old behaviour, kept for a row or a seat that has no user id.
    expect(seatInviteWords({ rows: [old("sent", null)], mailboxes: [{ email: "new@x", userId: U1 }], stamped: true })).toEqual(["not_delivered"]);
    expect(seatInviteWords({ rows: [old("sent")], mailboxes: ["new@x"], stamped: true })).toEqual(["not_delivered"]);
  });

  it("a row with no user id still matches its seat by address, folded (a literal-kind or phase-1 row)", () => {
    const row = { recipient: "  A@X ", status: "delivered" as const, recipientUserId: null };
    expect(seatInviteWords({ rows: [row], mailboxes: [{ email: "a@x", userId: U1 }], stamped: false })).toEqual(["delivered"]);
    // `recipientUserId` left out entirely is the same row (a caller that predates the column).
    expect(seatInviteWords({ rows: [{ recipient: "a@x", status: "delivered" }], mailboxes: [{ email: "a@x", userId: U1 }], stamped: false })).toEqual(["delivered"]);
  });

  it("a seat with no user id matches a row that has one by address (the seat is the side without an account)", () => {
    const row = { recipient: "a@x", status: "sent" as const, recipientUserId: U1 };
    expect(seatInviteWords({ rows: [row], mailboxes: ["A@x"], stamped: false })).toEqual(["sent"]);
    expect(seatInviteWords({ rows: [row], mailboxes: [{ email: "A@x", userId: null }], stamped: false })).toEqual(["sent"]);
  });

  it("two DIFFERENT accounts never share a row, even at one address: the previous player's mail is not this seat's word", () => {
    // Account U1 left the seat; U2 now sits on it and has since taken the address U1 once had. Both ids are known, they differ.
    const row = { recipient: "shared@x", status: "delivered" as const, recipientUserId: U1 };
    expect(seatInviteWords({ rows: [row], mailboxes: [{ email: "shared@x", userId: U2 }], stamped: false })).toEqual(["not_invited"]);
    expect(seatInviteWords({ rows: [row], mailboxes: [{ email: "shared@x", userId: U2 }], stamped: true })).toEqual(["not_delivered"]);
  });

  it("a user-id match wins over an address match: the account's row answers, not a stranger's row at its new address", () => {
    // U1 changed address to new@x. A row for U1 sits at old@x (sent); a stale row for ANOTHER account sits at new@x (bounced).
    const rows = [
      { recipient: "new@x", status: "bounced" as const, recipientUserId: U2 },
      old("sent"),
    ];
    expect(seatInviteWords({ rows, mailboxes: [{ email: "new@x", userId: U1 }], stamped: true })).toEqual(["sent"]);
    expect(seatInviteWords({ rows: [...rows].reverse(), mailboxes: [{ email: "new@x", userId: U1 }], stamped: true })).toEqual(["sent"]);
  });

  it("two accounts on one seat: one word each, in mailbox order, each matched by its own id", () => {
    const rows = [
      { recipient: "a-old@x", status: "bounced" as const, recipientUserId: U1 },
      { recipient: "b@x", status: "sent" as const, recipientUserId: U2 },
    ];
    const seat = (order: "ab" | "ba") => {
      const a = { email: "a-new@x", userId: U1 };
      const b = { email: "b@x", userId: U2 };
      return order === "ab" ? [a, b] : [b, a];
    };
    expect(seatInviteWords({ rows, mailboxes: seat("ab"), stamped: true })).toEqual(["bounced", "sent"]);
    expect(seatInviteWords({ rows, mailboxes: seat("ba"), stamped: true })).toEqual(["sent", "bounced"]);
  });

  it("two live rows for one account: the later row in `rows` answers (callers pass newest last), whatever the addresses", () => {
    const first = { recipient: "old@x", status: "delivered" as const, recipientUserId: U1 };
    const second = { recipient: "mid@x", status: "bounced" as const, recipientUserId: U1 };
    const mailboxes = [{ email: "new@x", userId: U1 }];
    expect(seatInviteWords({ rows: [first, second], mailboxes, stamped: true })).toEqual(["bounced"]);
    expect(seatInviteWords({ rows: [second, first], mailboxes, stamped: true })).toEqual(["delivered"]);
  });

  it("a replaced row is dropped on the id path too; the empty case still falls to the stamp", () => {
    const mailboxes = [{ email: "new@x", userId: U1 }];
    expect(seatInviteWords({ rows: [old("replaced")], mailboxes, stamped: true })).toEqual(["not_delivered"]);
    expect(seatInviteWords({ rows: [old("replaced")], mailboxes, stamped: false })).toEqual(["not_invited"]);
    expect(seatInviteWords({ rows: [], mailboxes, stamped: false })).toEqual(["not_invited"]);
    expect(seatInviteWords({ rows: [old("replaced"), old("sent")], mailboxes, stamped: true })).toEqual(["sent"]);
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

// Task 16 D2: the waiting list and the reopen/reinvite confirmation must give a seat ONE word. `seatWords` is the helper both read;
// its answers are typed here from the rule (a seat that is here shows only "Here"; one that is not shows its invite words in order;
// a seat the loader could not read shows nothing), not read back from the function.
describe("seatWords: the one answer for what a seat shows (Task 16 D2)", () => {
  it("empty cases first: no seat at all, and a seat that is not here with no readable mail, show nothing", () => {
    expect(seatWords(null)).toEqual([]);
    expect(seatWords({ here: false, invites: [] })).toEqual([]);
  });

  it("a seat that is here shows 'here' and none of its invite words, whatever they were", () => {
    const every: SeatInviteWord[] = [...INVITE_WORDS, "not_invited"];
    expect(seatWords({ here: true, invites: [] })).toEqual(["here"]);
    expect(seatWords({ here: true, invites: every })).toEqual(["here"]);
  });

  it("a seat that is not here shows its invite words, in the order it holds them (one per mailbox)", () => {
    const every: SeatInviteWord[] = [...INVITE_WORDS, "not_invited"];
    let checked = 0;
    for (const word of every) {
      expect(seatWords({ here: false, invites: [word] }), word).toEqual([word]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: six words").toBe(6);
    expect(seatWords({ here: false, invites: ["sent", "bounced"] })).toEqual(["sent", "bounced"]);
    expect(seatWords({ here: false, invites: ["bounced", "sent"] }), "order is kept, not sorted").toEqual(["bounced", "sent"]);
  });

  it("returns a copy: the seat's own list is not handed out to be changed", () => {
    const invites: SeatInviteWord[] = ["sent"];
    const out = seatWords({ here: false, invites });
    out.push("bounced");
    expect(invites).toEqual(["sent"]);
  });
});

describe("SEAT_WORD_KEYS", () => {
  it("is the invite words' keys plus 'here', one key each, and every key resolves in all four locales", () => {
    expect(SEAT_WORD_KEYS.here).toBe("arbiter.column.here");
    for (const w of [...INVITE_WORDS, "not_invited"] as const) expect(SEAT_WORD_KEYS[w], w).toBe(INVITE_WORD_KEYS[w]);
    let checked = 0;
    for (const locale of LOCALES) {
      for (const key of Object.values(SEAT_WORD_KEYS)) {
        expect((DICTS[locale]![key] ?? "").trim().length, `${locale}: ${key}`).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 7 words x 4 locales").toBe(28);
  });
});
