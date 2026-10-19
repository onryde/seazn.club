// Owner staging test 2026-10-19: a personal match link opened while signed in as ANOTHER account. The room used to say
// "Link Lichess" there, which links the wrong account and asks again; it now says whose board this is, who the page sees,
// and offers one way out - Switch account. A seat tied to no Seazn account gets a calm card with no prompt at all.
//
// Painted with the REAL dictionaries, in every locale. The English words are the owner's (2026-10-19 approval); the other
// locales are read from the dictionary with the same names interpolated. The screen decision is room-screen.test.ts's, the
// server's decision is external-play-room-account.test.ts's - this is what PAINTS, and what the button DOES.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider, usePlural, useT } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { Screen } from "../room-shell";
import { WrongAccountCard } from "../room-cards";
import { RoomNoAccountHeaderless } from "../room-unavailable";
import { SwitchAccountButton, switchAccountHref } from "../switch-account-button";
import { initialRoomState, type RoomState } from "../room-state";
import { roomScreen } from "../room-screen";
import type { RoomGame, RoomSnapshot } from "../room-snapshot";

const signOut = vi.hoisted(() => ({ signOutClient: vi.fn() }));
vi.mock("@/lib/sign-out-client", () => signOut);

const LOCALES = { en, es, fr, nl } as const;
type Locale = keyof typeof LOCALES;
const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const FIXTURE = "/shared/org/comp/div/fixtures/f1";
const SELF = `${FIXTURE}/play?t=eyJhbGciOiJIUzI1NiJ9.payload-with_chars.sig`;
const RELINK = "/api/auth/lichess?org=org&next=%2Fshared%2Forg%2Fcomp%2Fdiv%2Ffixtures%2Ff1%2Fplay";
const SEAT_NAME = "Ada Okonkwo";
const VIEWER = "bob.the.long.addressed.person@a-rather-long-company-name.example.test";

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
    you: { colour: "white", name: SEAT_NAME, checkedIn: false },
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
const WRONG: Partial<RoomSnapshot> = { account: { state: "wrong_account", viewerEmail: VIEWER } };
/** The seat call refused with the link-required reason: the screen the owner saw the prompt on. */
const relinkState = (over: Partial<RoomSnapshot> = {}): RoomState => ({
  ...initialRoomState(snap(over), T0),
  seat: { seated: false, reason: "lichess_link_required", participant: null },
});
/** The viewer's own seat frozen: seam A, whose notice also offers a re-link. */
const revokedState = (over: Partial<RoomSnapshot> = {}): RoomState =>
  initialRoomState(snap({ game: GAME, frozen: "you", canAct: false, ...over }), T0);

function Painted({ state, selfPath }: { state: RoomState; selfPath: string | null }) {
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
      selfPath={selfPath}
      locale="en"
      t={t as never}
      plural={plural as never}
      reload={() => {}}
    />
  );
}
function paint(state: RoomState, locale: Locale = "en", selfPath: string | null = SELF) {
  return renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <Painted state={state} selfPath={selfPath} />
    </DictProvider>,
  );
}
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
const textFrom = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const RAW_KEY = /externalPlay\.room\.|settings\.account\./;
const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

beforeEach(() => {
  signOut.signOutClient.mockReset();
});

