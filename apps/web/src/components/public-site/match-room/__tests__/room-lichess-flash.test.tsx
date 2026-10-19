// Owner staging test, 2026-10-19: a failed Lichess link was SILENT in the match room. The callback landed on
// `…/play?t=…&lichess=already_linked` (that Lichess account belongs to a DIFFERENT Seazn account), the room never read
// `?lichess=`, and the same Re-link card came back - so the player looped for ever.
//
// This is what the room PAINTS for the outcome (real dictionaries, every locale): the outcome sentence on the link /
// re-link card in an error tone (a `linked` landing says nothing here: it must never stand over a later revoke), and for
// already_linked the next step.
// The page's read of the param is page.test.tsx's, the strip of the address bar is room-lichess-strip.test.tsx's, and
// the real browser is match-room.spec.ts's.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider, usePlural, useT } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import { LICHESS_FLASH_CODES } from "@/lib/lichess-link";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { RoomShell, Screen } from "../room-shell";
import { initialRoomState, type RoomState } from "../room-state";
import { roomScreen } from "../room-screen";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";

const LOCALES = { en, es, fr, nl } as const;
type Locale = keyof typeof LOCALES;
const d = (l: Locale) => LOCALES[l] as Record<string, string>;
const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const FIXTURE = "/shared/org/comp/div/fixtures/f1";
const SELF = `${FIXTURE}/play?t=eyJhbGciOiJIUzI1NiJ9.payload-with_chars.sig`;
const RELINK = "/api/auth/lichess?org=org&next=%2Fshared%2Forg%2Fcomp%2Fdiv%2Ffixtures%2Ff1%2Fplay";

const GAME: RoomGame = {
  gameId: "g1",
  moves: [],
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  lastMove: null,
  turn: "white",
  whiteMs: 600_000,
  blackMs: 600_000,
  clockAsOf: null,
  clockRunning: false,
  drawOfferBy: null,
  over: false,
};
function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    fixtureId: "f1",
    serverNow: new Date(T0).toISOString(),
    phase: "open",
    scheduledAt: null,
    roundOpenedAt: null,
    opensAt: null,
    deadline: null,
    links: { fixture: FIXTURE, standings: "/shared/org/comp/div" },
    meta: { divisionName: "Open Rapid", roundNo: 3, boardNo: 2, limitSeconds: 600, incrementSeconds: 5 },
    orgSlug: "org",
    you: { colour: "white", name: "Ada Okonkwo", checkedIn: false },
    opponent: { colour: "black", name: "Bo Lind", checkedIn: false },
    cameraPolicy: "off",
    opponentCamera: null,
    ownParticipantId: null,
    frozen: null,
    canAct: false,
    otherAccount: null,
    account: { state: "ok" },
    onlineChessOff: false,
    boardClosed: false,
    creation: null,
    game: null,
    held: false,
    result: null,
    watchUrl: null,
    heldUntil: null,
    realtime: null,
    ...over,
  };
}
/** Card 8: the seat call asked for a link - the screen the owner looped on. */
const relinkState = (over: Partial<RoomSnapshot> = {}): RoomState => ({
  ...initialRoomState(snap(over), T0),
  seat: { seated: false, reason: "lichess_link_required", participant: null },
});
/** Seam A: the viewer's own seat frozen (a revoked link) - its notice also offers a re-link. */
const revokedState = (over: Partial<RoomSnapshot> = {}): RoomState =>
  initialRoomState(snap({ game: GAME, frozen: "you", canAct: false, ...over }), T0);

