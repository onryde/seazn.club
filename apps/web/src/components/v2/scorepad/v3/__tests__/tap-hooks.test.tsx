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
import { Scorebug } from "../scorebug";
import { GuidedSheet, type GuidedSheetProps } from "../guided-sheet";
import { DetailDock, type DockStore } from "../detail-dock";
import type { DockSpec, GuidedSheetSpec, ScorebugSpec } from "../types";
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

// --- Scorebug: data-side="home"/"away" on BOTH render branches (R37) -------
//
// Home is deliberately the TAPPABLE (button) half and away the NON-tappable
// (div) half — the same split phone-classes.test.tsx's own fixture uses, and
// for the same reason (its comment at that file's spec, "Fix round 1 —
// deliberately NOT tappable"): a spec with only one branch exercised could
// only ever prove ONE of the two element types carries the attribute. Every
// v3 skin builds `halves` as `[home, away]` in that literal order (badminton
// .tsx:876, boardgame.tsx:365, carrom.tsx:300-309, generic.tsx:404,
// tabletennis.tsx:721, tennis.tsx:624, volleyball.tsx:882 — verified by
// reading every skin, not assumed), which is the ONLY place "which index is
// which side" is decided; scorebug.tsx itself never sees a "home"/"away"
// field on ScorebugHalf, so this test's real job is proving the chassis
// honours render-ORDER, not a label on the data.
describe("scorebug halves carry data-side, and the right NAME lands on the right side", () => {
  const spec: ScorebugSpec = {
    phase: "live",
    context: "ctx",
    halves: [
      {
        who: [{ name: "Meena Iyer" }],
        big: "7",
        tappable: true,
        hintKey: "pad.hint.rally",
        tapEvent: { type: "carrom.board", payload: {} },
      },
      { who: [{ name: "Ravi Shankar" }], big: "3" },
    ],
    strip: [],
  } as ScorebugSpec; // extend from types.ts if ScorebugSpec grows — never loosen the type
  const html = renderToStaticMarkup(<Scorebug spec={spec} t={identity as unknown as Parameters<typeof Scorebug>[0]["t"]} />);

  // Anchored on the OPENING TAG itself (`<div|button ... data-side="X" ...>`),
  // captured group 1 is the element name — this is what actually tells button
  // apart from div, unlike slicing from mid-attribute (which lands INSIDE the
  // tag whose type it is trying to name).
  const homeTag = html.match(/<(div|button)\b[^>]*\sdata-side="home"[^>]*>/);
  const awayTag = html.match(/<(div|button)\b[^>]*\sdata-side="away"[^>]*>/);

  it('both data-side attributes are present, anchored on ="', () => {
    expect(homeTag, 'no element with data-side="home" found').not.toBeNull();
    expect(awayTag, 'no element with data-side="away" found').not.toBeNull();
  });

  it('the tappable half is a real <button>, carrying data-side="home"', () => {
    expect(homeTag![1]).toBe("button");
  });

  it('the non-tappable half is a plain <div>, carrying data-side="away"', () => {
    expect(awayTag![1]).toBe("div");
  });

  it('the HOME name renders inside the data-side="home" half, never the away one', () => {
    const homeChunk = html.slice(html.indexOf(homeTag![0]), html.indexOf(awayTag![0]));
    expect(homeChunk).toContain("Meena Iyer");
    expect(homeChunk).not.toContain("Ravi Shankar");
  });

  it('the AWAY name renders inside the data-side="away" half, never the home one', () => {
    const awayChunk = html.slice(html.indexOf(awayTag![0]));
    expect(awayChunk).toContain("Ravi Shankar");
    expect(awayChunk).not.toContain("Meena Iyer");
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

  it('names the number field, anchored on ="', () => {
    expect(html).toContain('data-testid="pad-sheet-number"');
  });

  it('names the confirm button, anchored on ="', () => {
    expect(html).toContain('data-testid="pad-sheet-confirm"');
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

  it('carries data-testid="pad-send-now", anchored on ="', () => {
    expect(html).toContain('data-testid="pad-send-now"');
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

describe("fixture console: Start match carries a stable hook", () => {
  it('scheduled (not started): the Start match button carries data-testid="score-start-match"', () => {
    const html = consoleHtml({ status: "scheduled", outcome: null });
    expect(html).toContain('data-testid="score-start-match"');
  });
});

describe("fixture console: Finalize carries a stable hook", () => {
  it('decided: the Finalize button carries data-testid="score-finalize"', () => {
    const html = consoleHtml({ status: "decided", outcome: { kind: "win", winner: "e-home" } });
    expect(html).toContain('data-testid="score-finalize"');
  });
});

// --- DeviceScorePad: Start match (the courtside-page chrome, a DIFFERENT
// component from fixture-console.tsx's own Start match button above, but
// the SAME hook name — both are "the button that dispatches core.start") ---
describe("device score pad: Start match carries a stable hook", () => {
  it('scheduled (not started): the Start match button carries data-testid="score-start-match"', () => {
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
    expect(html).toContain('data-testid="score-start-match"');
  });
});

// --- DeviceLinkPanel: mint (the "Create device link" primary control) ------
describe("device link panel: mint carries a stable hook", () => {
  it('no active/minted link yet: the mint button carries data-testid="device-link-mint"', () => {
    const html = renderToStaticMarkup(
      <DeviceLinkPanel fixtureId="f1" scorerLabel="Umpire" viewerPlan="community" />,
    );
    expect(html).toContain('data-testid="device-link-mint"');
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
  it('a first-time visitor on a real page (not /overlay/): the Accept button carries data-testid="cookie-accept"', () => {
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
      expect(accept, "no <button data-testid=\"cookie-accept\"> in the rendered tree").not.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