describe("the wrong-account card (the signed-in account is not the seat's)", () => {
  it("English, the owner's words: whose board it is, who the page sees, and ONE action - Switch account", () => {
    const html = paint(relinkState(WRONG));
    expect(roomScreen(relinkState(WRONG)).kind).toBe("wrongAccount");
    const text = textFrom(html);
    expect(text).toContain(`This board is for ${SEAT_NAME}`);
    expect(text).toContain(`You're signed in as ${VIEWER}.`);
    expect(text).toContain("Switch account");
    expect(ids(html)).toEqual(expect.arrayContaining(["room-state-wrong-account", "room-wrong-account-body", "room-switch-account"]));
    // Exactly one control on the card.
    expect((html.match(/<button\b/g) ?? []).length, "one action").toBe(1);
    expect((html.match(/<a\b/g) ?? []).length, "no link of any kind").toBe(0);
  });

  it("NEVER offers to link Lichess there: no re-link card, no re-link control, no link to the start route, no consent words", () => {
    let checked = 0;
    for (const [why, state] of [
      ["card 8 (the seat call asked for a link)", relinkState(WRONG)],
      ["seam A (a frozen seat's re-link notice)", revokedState(WRONG)],
    ] as const) {
      const html = paint(state);
      expect(roomScreen(state).kind, why).toBe("wrongAccount");
      for (const id of ["room-state-relink", "room-relink", "room-revoked-notice", "room-revoked-relink"]) {
        expect(ids(html), `${why}: ${id}`).not.toContain(id);
      }
      expect(html, `${why}: the Lichess start route`).not.toContain("/api/auth/lichess");
      expect(textFrom(html), `${why}: the consent copy`).not.toContain(en["settings.account.lichess.consent.cta"]);
      expect(textFrom(html), `${why}: link again`).not.toContain(en["externalPlay.room.state.revoked.relink"]);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the pairs: the seat's own account (and a signed-out viewer) still gets the prompts, exactly as before", () => {
    const relink = paint(relinkState());
    expect(ids(relink)).toEqual(expect.arrayContaining(["room-state-relink", "room-relink"]));
    expect(ids(relink)).not.toContain("room-state-wrong-account");
    expect(relink).toContain("/api/auth/lichess");
    const revoked = paint(revokedState());
    expect(ids(revoked)).toEqual(expect.arrayContaining(["room-revoked-notice", "room-revoked-relink"]));
    expect(ids(revoked)).not.toContain("room-state-wrong-account");
  });

  it("every locale: the dictionary's words with the seat's name and the viewer's email filled in - no raw key, no placeholder left", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const d = LOCALES[locale] as Record<string, string>;
      const text = textFrom(paint(relinkState(WRONG), locale));
      expect(text, `${locale}: title`).toContain(fill(d["externalPlay.room.state.wrongAccount.title"]!, { name: SEAT_NAME }));
      expect(text, `${locale}: body`).toContain(fill(d["externalPlay.room.state.wrongAccount.body"]!, { email: VIEWER }));
      expect(text, `${locale}: action`).toContain(d["externalPlay.room.state.wrongAccount.switch"]!);
      expect(text, `${locale}: raw key`).not.toMatch(RAW_KEY);
      expect(text, `${locale}: placeholder`).not.toMatch(/\{(name|email)\}/);
      checked += 1;
    }
    expect(checked).toBe(4);
    // Each locale says it in its own words (the English sentence is not the fallback everywhere).
    const titles = new Set((Object.keys(LOCALES) as Locale[]).map((l) => (LOCALES[l] as Record<string, string>)["externalPlay.room.state.wrongAccount.title"]));
    expect(titles.size).toBe(4);
  });

  it("the wrong-account card shows the VIEWER's email once, and no other address: the seat's is not in the snapshot to be shown", () => {
    const html = paint(relinkState(WRONG));
    const addresses = textFrom(html).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
    expect(addresses, "exactly the viewer's own").toEqual([VIEWER]);
  });

  it("Switch account signs back in to the room AS OPENED - the personal link included - and falls back to the room's own path with none", () => {
    const withLink = renderIsland(Screen, screenProps(relinkState(WRONG), SELF)).tree().find((el) => el.type === WrongAccountCard);
    expect(propsOf(withLink!).next).toBe(SELF);
    const without = renderIsland(Screen, screenProps(relinkState(WRONG), null)).tree().find((el) => el.type === WrongAccountCard);
    expect(propsOf(without!).next).toBe(`${FIXTURE}/play`);
    // And the card hands exactly that to the button.
    const card = renderIsland(WrongAccountCard, { name: SEAT_NAME, email: VIEWER, next: SELF, t: ((k: string) => k) as never }).tree();
    const button = card.find((el) => el.type === SwitchAccountButton) ?? findInProps(card, SwitchAccountButton);
    expect(propsOf(button!).next).toBe(SELF);
  });

  it("a long unbroken email wraps rather than widening the card (the body carries break-anywhere)", () => {
    const html = paint(relinkState(WRONG));
    const tag = /<p[^>]*data-testid="room-wrong-account-body"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain("[overflow-wrap:anywhere]");
  });
});

/** Props the painted Screen takes, for the harness (which renders it one level deep). */
function screenProps(state: RoomState, selfPath: string | null) {
  const noop = async () => null;
  return {
    screen: roomScreen(state),
    state,
    room: { state, refresh: noop, claim: noop, act: noop, clockZero: noop, subscribed: false } as never,
    camera: { status: "live", stream: null, enable: () => {} } as never,
    presence: null,
    busy: false,
    tryAgain: () => {},
    relinkHref: RELINK,
    selfPath,
    locale: "en",
    t: ((k: string) => k) as never,
    plural: ((k: string) => k) as never,
    reload: () => {},
  } as Parameters<typeof Screen>[0];
}