function Painted({ state, flash }: { state: RoomState; flash?: string | null }) {
  const t = useT();
  const plural = usePlural();
  const noop = async () => null;
  return (
    <Screen
      screen={roomScreen(state)}
      state={state}
      room={{ state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never}
      camera={{ status: "live", stream: null, enable: () => {} }}
      presence={null}
      busy={false}
      tryAgain={() => {}}
      relinkHref={RELINK}
      selfPath={SELF}
      lichessFlash={flash as never}
      locale="en"
      t={t as never}
      plural={plural as never}
      reload={() => {}}
    />
  );
}
function paint(state: RoomState, flash?: string | null, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <Painted state={state} flash={flash} />
    </DictProvider>,
  );
}
/** The WHOLE shell, as the page mounts it: a refused grant (P10) is the relink card at once. */
function paintShell(flash: string | null | undefined, locale: Locale = "en", over: Partial<RoomSnapshot> = {}): string {
  return renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <RoomShell initial={snap(over)} token="tok" selfPath={SELF} grantRefused lichessFlash={flash as never} />
    </DictProvider>,
  );
}
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
const textFrom = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const screenOf = (html: string) => /data-testid="match-room" data-screen="([^"]+)"/.exec(html)?.[1];
const FLASH_IDS = ["lichess-flash", "lichess-flash-text", "lichess-flash-next"];
/** The markup between two test ids: is `inner` drawn inside `outer`'s open tag and before `before`? */
const posOf = (html: string, id: string) => html.indexOf(`data-testid="${id}"`);

