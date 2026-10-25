// The invite words the arbiter sees for a seat: what the chess invite's email outbox rows say, in five words, plus
// "Not invited" for a seat nobody has written to (spec docs/superpowers/specs/2026-10-24-arbiter-round-column-design.md,
// 6.1 and 6.2).
//
// Pure and client-safe: it reads the outbox's status VOCABULARY (a type-only import of `constants.ts`, which has no
// imports of its own) and nothing from the database. The loader hands it the newest row per recipient.
//
// The list is closed. No word says, or implies, "opened": the outbox does not know whether anyone read the mail.
import type { DictionaryKey } from "@/lib/i18n-keys";
import type { OutboxStatus } from "@/server/email-outbox/constants";

export const INVITE_WORDS = ["sent", "delivered", "delayed", "bounced", "not_delivered"] as const;
export type InviteWord = (typeof INVITE_WORDS)[number];

/** A seat shows one of the five words per recipient, or `not_invited` when no mail was ever queued for it. */
export type SeatInviteWord = InviteWord | "not_invited";

/** The words that mean the seat's stamp is still held: the mail is on its way or has arrived. The other two
 *  (`bounced`, `not_delivered`) mean the stamp is released. The test cross-checks this against `seatOutcome` and the
 *  hook's `SEAT_HOLDING_STATUSES`, which are what actually hold and release a seat. */
export const HOLDING_WORDS: readonly InviteWord[] = ["sent", "delivered", "delayed"];

/** `not_invited` is the run sheet's existing key, on purpose (pre-flight C2): one string per locale, so the arbiter
 *  column and the run sheet cannot drift apart. */
export const INVITE_WORD_KEYS: Readonly<Record<SeatInviteWord, DictionaryKey>> = {
  sent: "arbiter.invite.sent",
  delivered: "arbiter.invite.delivered",
  delayed: "arbiter.invite.delayed",
  bounced: "arbiter.invite.bounced",
  not_delivered: "arbiter.invite.notDelivered",
  not_invited: "runsheet.round.notInvited",
};

/** What one seat shows: "Here" (it has checked in) or an invite word. */
export type SeatWord = "here" | SeatInviteWord;

/** The key of each seat word. `here` is the column's own "Here"; the invite words are `INVITE_WORD_KEYS`, spread rather than copied, so
 *  the waiting list and the reopen/reinvite confirmation can never word one state two ways. */
export const SEAT_WORD_KEYS: Readonly<Record<SeatWord, DictionaryKey>> = { here: "arbiter.column.here", ...INVITE_WORD_KEYS };

/**
 * The words a seat shows, the ONE answer the waiting list and the confirmation of the round's invite press both read (Task 16 D2:
 * the confirmation used to word a seat from the run sheet's stamp line, "Not invited", while the list said "Not delivered").
 *
 *  - A seat that is here shows "here" and nothing else: its invite is moot once the player has arrived.
 *  - A seat that is not here shows its invite words, in the order the loader gave them (one per current mailbox that has mail).
 *  - Nothing to show: no seat at all (`null`: the board's seats could not be read), or a seat whose mail the loader had no word for.
 *
 * Returns a new array; the caller may keep it.
 */
export function seatWords(seat: { here: boolean; invites: readonly SeatInviteWord[] } | null): SeatWord[] {
  if (seat === null) return [];
  return seat.here ? ["here"] : [...seat.invites];
}

/**
 * The word for one outbox status (spec 6.1). Total over `OutboxStatus`: the `never` check in the default arm makes a
 * thirteenth status a compile error here, so it cannot be left without a word by accident.
 *
 * `null` for `replaced` only: a superseded row is never an answer, because a newer row carries the outcome.
 */
export function inviteWordOf(status: OutboxStatus): InviteWord | null {
  switch (status) {
    // It arrived. A complaint is a recipient marking delivered mail as spam, and the hook keeps the seat stamped.
    case "delivered":
    case "complained":
      return "delivered";
    // Resend accepted it; no delivery event yet.
    case "sent":
      return "sent";
    // `queued` and `sending` have not been accepted by Resend yet. "Sent" would claim a send that has not happened (the
    // outbox's anti-goal), and "Delayed" is true and holds the seat, as `seatOutcome` does (`retrying`).
    case "delayed":
    case "queued":
    case "sending":
      return "delayed";
    // Named apart from "Not delivered" because the fix is different: the address is wrong.
    case "bounced":
      return "bounced";
    case "failed":
    case "suppressed":
    case "expired":
    case "dead":
      return "not_delivered";
    case "replaced":
      return null;
    default: {
      const unhandled: never = status;
      throw new Error(`inviteWordOf: no word for outbox status ${String(unhandled)}`);
    }
  }
}

/** One authority for "the same mailbox": the outbox stores the address as typed, and the seat's address may differ in case
 *  or padding (pre-flight C1). Both sides go through this and nothing else. */
const foldMailbox = (address: string): string => address.trim().toLowerCase();

/**
 * The words one seat shows (spec 6.2): one per current mailbox that has mail, in mailbox order.
 *
 *  - Only the seat's CURRENT mailboxes count. A board re-paired after an Unpair keeps its fixture-and-colour ref, so the
 *    previous player's rows are still there and must not read as the new player's.
 *  - A `replaced` row is dropped (it has no word); a live row for the same recipient still answers.
 *  - `rows` is the newest row per recipient, as `latestEmailStatus` returns it. Callers pass RAW addresses.
 *  - If two live rows still fold to one mailbox, the LATER one in `rows` answers, so a caller orders its rows oldest
 *    first (newest last). It can happen: that query de-duplicates on `lower(recipient)` and does not trim, so
 *    `" A@x "` and `"a@x"` are two rows to SQL and one mailbox here.
 *  - A mailbox with no row of its own gets no word while a sibling mailbox has one: the seat shows only the mail that
 *    exists (spec 6.2 item 3). "Not delivered" and "Not invited" speak for a seat with NO mail left (items 4 and 5).
 *  - No mail left for the seat: "Not delivered" if the seat is stamped (a held stamp with no mail is the same as every row
 *    having ended badly, which is what `seatOutcome([])` says), otherwise "Not invited".
 */
export function seatInviteWords(seat: {
  rows: readonly { recipient: string; status: OutboxStatus }[];
  mailboxes: readonly string[];
  stamped: boolean;
}): SeatInviteWord[] {
  const wordByMailbox = new Map<string, InviteWord>();
  for (const row of seat.rows) {
    const word = inviteWordOf(row.status);
    if (word === null) continue; // a `replaced` row is never an answer
    wordByMailbox.set(foldMailbox(row.recipient), word);
  }

  const words: SeatInviteWord[] = [];
  const counted = new Set<string>();
  for (const mailbox of seat.mailboxes) {
    const key = foldMailbox(mailbox);
    if (counted.has(key)) continue; // one word per recipient, however many times the seat lists the address
    counted.add(key);
    const word = wordByMailbox.get(key);
    if (word !== undefined) words.push(word);
  }
  if (words.length > 0) return words;
  return [seat.stamped ? "not_delivered" : "not_invited"];
}