/** A component element nested in a prop (the card hands its action to StateCard as a prop, not as children). */
function findInProps(tree: ReactElement[], type: unknown): ReactElement | undefined {
  for (const el of tree) {
    for (const value of Object.values(propsOf(el))) {
      const hit = walk(value as never).find((e) => e.type === type);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe("a seat tied to no Seazn account (the server's 409 ROOM_SEAT_NO_ACCOUNT)", () => {
  const paintNone = (locale: Locale = "en") =>
    renderToStaticMarkup(
      <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
        <RoomNoAccountHeaderless fixtureHref={FIXTURE} t={((k: string) => (LOCALES[locale] as Record<string, string>)[k] ?? k) as never} />
      </DictProvider>,
    );

  it("English, the owner's words, with the way back to the fixture - and NOTHING to link or sign in with", () => {
    const html = paintNone();
    const text = textFrom(html);
    expect(text).toContain("This seat isn't tied to a Seazn account yet");
    expect(text).toContain("Ask the organiser.");
    expect(ids(html)).toEqual(expect.arrayContaining(["match-room", "room-state-no-account", "room-back-to-fixture"]));
    expect(/data-screen="noAccount"/.test(html)).toBe(true);
    expect(/data-testid="room-back-to-fixture"[^>]*href="[^"]*"/.test(html) || /href="[^"]*"[^>]*data-testid="room-back-to-fixture"/.test(html)).toBe(true);
    expect(html).toContain(`href="${FIXTURE}"`);
    for (const id of ["room-relink", "room-state-relink", "room-switch-account", "room-state-wrong-account", "room-checkin"]) {
      expect(ids(html), id).not.toContain(id);
    }
    expect(html).not.toContain("/api/auth/lichess");
    expect(html).not.toContain("/login");
    expect((html.match(/<button\b/g) ?? []).length, "no control but the way back").toBe(0);
  });

  it("every locale says it in its own words, with no raw key", () => {
    let checked = 0;
    const titles = new Set<string>();
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const d = LOCALES[locale] as Record<string, string>;
      const text = textFrom(paintNone(locale));
      expect(text, `${locale}: title`).toContain(d["externalPlay.room.state.noAccount.title"]);
      expect(text, `${locale}: body`).toContain(d["externalPlay.room.state.noAccount.body"]);
      expect(text, `${locale}: raw key`).not.toMatch(RAW_KEY);
      titles.add(d["externalPlay.room.state.noAccount.title"]!);
      checked += 1;
    }
    expect(checked).toBe(4);
    expect(titles.size).toBe(4);
  });
});

describe("Switch account (the button)", () => {
  const mount = (go = vi.fn()) =>
    renderIsland(SwitchAccountButton, { next: SELF, label: "Switch account", failedLabel: "We couldn't sign you out. Try again.", className: "c", go });
  const button = (island: ReturnType<typeof mount>) => island.tree().find((el) => el.type === "button")!;
  const alert = (island: ReturnType<typeof mount>) => island.tree().find((el) => propsOf(el).role === "alert");

  it("signs out FIRST, and only then goes to /login with the room - the personal link included - as next", async () => {
    let release: () => void = () => {};
    signOut.signOutClient.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    const go = vi.fn();
    const island = mount(go);
    const pressed = (propsOf(button(island)).onClick as () => void)();
    expect(signOut.signOutClient).toHaveBeenCalledTimes(1);
    expect(go, "not before the session has ended").not.toHaveBeenCalled();
    expect(propsOf(button(island)).disabled, "pressed once, not twice").toBe(true);
    release();
    await pressed;
    await Promise.resolve();
    expect(go).toHaveBeenCalledTimes(1);
    const href = go.mock.calls[0]![0] as string;
    expect(href).toBe(`/login?next=${encodeURIComponent(SELF)}`);
    // The round trip: the login page reads `next` back as exactly the room's path and query, token intact.
    expect(new URL(href, "http://x").searchParams.get("next")).toBe(SELF);
    expect(switchAccountHref(SELF)).toBe(href);
  });

  it("a session that could not be ended navigates nowhere, says so, and the button works again - the SEQUENCE: fail, then succeed", async () => {
    const go = vi.fn();
    const island = mount(go);
    signOut.signOutClient.mockRejectedValueOnce(new Error("network"));
    await (propsOf(button(island)).onClick as () => Promise<void>)();
    expect(go, "still signed in: going to /login would bounce straight back here").not.toHaveBeenCalled();
    expect(textOf(propsOf(alert(island)!).children as never)).toContain("We couldn't sign you out");
    expect(propsOf(button(island)).disabled, "pressable again").toBe(false);
    signOut.signOutClient.mockResolvedValueOnce(undefined);
    await (propsOf(button(island)).onClick as () => Promise<void>)();
    expect(go).toHaveBeenCalledTimes(1);
    expect(signOut.signOutClient).toHaveBeenCalledTimes(2);
  });

  it("the empty case: nothing pressed, no sign-out, no alert", () => {
    const island = mount();
    expect(signOut.signOutClient).not.toHaveBeenCalled();
    expect(alert(island)).toBeUndefined();
    expect(propsOf(button(island)).disabled).toBe(false);
  });
});