describe("the link / re-link card says how the Lichess link went", () => {
  it("already_linked on card 8: the sentence AND the next step, above the Re-link button, which is still there", () => {
    const html = paint(relinkState(), "already_linked");
    expect(roomScreen(relinkState()).kind).toBe("relink");
    expect(html).toContain(esc(en["settings.account.lichess.flash.already_linked"]));
    expect(html).toContain(esc(en["settings.account.lichess.flashNext.already_linked"]));
    expect(ids(html)).toEqual(expect.arrayContaining(["room-state-relink", "lichess-flash", "lichess-flash-text", "lichess-flash-next", "room-relink"]));
    // On the card: after the card opens, before its action.
    expect(posOf(html, "room-state-relink")).toBeLessThan(posOf(html, "lichess-flash"));
    expect(posOf(html, "lichess-flash")).toBeLessThan(posOf(html, "room-relink"));
    expect(html).toContain('data-tone="error"');
    expect(html).toMatch(/role="alert"/);
    // The way forward the sentence names ("link a different one here") is the same button as before, aimed at the same start.
    expect(html).toContain(`href="${esc(RELINK)}"`);
  });

  it("already_linked on seam A's notice (a revoked link): the same sentence and next step, inside the notice, above its action", () => {
    const html = paint(revokedState(), "already_linked");
    expect(roomScreen(revokedState()).kind).toBe("revoked");
    expect(html).toContain(esc(en["settings.account.lichess.flash.already_linked"]));
    expect(html).toContain(esc(en["settings.account.lichess.flashNext.already_linked"]));
    expect(posOf(html, "room-revoked-notice")).toBeLessThan(posOf(html, "lichess-flash"));
    expect(posOf(html, "lichess-flash")).toBeLessThan(posOf(html, "room-revoked-relink"));
  });

  // PR #990 review, I1: the room says only what FAILED. A `linked` landing has no sentence on either card - the room
  // holds the outcome for the page's life, and "Lichess account linked." must never stand above a LATER "Your Lichess
  // link was revoked" (the sequence is room-lichess-flash-sequence.test.tsx's). The register card refuses it for the
  // same reason (register-lichess-card.test.tsx).
  it("linked: NOTHING on either card - not a status, not a sentence - and the card is exactly what it is with no outcome", () => {
    let checked = 0;
    for (const state of [relinkState(), revokedState()]) {
      const html = paint(state, "linked");
      expect(html).toBe(paint(state, null));
      expect(html).not.toContain(esc(en["settings.account.lichess.flash.linked"]));
      for (const id of FLASH_IDS) expect(ids(html), id).not.toContain(id);
      expect(html).toMatch(/room-relink|room-revoked-relink/);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("every failure code says its own sentence on the card as an alert; only already_linked adds a next step", () => {
    let checked = 0;
    for (const code of LICHESS_FLASH_CODES.filter((c) => c !== "linked")) {
      for (const state of [relinkState(), revokedState()]) {
        const html = paint(state, code);
        expect(html, code).toContain(esc(en[`settings.account.lichess.flash.${code}` as keyof typeof en]));
        expect(html, code).toContain('data-tone="error"');
        expect(html.includes('data-testid="lichess-flash-next"'), `${code}: next step only for already_linked`).toBe(code === "already_linked");
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every failure on both surfaces").toBe(2 * (LICHESS_FLASH_CODES.length - 1));
  });

  it("the empty case: no outcome, an unknown one, or a hand-typed one draws NOTHING - the card is exactly what it was", () => {
    for (const state of [relinkState(), revokedState()]) {
      const bare = paint(state, null);
      expect(bare).toBe(paint(state, undefined));
      let checked = 0;
      for (const v of ["", "Linked", "already_linked ", "<script>alert(1)</script>", "made-up"]) {
        const html = paint(state, v);
        expect(html, JSON.stringify(v)).toBe(bare);
        for (const id of FLASH_IDS) expect(ids(html), `${JSON.stringify(v)}: ${id}`).not.toContain(id);
        checked++;
      }
      expect(checked).toBe(5);
      expect(bare, "and the card itself is there").toMatch(/room-relink|room-revoked-relink/);
    }
  });

  it("it stands only where the loop was: not on the check-in, not on the wrong-account card (which says whose board it is)", () => {
    const checkin = paint(initialRoomState(snap(), T0), "already_linked");
    expect(roomScreen(initialRoomState(snap(), T0)).kind).toBe("checkin");
    for (const id of FLASH_IDS) expect(ids(checkin), `check-in: ${id}`).not.toContain(id);

    const wrong = relinkState({ account: { state: "wrong_account", viewerEmail: "bob@example.test" } });
    expect(roomScreen(wrong).kind).toBe("wrongAccount");
    const html = paint(wrong, "already_linked");
    for (const id of FLASH_IDS) expect(ids(html), `wrong account: ${id}`).not.toContain(id);
    expect(html).not.toContain(esc(en["settings.account.lichess.flash.already_linked"]));
  });

  it("never shows the other Seazn account's email or name: the only address on the page is none (the card has no viewer address)", () => {
    const text = textFrom(paint(relinkState(), "already_linked"));
    expect(text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).toEqual([]);
    expect(textFrom(paint(revokedState(), "already_linked")).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).toEqual([]);
  });

  it("every locale: its own words for the sentence and the next step on the card, no raw key", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const html = paint(relinkState(), "already_linked", locale);
      expect(html, `${locale}: sentence`).toContain(esc(d(locale)["settings.account.lichess.flash.already_linked"]!));
      expect(html, `${locale}: next step`).toContain(esc(d(locale)["settings.account.lichess.flashNext.already_linked"]!));
      expect(textFrom(html), `${locale}: raw key`).not.toMatch(/settings\.account\.lichess\.flash/);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

// Owner requirement (2026-10-19): the already_linked message must NOT show the Lichess username, nor anything about the
// other Seazn account (name, email or id) - the server does not know whose it is, and the callback's landing carries the code
// alone (lichess-oauth-routes.test.ts). What the card can say is therefore asserted as EQUALITY with the dictionary's own words.
describe("the re-link card names nobody", () => {
  const norm = (s: string) => unescapeText(s).replace(/\s+/g, " ").trim();
  const unescapeText = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  const cardOf = (html: string) => /<section[^>]*data-testid="room-state-relink"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";

  it("card 8 with already_linked is exactly: title, the outcome, the next step, the consent copy, the action - in every locale", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const dict = d(locale);
      // A snapshot full of recognisable identities: none may reach the card (the card is not handed any, and says so by equality).
      const state = relinkState({
        you: { colour: "white", name: "Ada Okonkwo", checkedIn: true },
        opponent: { colour: "black", name: "Mallory Other", checkedIn: true },
      });
      const card = cardOf(paint(state, "already_linked", locale));
      expect(card, locale).not.toBe("");
      const want = [
        "settings.account.lichess.consent.title",
        "settings.account.lichess.flash.already_linked",
        "settings.account.lichess.flashNext.already_linked",
        "settings.account.lichess.consent.body",
        "settings.account.lichess.consent.scopes",
        "settings.account.lichess.consent.cta",
      ]
        .map((k) => dict[k]!)
        .join(" ");
      expect(norm(card.replace(/<[^>]+>/g, " ")), locale).toBe(norm(want));
      for (const sentinel of ["Mallory Other", "Ada Okonkwo", "@", "ada_plays", "u-other"]) {
        expect(norm(card.replace(/<[^>]+>/g, " ")), `${locale}: ${sentinel}`).not.toContain(sentinel);
      }
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the outcome block alone, on the revoked notice too, is the two sentences and nothing else (the notice's own account line is the game's, not this message's)", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const html = paint(revokedState(), "already_linked", locale);
      const block = /data-testid="lichess-flash"[\s\S]*?data-testid="lichess-flash-next"[^>]*>[^<]*<\/p>/.exec(html)?.[0] ?? "";
      expect(block, locale).not.toBe("");
      const text = norm(block.replace(/<[^>]+>/g, " ").replace(/^[^>]*>/, ""));
      expect(text, locale).toBe(norm(`${d(locale)["settings.account.lichess.flash.already_linked"]} ${d(locale)["settings.account.lichess.flashNext.already_linked"]}`));
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("the whole shell hands the outcome to the card (the seam, driven through the real RoomShell)", () => {
  it("a room opened with ?lichess=already_linked on a refused grant paints the sentence and next step on card 8", () => {
    const html = paintShell("already_linked");
    expect(screenOf(html)).toBe("relink");
    expect(html).toContain(esc(en["settings.account.lichess.flash.already_linked"]));
    expect(html).toContain(esc(en["settings.account.lichess.flashNext.already_linked"]));
    expect(ids(html)).toContain("room-relink");
  });

  it("the pair: the same room opened WITHOUT the outcome draws none of it (this is what the owner saw)", () => {
    const html = paintShell(null);
    expect(screenOf(html)).toBe("relink");
    for (const id of FLASH_IDS) expect(ids(html), id).not.toContain(id);
    expect(html).not.toContain(esc(en["settings.account.lichess.flash.already_linked"]));
  });

  it("linked and an unknown code paint nothing - through the shell, on card 8 and on seam A, in every locale", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      for (const over of [{}, { game: GAME, frozen: "you", canAct: false } as Partial<RoomSnapshot>]) {
        const linked = paintShell("linked", locale, over);
        expect(linked, `${locale}: linked`).not.toContain(esc(d(locale)["settings.account.lichess.flash.linked"]!));
        expect(linked, `${locale}: linked is exactly the card with no outcome`).toBe(paintShell(null, locale, over));
        expect(paintShell("made-up", locale, over), `${locale}: unknown`).toBe(paintShell(null, locale, over));
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 2 cards").toBe(8);
  });

  it("a revoked-link room (seam A) opened with the outcome says it on the notice", () => {
    const html = paintShell("already_linked", "en", { game: GAME, frozen: "you", canAct: false });
    expect(screenOf(html)).toBe("revoked");
    expect(html).toContain(esc(en["settings.account.lichess.flash.already_linked"]));
    expect(ids(html)).toContain("room-revoked-relink");
  });
});

// PR #990 review, M3: seam A's notice, when the game is on ONE specific Lichess account (`otherAccount`), already says
// "sign in to Lichess as X, then link it again". The generic already_linked next step ends "or switch to a different
// account on Lichess" - offering the one thing that notice rules out. So that combination carries the game-account
// next step instead: unlink it from the other Seazn account, then link it here. One coherent instruction per case.
describe("seam A with the game on one Lichess account: the outcome's next step agrees with the notice", () => {
  const ACCOUNT = "ada_plays";
  const onAccount = () => revokedState({ otherAccount: ACCOUNT, frozen: null });
  const blockOf = (html: string) => /data-testid="lichess-flash"[\s\S]*?data-testid="lichess-flash-next"[^>]*>[^<]*<\/p>/.exec(html)?.[0] ?? "";
  const accountLine = (locale: Locale) => (d(locale)["externalPlay.room.state.revoked.otherAccount"] ?? "").replaceAll("{username}", ACCOUNT);

  it("the premise: the screen is seam A because of the account, not a frozen seat", () => {
    expect(roomScreen(onAccount()).kind).toBe("revoked");
    expect(onAccount().snap.frozen).toBeNull();
    expect(onAccount().snap.otherAccount).toBe(ACCOUNT);
  });

  it("already_linked + otherAccount: the GAME-ACCOUNT next step, not the generic one - in every locale", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const html = paint(onAccount(), "already_linked", locale);
      expect(html, `${locale}: the game-account step`).toContain(esc(d(locale)["settings.account.lichess.flashNext.already_linked_game"]!));
      expect(html, `${locale}: the generic step (which offers a different account) is NOT there`).not.toContain(esc(d(locale)["settings.account.lichess.flashNext.already_linked"]!));
      expect(html, `${locale}: the outcome sentence`).toContain(esc(d(locale)["settings.account.lichess.flash.already_linked"]!));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the notice still says which account the game is on (once, in its own line) - and the outcome block names nobody", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const html = paint(onAccount(), "already_linked", locale);
      expect(html, locale).toContain(esc(accountLine(locale)));
      // The notice's own line may repeat the name (it is what the player signs in with); everywhere else it must not appear.
      expect(html.split(ACCOUNT).length - 1, `${locale}: only in the notice's own line`).toBe(accountLine(locale).split(ACCOUNT).length - 1);
      const block = blockOf(html);
      expect(block, locale).not.toBe("");
      expect(block, `${locale}: not in the outcome block`).not.toContain(ACCOUNT);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the order reads as one instruction: the outcome and its step, then the game's account line, then the one action", () => {
    const html = paint(onAccount(), "already_linked");
    expect(posOf(html, "room-revoked-notice")).toBeLessThan(posOf(html, "lichess-flash"));
    expect(posOf(html, "lichess-flash-next")).toBeLessThan(posOf(html, "room-revoked-account"));
    expect(posOf(html, "room-revoked-account")).toBeLessThan(posOf(html, "room-revoked-relink"));
  });

  it("the English step keeps the account (unlink it elsewhere, then link it here) and offers no other Lichess account", () => {
    const step = en["settings.account.lichess.flashNext.already_linked_game"];
    expect(step).toMatch(/unlink it in Settings/i);
    expect(step).toMatch(/link it here/i);
    expect(step).not.toMatch(/different|another|switch/i);
    // The notice's line is "sign in to Lichess as {username}, then link it again": the step is the part that comes first.
    expect(en["externalPlay.room.state.revoked.otherAccount"]).toMatch(/sign in to Lichess as \{username\}/i);
  });

  it("without the account (a frozen seat) the generic step stands - the game is not tied to one account there", () => {
    const html = paint(revokedState(), "already_linked");
    expect(html).toContain(esc(en["settings.account.lichess.flashNext.already_linked"]));
    expect(html).not.toContain(esc(en["settings.account.lichess.flashNext.already_linked_game"]));
  });

  it("a failure with no next step stays one line on this notice too, and the account line follows it", () => {
    const html = paint(onAccount(), "token");
    expect(html).toContain(esc(en["settings.account.lichess.flash.token"]));
    expect(ids(html)).not.toContain("lichess-flash-next");
    expect(ids(html)).toContain("room-revoked-account");
  });

  it("through the whole shell: a game on another account, landed with already_linked, paints the game-account step", () => {
    const html = paintShell("already_linked", "en", { game: GAME, otherAccount: ACCOUNT, canAct: false });
    expect(screenOf(html)).toBe("revoked");
    expect(html).toContain(esc(en["settings.account.lichess.flashNext.already_linked_game"]));
    expect(html).not.toContain(esc(en["settings.account.lichess.flashNext.already_linked"]));
  });
});
