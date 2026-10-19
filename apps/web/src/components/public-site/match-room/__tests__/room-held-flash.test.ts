// PR #990 review, I1 + re-review N1: the room HOLDS the Lichess outcome it was landed with (the address bar loses `?lichess=`
// as soon as it is read, and the server page may be re-read under it), so how long it is held is a rule of its own. The
// rule, pure:
//   - only a FAILURE is held: a `linked` landing is no sentence a later revoke / re-consent card may stand under;
//   - it is drawn only ON a card that offers the link (relink, revoked);
//   - it is HELD through the screens that come BEFORE the card - the check-in, a closed window, a camera card - until the
//     seat call answers "link required", or the loop returns for a player who was never linked;
//   - once it has been on a card and the screen leaves the cards, it is gone for the page's life: a LATER card is a new
//     event, and the old sentence does not belong to it;
//   - and an UNSEEN one is spent the moment the room shows the link works - the seat taken, or the creating / live / held /
//     over screens (N1): a revoke card that comes later must not show an old failure as if it were fresh.
// room-lichess-flash-sequence.test.tsx drives the same rule through the real shell.
import { describe, expect, it } from "vitest";
import { LICHESS_FLASH_CODES } from "@/lib/lichess-link";
import { flashPhase, flashScreenKinds, heldFlashFrom, nextHeldFlash, settledScreenKinds, type FlashPhase, type HeldFlash } from "../room-held-flash";
import type { RoomScreen } from "../room-screen";

const FAILURES = LICHESS_FLASH_CODES.filter((c) => c !== "linked");

/** Every screen kind, declared here against the type: a kind added to RoomScreen fails to compile until it is listed. */
const KINDS: Record<RoomScreen["kind"], true> = {
  unavailable: true,
  noAccount: true,
  repairing: true,
  offForClub: true,
  revoked: true,
  seatHeld: true,
  relink: true,
  wrongAccount: true,
  over: true,
  held: true,
  live: true,
  notOpened: true,
  batchWait: true,
  cameraRequired: true,
  cameraLost: true,
  cameraBlocked: true,
  videoDown: true,
  creating: true,
  closed: true,
  boardClosed: true,
  checkin: true,
};
const ALL = Object.keys(KINDS) as RoomScreen["kind"][];

describe("heldFlashFrom - what the room holds when it is landed", () => {
  it("a failure is held, unseen; linked, junk and the empty case hold nothing", () => {
    let held = 0;
    for (const code of FAILURES) {
      expect(heldFlashFrom(code), code).toEqual({ code, seen: false });
      held++;
    }
    expect(held, "anti-vacuity: every failure code").toBe(LICHESS_FLASH_CODES.length - 1);
    let none = 0;
    for (const v of ["linked", null, undefined, "", "made-up", "Already_Linked"]) {
      expect(heldFlashFrom(v), JSON.stringify(v)).toEqual({ code: null, seen: false });
      none++;
    }
    expect(none).toBe(6);
  });
});

describe("flashPhase - where in the sequence a screen puts the held outcome", () => {
  it("the two screens that offer the link are the CARD; creating / live / held / over are SETTLED; every other screen is BEFORE", () => {
    expect([...flashScreenKinds].sort()).toEqual(["relink", "revoked"]);
    expect([...settledScreenKinds].sort()).toEqual(["creating", "held", "live", "over"]);
    const seen: Record<FlashPhase, number> = { card: 0, settled: 0, before: 0 };
    for (const kind of ALL) {
      const want: FlashPhase = kind === "relink" || kind === "revoked" ? "card" : ["creating", "live", "held", "over"].includes(kind) ? "settled" : "before";
      expect(flashPhase(kind, false), kind).toBe(want);
      seen[want]++;
    }
    expect(ALL.length, "anti-vacuity: every screen kind swept").toBe(21);
    expect(seen).toEqual({ card: 2, settled: 4, before: 15 });
  });

  it("a seated answer settles every screen the room can show beside it - except a card, which keeps its place", () => {
    let checked = 0;
    for (const kind of ALL) {
      const expected: FlashPhase = kind === "relink" || kind === "revoked" ? "card" : "settled";
      expect(flashPhase(kind, true), `${kind}, seated`).toBe(expected);
      checked++;
    }
    expect(checked).toBe(21);
  });
});

describe("nextHeldFlash - the sequence", () => {
  const unseen = (code: HeldFlash["code"]): HeldFlash => ({ code, seen: false });

  it("the empty case first: nothing held stays nothing in every phase (and is the SAME object - no needless render)", () => {
    const none = unseen(null);
    for (const phase of ["card", "settled", "before"] as const) expect(nextHeldFlash(none, phase), phase).toBe(none);
  });

  it("held through the screens BEFORE the card: a check-in, a closed window or a camera card does not spend it", () => {
    const h = unseen("already_linked");
    expect(nextHeldFlash(h, "before"), "still before the card: nothing changes").toBe(h);
  });

  it("the card marks it seen; a screen that stays on a card (relink -> revoked) keeps it", () => {
    const onCard = nextHeldFlash(unseen("already_linked"), "card");
    expect(onCard).toEqual({ code: "already_linked", seen: true });
    expect(nextHeldFlash(onCard, "card"), "card to card: unchanged, the same object").toBe(onCard);
  });

  it("leaving the cards after it was seen clears it for good - a LATER card does not get the old sentence", () => {
    const onCard = nextHeldFlash(unseen("already_linked"), "card");
    for (const away of ["before", "settled"] as const) {
      const left = nextHeldFlash(onCard, away);
      expect(left, away).toEqual({ code: null, seen: false });
      // The revoked card that comes later on the same page:
      expect(nextHeldFlash(left, "card"), `${away}, then a later card`).toEqual({ code: null, seen: false });
    }
  });

  // N1: the code was never seen, because the player's link worked all along (seated, creating, live, held, over).
  it("an UNSEEN outcome is spent the moment the room settles - and a later card is not handed it", () => {
    let swept = 0;
    for (const code of FAILURES) {
      const spent = nextHeldFlash(unseen(code), "settled");
      expect(spent, `${code}: spent unseen`).toEqual({ code: null, seen: false });
      expect(nextHeldFlash(spent, "card").code, `${code}: and the revoke card that comes later gets nothing`).toBeNull();
      swept++;
    }
    expect(swept, "anti-vacuity").toBe(FAILURES.length);
  });

  it("every failure code follows the whole sequence: check-in, camera card, card, card, away, card again", () => {
    let swept = 0;
    for (const code of FAILURES) {
      let h = heldFlashFrom(code);
      h = nextHeldFlash(h, "before");
      h = nextHeldFlash(h, "before");
      expect(h.code, `${code}: held through the screens before the card`).toBe(code);
      h = nextHeldFlash(h, "card");
      expect(h, `${code}: seen on the card`).toEqual({ code, seen: true });
      h = nextHeldFlash(h, "card");
      expect(h.code, `${code}: still there on the next card screen`).toBe(code);
      h = nextHeldFlash(h, "before");
      expect(h.code, `${code}: gone once away from the cards`).toBeNull();
      h = nextHeldFlash(h, "card");
      expect(h.code, `${code}: and not back on a later card`).toBeNull();
      swept++;
    }
    expect(swept, "anti-vacuity").toBe(FAILURES.length);
  });

  it("a linked landing holds nothing through the same sequence - there is nothing to show above a later revoke", () => {
    let h = heldFlashFrom("linked");
    for (const phase of ["before", "card", "card", "settled", "card"] as const) h = nextHeldFlash(h, phase);
    expect(h).toEqual({ code: null, seen: false });
  });
});
