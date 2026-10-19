// PR #990 review, I1: the room HOLDS the Lichess outcome it was landed with (the address bar loses `?lichess=` as soon as it
// is read, and the server page is refreshed under it), so how long it is held is a rule of its own. The rule, pure:
//   - only a FAILURE is held: a `linked` landing is no sentence a later revoke / re-consent card may stand under;
//   - it is drawn only ON a card that offers the link (relink, revoked) - and it is held through the screens that come
//     BEFORE the card (the check-in, until the seat call answers "link required"), or the loop returns for a player who
//     was never linked;
//   - once it has been on a card and the screen leaves the cards, it is gone for the page's life: a LATER card is a new
//     event, and the old sentence does not belong to it.
// room-lichess-flash-sequence.test.tsx drives the same rule through the real shell.
import { describe, expect, it } from "vitest";
import { LICHESS_FLASH_CODES } from "@/lib/lichess-link";
import { heldFlashFrom, flashScreenKinds, nextHeldFlash, onFlashScreen, type HeldFlash } from "../room-held-flash";
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

describe("onFlashScreen - the screens that carry the outcome", () => {
  it("exactly the two that offer the Lichess link (card 8 and seam A), and no other of the room's screens", () => {
    expect([...flashScreenKinds].sort()).toEqual(["relink", "revoked"]);
    const kinds = Object.keys(KINDS) as RoomScreen["kind"][];
    let on = 0;
    for (const kind of kinds) {
      const expected = kind === "relink" || kind === "revoked";
      expect(onFlashScreen(kind), kind).toBe(expected);
      if (expected) on++;
    }
    expect(kinds.length, "anti-vacuity: every screen kind swept").toBe(21);
    expect(on).toBe(2);
  });
});

describe("nextHeldFlash - the sequence", () => {
  const unseen = (code: HeldFlash["code"]): HeldFlash => ({ code, seen: false });

  it("the empty case first: nothing held stays nothing, on a card or off it (and is the SAME object - no needless render)", () => {
    const none = unseen(null);
    expect(nextHeldFlash(none, true)).toBe(none);
    expect(nextHeldFlash(none, false)).toBe(none);
  });

  it("held through the screens BEFORE the card: a check-in does not spend it", () => {
    const h = unseen("already_linked");
    expect(nextHeldFlash(h, false), "still the check-in: nothing changes").toBe(h);
  });

  it("the card marks it seen; a screen that stays on a card (relink -> revoked) keeps it", () => {
    const onCard = nextHeldFlash(unseen("already_linked"), true);
    expect(onCard).toEqual({ code: "already_linked", seen: true });
    expect(nextHeldFlash(onCard, true), "card to card: unchanged, the same object").toBe(onCard);
  });

  it("leaving the cards after it was seen clears it for good - a LATER card does not get the old sentence", () => {
    const onCard = nextHeldFlash(unseen("already_linked"), true);
    const left = nextHeldFlash(onCard, false);
    expect(left).toEqual({ code: null, seen: false });
    // The revoked card that comes later on the same page:
    expect(nextHeldFlash(left, true)).toEqual({ code: null, seen: false });
  });

  it("every failure code follows the whole sequence: check-in, card, card, away, card again", () => {
    let swept = 0;
    for (const code of FAILURES) {
      let h = heldFlashFrom(code);
      h = nextHeldFlash(h, false);
      expect(h.code, `${code}: held through the check-in`).toBe(code);
      h = nextHeldFlash(h, true);
      expect(h, `${code}: seen on the card`).toEqual({ code, seen: true });
      h = nextHeldFlash(h, true);
      expect(h.code, `${code}: still there on the next card screen`).toBe(code);
      h = nextHeldFlash(h, false);
      expect(h.code, `${code}: gone once away from the cards`).toBeNull();
      h = nextHeldFlash(h, true);
      expect(h.code, `${code}: and not back on a later card`).toBeNull();
      swept++;
    }
    expect(swept, "anti-vacuity").toBe(FAILURES.length);
  });

  it("a linked landing holds nothing through the same sequence - there is nothing to show above a later revoke", () => {
    let h = heldFlashFrom("linked");
    for (const onCard of [false, true, true, false, true]) h = nextHeldFlash(h, onCard);
    expect(h).toEqual({ code: null, seen: false });
  });
});
