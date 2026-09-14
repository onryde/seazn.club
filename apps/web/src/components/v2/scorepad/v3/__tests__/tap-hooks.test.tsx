// Task 8 (bench-b07a "match day") — stable e2e hooks for every control a
// scorer taps: Start match, Finalize, Send now, Confirm, the number field,
// the device-link mint button, cookie Accept, and `data-side="home"/"away"`
// on both scorebug-half render branches. task-8-brief.md's own rationale:
// today these are findable only by TRANSLATED text/role/label, which breaks
// the moment a translator touches a string and cannot run against a
// non-English locale at all — Task 9's browser tap driver needs a contract
// that survives both.
//
// apps/web vitest is environment:"node" (no DOM), so every assertion here
// renders to a markup STRING and anchors on `="` — React serialises an
// omitted/undefined prop as `"$undefined"`, so a bare `data-side` (or
// `data-testid`) probe with no `="value"` anchor would pass whether or not
// the attribute is really set (AGENTS.md, "Verification traps").
//
// Fix round 1 (review, task-8-review.md, R42.1): every hook assertion below
// now pins IDENTITY — tag, or a distinguishing prop/visible text unique to
// the real control — not mere STRING PRESENCE. A presence-only `toContain`
// survives a mutant that moves the same testid onto a sibling element
// (`pad-sheet-number` onto the decrease button, `cookie-accept` onto
// Reject); the review's own reviewer-run mutants proved this (M1/M2/M3
// SURVIVED against the pre-fix version of this file). See each `it`'s own
// comment for what identity check it applies and which reviewer mutant it
// now kills.
//
// Render technique per component, matching the convention already
// established in this directory (see each site's own comment below): most
// of these are plain `renderToStaticMarkup` — a one-shot server render is
// enough to see a static attribute on an element that is present on the
// FIRST render — except CookieConsent, whose banner is invisible until a
// `useEffect` flips `visible` true, which `renderToStaticMarkup` (`environment:
// "node"`, no DOM, runs no effects at all) can never observe. That one case
// uses `_hook-harness.tsx`'s `renderIsland`, the same technique
// `cookie-consent-overlay-segment.test.tsx` already proves works for this
// exact component.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { initSquads, type SquadState } from "@seazn/engine/core";
import { Scorebug } from "../scorebug";
import { GuidedSheet, type GuidedSheetProps } from "../guided-sheet";
import { DetailDock, type DockStore } from "../detail-dock";
import { buildScorebug as buildCricketScorebug } from "../skins/cricket";
import type { DockSpec, GuidedSheetSpec, PadHostView, ScorebugSpec } from "../types";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { DeviceScorePad } from "@/components/v2/device-score-pad";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { CookieConsent } from "@/components/cookie-consent";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

// FixtureConsole calls next/navigation's useRouter(); CookieConsent (below)
// calls its usePathname() — one mock, shared, same convention
// phone-classes.test.tsx already uses for the router half. `pathname` is
// read lazily (the factory closure is not INVOKED until a component under
// test actually calls usePathname(), by which point this module's top-level
// `const pathname = ...` has long since run) — the same ordering
// cookie-consent-overlay-segment.test.tsx's own header comment relies on.
const pathname = { current: "/shared/acme/summer-cup/div-a/fixtures/1" };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => pathname.current,
}));

const identity = (key: string) => key;

// --- Scorebug: data-side="home"/"away", DRIVEN BY half.side (R41) ----------
//
// Fix round 1 (Important 1, ruling R41): `data-side` used to come from the
// half's RENDER-ORDER INDEX (`i === 0 ? "home" : "away"`), which mislabels
// any skin whose two halves are not sides at all — cricket's are the
// batting total and the overs count (see the cricket describe block below).
// `ScorebugHalf.side` (types.ts) is now the ONLY source `scorebug.tsx`
// reads; a half that sets none renders no `data-side` attribute.
describe("scorebug halves carry data-side FROM half.side, never from render order or branch", () => {
  function spec(homeTappable: boolean): ScorebugSpec {
    const tapProps = {
      tappable: true as const,
      hintKey: "pad.hint.rally",
      tapEvent: { type: "carrom.board", payload: {} },
    };
    return {
      phase: "live",
      context: "ctx",
      halves: [
        { who: [{ name: "Meena Iyer" }], side: "home", big: "7", ...(homeTappable ? tapProps : {}) },
        { who: [{ name: "Ravi Shankar" }], side: "away", big: "3", ...(homeTappable ? {} : tapProps) },
      ],
      strip: [],
    };
  }

  function render(homeTappable: boolean): string {
    return renderToStaticMarkup(
      <Scorebug spec={spec(homeTappable)} t={identity as unknown as Parameters<typeof Scorebug>[0]["t"]} />,
    );
  }

  // Anchored on the OPENING TAG itself (`<div|button ... data-side="X" ...>`),
  // captured group 1 is the element name — this is what actually tells button
  // apart from div, unlike slicing from mid-attribute (which lands INSIDE the
  // tag whose type it is trying to name).
  function assertSides(html: string, expectHomeTag: "button" | "div", expectAwayTag: "button" | "div") {
    const homeTag = html.match(/<(div|button)\b[^>]*\sdata-side="home"[^>]*>/);
    const awayTag = html.match(/<(div|button)\b[^>]*\sdata-side="away"[^>]*>/);
    expect(homeTag, 'no element with data-side="home" found').not.toBeNull();
    expect(awayTag, 'no element with data-side="away" found').not.toBeNull();
    expect(homeTag![1], "the home half's own element type").toBe(expectHomeTag);
    expect(awayTag![1], "the away half's own element type").toBe(expectAwayTag);
    // Slicing from the home tag to the away tag (and from the away tag to the
    // end) isolates each half's own subtree — proves the name sits INSIDE its
    // own half's span, never merely somewhere else on the page.
    const homeChunk = html.slice(html.indexOf(homeTag![0]), html.indexOf(awayTag![0]));
    const awayChunk = html.slice(html.indexOf(awayTag![0]));
    expect(homeChunk).toContain("Meena Iyer");
    expect(homeChunk).not.toContain("Ravi Shankar");
    expect(awayChunk).toContain("Ravi Shankar");
    expect(awayChunk).not.toContain("Meena Iyer");
  }

  it("home tappable (button), away non-tappable (div): data-side matches half.side", () => {
    assertSides(render(true), "button", "div");
  });

  // Fix round 1 (Minor 1, M1 SURVIVED): the ORIGINAL fixture always made home
  // the button and away the div, so a mapping keyed on BRANCH (button="home",
  // div="away") passed every assertion above too. This second render reverses
  // which half is tappable — home is now the DIV, away is now the BUTTON —
  // so a branch-derived map would get BOTH tags backwards here. Only a map
  // that reads `half.side` (never the branch or the index) passes both.
  it("BRANCH REVERSED — home non-tappable (div), away tappable (button): data-side STILL matches half.side, not the branch (kills M1)", () => {
    assertSides(render(false), "div", "button");
  });
});

// --- Cricket: halves are READOUTS, not sides — no data-side at all ---------
//
// Fix round 1 (Important 1, ruling R41): cricket's own `buildScorebug`
// (skins/cricket.tsx:1176) builds `halves: [{who: "Batting", …}, {who:
// "Overs", …}]` — neither is a team's own side, so it sets no `side` field.
// Driving the REAL builder (not a synthetic stand-in) through the REAL
// `Scorebug` chassis proves the whole path emits no attribute end to end.
const cricketT = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${JSON.stringify(vars)})` : key;

function cricketSquads(): SquadState {
  return initSquads({
    home: { entrantId: "home-1", slots: [{ personId: "h1", slot: "starting", orderNo: 1 }] },
    away: { entrantId: "away-1", slots: [{ personId: "a1", slot: "starting", orderNo: 1 }] },
  });
}

function cricketView(battingSide: "home" | "away"): PadHostView {
  return {
    cfg: { ballsPerOver: 6, inningsPerSide: 1 as const, ballsPerInnings: 120, dls: { enabled: false }, superOver: false },
    state: {
      phase: "live" as const,
      innings: [
        {
          battingSide,
          runs: 42,
          wickets: 2,
          legalBalls: 30,
          closed: false,
          fine: { striker: "h1", nonStriker: null, currentBowler: "a1", freeHitPending: false },
        },
      ],
      orders: { home: ["h1"], away: ["a1"] },
    },
    summary: {},
    phase: "live",
    band: 3,
    entitlements: {},
    personNames: { h1: "Home Batter", a1: "Away Bowler" },
    squads: cricketSquads(),
    events: [],
    contextOverrides: {},
  };
}

function cricketHtml(battingSide: "home" | "away"): string {
  const spec = buildCricketScorebug(cricketView(battingSide), cricketT);
  return renderToStaticMarkup(<Scorebug spec={spec} t={identity as unknown as Parameters<typeof Scorebug>[0]["t"]} />);
}

describe("cricket's real buildScorebug output carries no data-side — its halves are not sides", () => {
  it('away side batting: no data-side="…" appears anywhere in the markup', () => {
    expect(cricketHtml("away")).not.toMatch(/data-side="/);
  });
  it('home side batting: no data-side="…" appears anywhere in the markup either', () => {
    expect(cricketHtml("home")).not.toMatch(/data-side="/);
  });
});

// --- GuidedSheet: the number field and Confirm control ----------------------
describe("the guided sheet's number field and confirm control carry stable hooks", () => {
  const numberSpec: GuidedSheetSpec = {
    event: "carrom.board.summary",
    steps: [{ id: "opponentCoinsLeft", kind: "number", title: "pad.carrom.sheet.board.coins.title", initial: 0, min: 0 }],
    buildPayload: (answers) => ({ opponentCoinsLeft: Number(answers.opponentCoinsLeft) }),
  };
  const emptySquad = { entrantId: "e1", members: [], subsUsed: 0, exemptUsed: {} };
  const views: GuidedSheetProps["views"] = { home: { squad: emptySquad }, away: { squad: emptySquad } };
  const html = renderToStaticMarkup(
    <GuidedSheet
      spec={numberSpec}
      views={views}
      personNames={{}}
      t={identity as unknown as GuidedSheetProps["t"]}
      onComplete={() => {}}
    />,
  );

  // Fix round 1 (Minor 2, M2 SURVIVED): a presence-only `toContain` passed
  // when the reviewer moved this exact testid onto the sibling decrease
  // `<button>`. Anchoring on the TAG (and its own `type="number"`) is what
  // actually distinguishes the number field from the −/+ stepper buttons
  // beside it (`guided-sheet.tsx`'s `renderNumberStep`).
  it('the hook sits on the real <input type="number">, never the stepper buttons (kills M2)', () => {
    const tag = html.match(/<(input|button)\b[^>]*data-testid="pad-sheet-number"[^>]*>/);
    expect(tag, 'no element with data-testid="pad-sheet-number" found').not.toBeNull();
    expect(tag![1], "must be the <input>, not a <button>").toBe("input");
    expect(tag![0]).toContain('type="number"');
  });

  // The Confirm button's own visible content (the identity stub echoes the
  // raw key) is what the −/+ buttons ("−"/"+") and Back/Cancel
  // ("pad.sheet.back"/"pad.sheet.cancel") never show, so this rules out the
  // hook landing on any sibling control, the same idea M2's fix applies.
  it("the hook sits on the real Confirm button (its own text), never a sibling control", () => {
    const tag = html.match(/<button\b[^>]*data-testid="pad-sheet-confirm"[^>]*>([\s\S]*?)<\/button>/);
    expect(tag, 'no <button data-testid="pad-sheet-confirm"> found').not.toBeNull();
    expect(tag![1]).toContain("scorepad.action.confirm");
  });
});

// --- DetailDock: "Send now" (the dock's dismiss control) --------------------
describe("the detail dock's Send-now control carries a stable hook", () => {
  const noopStore: DockStore = { mutateHeld: async () => true, releaseHeld: async () => {} };
  const spec: DockSpec = {
    title: "Board detail",
    chips: [{ id: "queen", label: "pad.carrom.dock.queen", kind: "flag", mutate: (p) => p }],
  };
  const html = renderToStaticMarkup(
    <DetailDock
      spec={spec}
      heldId="h1"
      store={noopStore}
      heldUntil={Date.now() + 6000}
      t={identity as unknown as Parameters<typeof DetailDock>[0]["t"]}
      now={() => Date.now()}
    />,
  );

  // The dismiss button's OWN `aria-label` (`pad.dock.dismiss`, "Send now" in
  // en) is a distinguishing prop the chip buttons beside it never carry —
  // rules out the hook landing on the "queen" chip instead.
  it('the hook sits on the real dismiss button (aria-label="pad.dock.dismiss"), never a chip', () => {
    const tag = html.match(/<button\b[^>]*data-testid="pad-send-now"[^>]*>/);
    expect(tag, 'no <button data-testid="pad-send-now"> found').not.toBeNull();
    expect(tag![0]).toContain('aria-label="pad.dock.dismiss"');
  });
});

// --- FixtureConsole: Start match and Finalize --------------------------------
const football: SportInfo = {
  key: "football",
  config: {},
  scorerLabel: "Referee",
  positionGroups: [],
  roles: [],
  lineupSize: 11,
  benchMax: 5,
};
const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

function consoleHtml(over: { status: string; outcome: unknown }): string {
  const live: LiveState = { status: over.status, last_seq: 1, summary: null, state: {}, outcome: over.outcome };
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{ id: "f1", status: over.status, scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
      sport={football}
      home={side("e-home", "Riverside FC")}
      away={side("e-away", "Summit Athletic")}
      initialState={live}
      initialEvents={[]}
      canEdit
      viewerPlan="community"
    />,
  );
}

// FixtureConsole calls the real `useMsg()` hook (not a `t` prop), which falls
// back to the REAL English catalog outside a `<DictProvider>` (dict-
// provider.tsx's own doc) — so the rendered text is genuinely "Start match" /
// "Finalize result" (`dictionaries/en/ui.json`), not a raw key. That real
// text is the distinguishing prop that rules out the hook landing on a
// sibling control (device-handover, ShareButton).
describe("fixture console: Start match carries a stable hook", () => {
  it('the Start match button carries the hook AND its own visible text is "Start match"', () => {
    const html = consoleHtml({ status: "scheduled", outcome: null });
    const tag = html.match(/<button\b[^>]*data-testid="score-start-match"[^>]*>([\s\S]*?)<\/button>/);
    expect(tag, 'no <button data-testid="score-start-match"> found').not.toBeNull();
    expect(tag![1]).toContain("Start match");
  });
});

describe("fixture console: Finalize carries a stable hook", () => {
  it('the Finalize button carries the hook AND its own visible text is "Finalize result"', () => {
    const html = consoleHtml({ status: "decided", outcome: { kind: "win", winner: "e-home" } });
    const tag = html.match(/<button\b[^>]*data-testid="score-finalize"[^>]*>([\s\S]*?)<\/button>/);
    expect(tag, 'no <button data-testid="score-finalize"> found').not.toBeNull();
    expect(tag![1]).toContain("Finalize result");
  });
});

// --- DeviceScorePad: Start match (the courtside-page chrome, a DIFFERENT
// component from fixture-console.tsx's own Start match button above, but
// the SAME hook name — both are "the button that dispatches core.start") ---
describe("device score pad: Start match carries a stable hook", () => {
  it('the Start match button carries the hook AND its own visible text is "Start match"', () => {
    const live: LiveState = { status: "scheduled", last_seq: 0, summary: null, state: {}, outcome: null };
    const html = renderToStaticMarkup(
      <DeviceScorePad
        token="dl_test"
        deviceLinkId="link-1"
        fixture={{
          id: "f1",
          round_no: 1,
          venue: null,
          court_label: null,
          competition_name: "Summer League",
          division_name: "Boards",
        }}
        sport={football}
        home={side("e-home", "Meena")}
        away={side("e-away", "Ravi")}
        initialState={live}
        initialEvents={[]}
      />,
    );
    const tag = html.match(/<button\b[^>]*data-testid="score-start-match"[^>]*>([\s\S]*?)<\/button>/);
    expect(tag, 'no <button data-testid="score-start-match"> found').not.toBeNull();
    expect(tag![1]).toContain("Start match");
  });
});

// --- DeviceLinkPanel: mint, on BOTH branches that can show it ---------------
//
// Fix round 1 (Minor 4): the "New link" control (device-link-panel.tsx
// ~:156, the `active && !minted` branch) and the "Create scoring link"
// control (~:162, the `!minted && !active` branch) are two arms of the SAME
// `minted ? … : active ? … : …` ternary — mutually exclusive by
// construction, never both rendered at once — so both now carry
// `device-link-mint` rather than leaving the rotate path unhooked.
describe("device link panel: mint carries a stable hook on every branch that can show it", () => {
  it('no active/minted link yet: the "Create scoring link" button carries the hook, with its own real text', () => {
    const html = renderToStaticMarkup(<DeviceLinkPanel fixtureId="f1" scorerLabel="Umpire" viewerPlan="community" />);
    const tag = html.match(/<button\b[^>]*data-testid="device-link-mint"[^>]*>([\s\S]*?)<\/button>/);
    expect(tag, 'no <button data-testid="device-link-mint"> found').not.toBeNull();
    expect(tag![1]).toContain("Create scoring link");
  });
});

// --- CookieConsent: Accept -------------------------------------------------
//
// `renderToStaticMarkup` cannot see this one: the banner starts `visible:
// false` and only flips true from inside a `useEffect`, which a one-shot
// server render never runs (AGENTS.md, recurring failure class 2 — "pure-
// builder tests cannot see wiring"; and see this file's own header). So this
// uses `_hook-harness.tsx`'s `renderIsland`, the same technique
// `cookie-consent-overlay-segment.test.tsx` already proves works for this
// exact component, with the same `window`/`localStorage` stubs its own
// header explains are needed (`environment: "node"` has neither global).
// The stub/render/assert/unstub all run synchronously inside this one `it`
// (no `await` in between), so no other test in this file ever runs with
// these globals stubbed — vitest does not interleave `it` bodies.
describe("cookie consent: Accept carries a stable hook", () => {
  // Fix round 1 (Minor 2, M3 SURVIVED): a presence-only check passed when the
  // reviewer moved this testid onto the Reject button instead. `renderIsland`
  // hands back the LIVE element tree (never a markup string), so the
  // identity check here reads the handler's own SOURCE TEXT — Accept's
  // closure is `() => decide("accepted")`, Reject's is `() => decide
  // ("rejected")`, and `Function.prototype.toString()` returns exactly that
  // source under vitest's esbuild transform (no minification). This is what
  // "the element whose onClick decides accepted" (review's own fix wording)
  // means concretely, without actually invoking the handler — invoking it
  // would call the real `fetch("/api/consent", …)`, which has no server to
  // answer in this environment.
  it('a first-time visitor on a real page (not /overlay/): the Accept button carries the hook AND its own handler decides "accepted" (kills M3)', () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { pathname: "/shared/acme/summer-cup/div-a/fixtures/1" },
    });
    try {
      const island = renderIsland(CookieConsent, {});
      const tree = island.tree();
      expect(tree.length, "the banner must actually be visible (post-effect), not the empty pre-effect tree").toBeGreaterThan(0);
      const accept = tree.find((el) => el.type === "button" && propsOf(el)["data-testid"] === "cookie-accept");
      expect(accept, 'no <button data-testid="cookie-accept"> in the rendered tree').not.toBeUndefined();
      const onClickSrc = String((propsOf(accept!) as { onClick: () => void }).onClick);
      expect(onClickSrc, "the hooked control's own handler must decide \"accepted\"").toContain("accepted");
      expect(onClickSrc, "the hooked control's own handler must NOT decide \"rejected\"").not.toContain("rejected");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
