// Spec §3.2–3.8. Node render only: proves WHICH nodes carry the phone classes.
// Effect at real widths: e2e/mobile.spec.ts `expectPhoneComposition`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { Scorebug } from "../scorebug";
import { DetailDock, type DockStore } from "../detail-dock";
import type { DockSpec, ScorebugSpec } from "../types";
// Task 13 finding B — the fix lives in fixture-console.tsx (not this
// directory's own scorepad/v3 components), but the dispatch names THIS
// file as the one test location for everything Task 13 touches.
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const t = ((key: string) => key) as unknown as Parameters<typeof Scorebug>[0]["t"];
const spec: ScorebugSpec = {
  phase: "live",
  context: "Best of 3 · Game 1",
  halves: [
    { who: [{ name: "Gallery Badminton Home mtgyvvf39ppg", serving: true }], big: "1", tappable: true, hintKey: "pad.hint.rally", tapEvent: { type: "badminton.rally", payload: { side: "home" } } },
    // Fix round 1 — deliberately NOT tappable: the static <div data-role=
    // "v3-scorebug-half"> variant (scorebug.tsx:319) is a DIFFERENT render
    // branch from the tappable <button> variant (:309), and with both
    // halves tappable the original fixture's regex could only ever see the
    // button — the div's own max-md:px-2/py-2 was unguarded.
    { who: [{ name: "Gallery Badminton Away mtgyvvf39ppg" }], big: "0" },
  ],
  strip: [
    // Plain branch (scorebug.tsx ≈477) — id lets the test target this exact
    // item rather than asserting on the whole strip.
    { id: "games", label: "Games", value: "0–0" },
    { label: "Serving", value: "Gallery Badminton Home mtgyvvf39ppg", accent: true },
    // `led` branch (≈349) — StripItem.tone: "led" (types.ts).
    { tone: "led", label: "Time", value: "45+2" },
    // Width-reservation branch (≈403-467) — StripItem.reserve (types.ts):
    // every value this slot can take, laid out invisibly to hold the
    // widest one's width. Answered (not `reserved`), so the visible value
    // renders too and the branch is exercised in its normal, non-empty state.
    { label: "Serve", value: "1st serve", reserve: ["1st serve", "2nd serve"] },
  ],
} as ScorebugSpec; // if ScorebugSpec needs more fields, add them from types.ts — do not loosen the type

describe("scorebug phone classes", () => {
  const html = renderToStaticMarkup(<Scorebug spec={spec} t={t} />);

  it("the tappable half (button) drops to px-2 on phones", () => {
    const half = html.match(/<button[^>]*data-role="v3-scorebug-half"[^>]*>/);
    expect(half).not.toBeNull();
    expect(half![0]).toMatch(/class="[^"]*\bmax-md:px-2\b[^"]*\bmax-md:py-2\b/);
  });
  it("the static half (div — non-tappable) drops to px-2 on phones", () => {
    const half = html.match(/<div[^>]*data-role="v3-scorebug-half"[^>]*>/);
    expect(half).not.toBeNull();
    expect(half![0]).toMatch(/class="[^"]*\bmax-md:px-2\b[^"]*\bmax-md:py-2\b/);
  });
  it("the name box clamps to two lines on phones (a pair stays readable)", () => {
    expect(html).toMatch(/class="[^"]*\bline-clamp-6\b[^"]*\bmax-md:line-clamp-2\b/);
  });
  it("the hint is one truncated line on phones", () => {
    expect(html).toMatch(/class="[^"]*\bmax-md:truncate\b[^"]*"[^>]*>pad\.hint\.rally</);
  });
  it("the meta strip is a non-wrapping rail on phones", () => {
    expect(html).toMatch(/class="[^"]*\bflex-wrap\b[^"]*\bmax-md:flex-nowrap\b[^"]*\bmax-md:overflow-x-auto\b/);
  });
  // CI e2e run 33735186301, `parallel 2/2`: the rail above tripped axe's
  // `scrollable-region-focusable` at SERIOUS impact in
  // `scorepad-skins.spec.ts`'s `expectPadA11yClean` (a file that forces a
  // 375px viewport for every test — S11/#420's own header — so the rail is
  // genuinely scrolling there, not a false positive from a desktop project
  // label). The fix is `useIsPhone()` (this file, above the component): a
  // media-query-backed `useState`, because `tabIndex` is an HTML ATTRIBUTE a
  // stylesheet cannot condition, and making it unconditional instead broke
  // this repo's OWN 44px hit-target floor at desktop (`scorepad-a11y-kit.ts`'s
  // `INTERACTIVE_SELECTOR` counts any `[tabindex]:not([tabindex="-1"])` as
  // operable, and the row is not 44px tall at 1280 either).
  //
  // `renderToStaticMarkup` runs NO effects, so this suite (`environment:
  // "node"`, no DOM at all) can only ever observe `useIsPhone()`'s initial,
  // pre-effect value — `false` — never the post-mount, real-viewport one.
  // That is not a gap this file can close; asserting `tabindex="0"` here
  // would just be asserting dead code, the AGENTS.md "tests that lie in
  // their names" class. What THIS render CAN prove, and must, is that the
  // SERVER markup carries no a11y attributes at all — if it did, hydration
  // would immediately have two conflicting trees for this node. The rail
  // actually becoming a keyboard-reachable, named tab stop on a phone is
  // proven in a real browser instead: `scorepad-skins.spec.ts`'s
  // `expectPadA11yClean` (axe, forced 375px) and `mobile.spec.ts`'s
  // `expectScorebugNotClipped`, which asserts every scrolling box inside the
  // scorebug carries the `tabindex="0"` axe demanded, at all seven widths.
  it("the rail carries no a11y attributes on the server render (no hydration mismatch)", () => {
    const rail = html.match(/<div class="[^"]*\bmax-md:overflow-x-auto\b[^"]*"[^>]*>/);
    expect(rail, "no overflow-x-auto rail found").not.toBeNull();
    expect(rail![0], "server render must not pre-empt useIsPhone()'s post-mount value").not.toMatch(/\stabindex=/);
    expect(rail![0], "server render must not pre-empt useIsPhone()'s post-mount value").not.toMatch(/\srole=/);
  });
  // Round 2 of the CI fix above: `scorepad-skins.spec.ts` forces every test to
  // a 375px viewport (S11/#420's own header), so axe's reachability
  // requirement and this repo's 44px floor land on the SAME element at the
  // SAME width — gating the tab stop by width alone cannot separate them.
  // `min-h-11` is what actually clears the floor once the row is reachable.
  it("the rail meets the 44px floor once it becomes a phone tab stop", () => {
    const rail = html.match(/<div class="[^"]*\bmax-md:overflow-x-auto\b[^"]*"[^>]*>/);
    expect(rail, "no overflow-x-auto rail found").not.toBeNull();
    expect(rail![0], "rail is scrollable but not held to the 44px floor").toMatch(/\bmax-md:min-h-11\b/);
  });
  it("the plain strip item refuses to shrink and stays single-line", () => {
    const item = html.match(/<span[^>]*data-strip-item-id="games"[^>]*>/);
    expect(item).not.toBeNull();
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:shrink-0\b/);
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:whitespace-nowrap\b/);
  });
  it("the led strip item refuses to shrink and stays single-line", () => {
    const item = html.match(/<span[^>]*data-strip-tone="led"[^>]*>/);
    expect(item).not.toBeNull();
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:shrink-0\b/);
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:whitespace-nowrap\b/);
  });
  // Task 13 finding C — design review: the strip scrolls on phones
  // (`max-md:overflow-x-auto`, above) but a still screenshot reads as
  // clipped text with no sign it continues. Already-triaged as an approved
  // affordance needing a visual cue, not a scroll-behaviour defect — fixed
  // with a phone-only edge-fade overlay pinned inside the rail's own
  // (now `relative`) wrapper.
  it("the rail's wrapper is positioned so the fade can pin to its visible edge", () => {
    // the fade lives inside a `relative` box that is a DIFFERENT element
    // from the `overflow-x-auto` scrolling div — see scorebug.tsx's own
    // comment on why an `absolute` child of the scrolling div itself would
    // sit off-screen instead of at the visible right edge.
    expect(html).toMatch(/<div class="relative">\s*<div class="[^"]*\bmax-md:overflow-x-auto\b/);
  });
  it("the fade is phone-only, non-interactive, and decorative", () => {
    const fade = html.match(/<div aria-hidden="true" class="[^"]*pad-strip-fade[^"]*"[^>]*><\/div>/);
    expect(fade, "no pad-strip-fade aria-hidden div found").not.toBeNull();
    expect(fade![0]).toMatch(/class="[^"]*\bpointer-events-none\b/);
    expect(fade![0]).toMatch(/class="[^"]*\bmd:hidden\b/);
    // NOT an inline var(--sport-...) here — sport-theme.test.ts's own
    // "and nothing else in the chassis or in ANY skin emits a --sport-*
    // property of its own" bans that literal substring from every v3
    // component source; the gradient lives in globals.css instead (below).
    expect(fade![0]).not.toContain("style=");
  });
  it("the fade class reads to the SAME custom property the rail's own background paints from", () => {
    // NIGHT_TILE_CLASSES.bandBg is "pad-board-2", whose only rule
    // (globals.css) is `background-color: var(--sport-board-2)`.
    // `pad-strip-fade` (globals.css, right beside it) reuses that same
    // variable in a gradient rather than a fixed colour, so the fade blends
    // into whichever sport's theme is live.
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toMatch(/\.pad-strip-fade\s*\{[^}]*var\(--sport-board-2\)/);
  });
  it("the reserved (width-reservation) strip item refuses to shrink but is NOT forced nowrap", () => {
    // Controller ruling: this branch's sizers hold the widest candidate's
    // width by wrapping like normal text (scorebug.tsx ≈388-391 — "NO
    // truncate/whitespace-nowrap anywhere in here ... reintroduces exactly
    // the floor min-w-0 just removed"). It must refuse to SHRINK on the
    // phone rail without adopting nowrap, which would defeat the mechanism.
    const item = html.match(/<span[^>]*data-strip-reserve="true"[^>]*>/);
    expect(item).not.toBeNull();
    expect(item![0]).toMatch(/class="[^"]*\bmax-md:shrink-0\b/);
    expect(item![0]).not.toMatch(/max-md:whitespace-nowrap/);
  });
});

// Owner review (2026-09-02), NEEDS WORK for football/hockey/ice hockey:
// "just names are coming out of circle" — a person chip (kind !== "flag")
// was forced into the same max-md:grid-cols-2 half-width cell as a short
// flag chip, then given rounded-full, so a long display name wrapped to
// four lines inside a pill that inflated into a circular blob. Spec
// (docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md:73):
// "Person pickers ... render one per row (max-md:grid-cols-1)".
describe("detail dock phone classes — person chip gets its own row, not a pill it overflows", () => {
  const noopStore: DockStore = {
    mutateHeld: async () => true,
    releaseHeld: async () => {},
  };
  const dockSpec: DockSpec = {
    title: "Goal detail",
    chips: [
      { id: "ownGoal", label: "pad.football.dock.ownGoal", kind: "flag", mutate: (p) => p },
      { id: "penalty", label: "pad.football.dock.penalty", kind: "flag", mutate: (p) => p },
      {
        id: "scorer:mtl53fg9ctu7",
        label: "pad.football.dock.person",
        labelText: "Gallery Football Away Keeper mtl53fg9ctu7",
        mutate: (p) => p,
      },
    ],
  };
  const html = renderToStaticMarkup(
    <DetailDock
      spec={dockSpec}
      heldId="h1"
      store={noopStore}
      heldUntil={Date.now() + 6000}
      t={t as unknown as Parameters<typeof DetailDock>[0]["t"]}
      now={() => Date.now()}
    />,
  );
  const buttons = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
  const personButton = buttons.find((b) => b.includes("Gallery Football Away Keeper mtl53fg9ctu7"));
  const flagButton = buttons.find((b) => b.includes("pad.football.dock.ownGoal"));

  it("renders both a flag chip and a person chip", () => {
    expect(flagButton).not.toBeUndefined();
    expect(personButton).not.toBeUndefined();
  });

  it("the person chip spans the full row and drops the pill radius on phones", () => {
    expect(personButton).toMatch(/class="[^"]*\bmax-md:col-span-2\b/);
    expect(personButton).toMatch(/class="[^"]*\bmax-md:rounded-xl\b/);
    expect(personButton).toMatch(/class="[^"]*\bmax-md:justify-start\b/);
    expect(personButton).toMatch(/class="[^"]*\bmax-md:text-left\b/);
    // never clamped/truncated — a scorer must be able to read the full name
    expect(personButton).not.toMatch(/\btruncate\b/);
    expect(personButton).not.toMatch(/\bline-clamp/);
  });

  it("the flag chip stays a two-up rectangle, untouched by the person-chip fix", () => {
    expect(flagButton).not.toMatch(/max-md:col-span-2/);
    expect(flagButton).not.toMatch(/max-md:rounded-xl/);
    expect(flagButton).toMatch(/class="[^"]*\bmax-md:justify-center\b/);
    expect(flagButton).toMatch(/class="[^"]*\brounded-lg\b/);
  });

  it("desktop stays flex-wrap pills — no md: (non-max) grid/col-span leak", () => {
    // the container itself must still be flex flex-wrap at desktop widths,
    // and the phone-only overrides must all be `max-md:`-scoped
    expect(html).toMatch(/class="[^"]*\bflex\b[^"]*\bflex-wrap\b[^"]*\bmax-md:grid\b/);
  });
});

// Task 13 finding A — design review, cross-checked against
// gallery-base/gallery-final: `generic/04-dock` ("5 points") showed the
// dock's max-md:grid-cols-2 leaving an ODD-length run of "flag"-kind chips'
// last member flush-left with a dead half-row beside it. Absent from the
// pre-branch baseline (which used plain `flex flex-wrap`, no grid at all),
// so this is ours. `strandedFlagChipIds` (detail-dock.tsx) is the fix;
// these pin its effect on the actually-rendered markup.
import { strandedFlagChipIds } from "../detail-dock";

describe("detail dock phone classes — an odd run of flag chips doesn't strand its last member", () => {
  const noopStore: DockStore = {
    mutateHeld: async () => true,
    releaseHeld: async () => {},
  };
  // generic.tsx's own DOCK_AMOUNTS shape: three flag chips, one run, odd.
  const oddDockSpec: DockSpec = {
    title: "Worth more than 1?",
    chips: [
      { id: "points:2", label: "pad.generic.dock.points", labelText: "2 points", kind: "flag", mutate: (p) => p },
      { id: "points:3", label: "pad.generic.dock.points", labelText: "3 points", kind: "flag", mutate: (p) => p },
      { id: "points:5", label: "pad.generic.dock.points", labelText: "5 points", kind: "flag", mutate: (p) => p },
    ],
  };
  const html = renderToStaticMarkup(
    <DetailDock
      spec={oddDockSpec}
      heldId="h1"
      store={noopStore}
      heldUntil={Date.now() + 6000}
      t={t as unknown as Parameters<typeof DetailDock>[0]["t"]}
      now={() => Date.now()}
    />,
  );
  const buttons = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
  const first = buttons.find((b) => b.includes("2 points"));
  const second = buttons.find((b) => b.includes("3 points"));
  const last = buttons.find((b) => b.includes("5 points"));

  it("renders all three flag chips", () => {
    expect(first).not.toBeUndefined();
    expect(second).not.toBeUndefined();
    expect(last).not.toBeUndefined();
  });

  it("the first two chips of the odd run stay a two-up rectangle (no span)", () => {
    expect(first).not.toMatch(/max-md:col-span-2/);
    expect(second).not.toMatch(/max-md:col-span-2/);
  });

  it("the run's last chip spans both columns instead of stranding in a dead half-row", () => {
    expect(last).toMatch(/class="[^"]*\bmax-md:col-span-2\b/);
    // still a flag chip visually — rounded-lg, never the person pill radius
    expect(last).toMatch(/class="[^"]*\brounded-lg\b/);
    expect(last).not.toMatch(/max-md:rounded-xl/);
  });

  it("pure function: strandedFlagChipIds flags only the last chip of an odd run", () => {
    const ids = strandedFlagChipIds(oddDockSpec.chips);
    expect([...ids]).toEqual(["points:5"]);
  });

  it("pure function: an EVEN run (football's ownGoal/penalty) strands nothing", () => {
    const evenChips: DockSpec["chips"] = [
      { id: "ownGoal", label: "pad.football.dock.ownGoal", kind: "flag", mutate: (p) => p },
      { id: "penalty", label: "pad.football.dock.penalty", kind: "flag", mutate: (p) => p },
    ];
    expect(strandedFlagChipIds(evenChips).size).toBe(0);
  });

  it("pure function: a non-flag (person) chip is never flagged, regardless of position", () => {
    const mixed: DockSpec["chips"] = [
      { id: "points:2", label: "pad.generic.dock.points", labelText: "2 points", kind: "flag", mutate: (p) => p },
      { id: "person:1", label: "pad.generic.dock.person", labelText: "A Player", mutate: (p) => p },
    ];
    // the flag run here is length 1 (odd) — it alone is stranded, the
    // trailing person chip (which already spans the full row on its own,
    // detail-dock.tsx's non-flag branch) is never in the flag set at all.
    expect([...strandedFlagChipIds(mixed)]).toEqual(["points:2"]);
  });
});

// Task 13 finding B — design review, cross-checked against
// gallery-base/gallery-final: `cricket/12-superover-decided`,
// `football/12-shootout-decided`, `icehockey/24-shootoutdecided` (320px)
// all showed an empty, unlabeled white pill between the "won on ..." line
// and the Activity card. Absent from all three pre-branch baselines (which
// showed a visible "Scoring / Hand over device" row instead) — this
// branch's own `beb0aedb2` ("the fixture header is a match strip on
// phones") added `${started ? " max-md:hidden" : ""}` to the section's
// header row without accounting for a fixture that is BOTH started AND
// decided, where the ScorePad mount (`scorePadV2 && !decided`) is also
// absent — leaving `<section data-role="console-scoring">`'s own
// `card p-5 max-md:p-3` wrapper (padding/border/bg-white, no `max-md:hidden`
// of its own) rendering with nothing inside it on a phone. Fix:
// `consoleScoringEmptyOnPhone` (fixture-console.tsx).
describe("fixture console phone classes — the empty scoring section hides itself, decided + started, phone-only", () => {
  const football = builtinModules.find((m) => m.key === "football")!;
  const CFG = football.configSchema.parse(
    (football.variants as Record<string, unknown> | undefined)?.["11-a-side"] ?? {},
  );
  const sport: SportInfo = {
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
    const live: LiveState = {
      status: over.status,
      last_seq: 1,
      summary: { headline: "1 — 1 (4-1 pens)" },
      state: {},
      outcome: over.outcome,
    };
    return renderToStaticMarkup(
      <FixtureConsole
        fixture={{ id: "f1", status: over.status, scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
        sport={sport}
        home={side("e-home", "Riverside FC")}
        away={side("e-away", "Summit Athletic")}
        initialState={live}
        initialEvents={[]}
        canEdit
        canOrganise
        stageKind={null}
        recorderNames={{}}
        audit={null}
        scorePadV2={{
          moduleVersion: football.version,
          resolvedConfig: CFG,
          initialEvents: [],
          entitlements: {},
          stageKind: null,
          identity: { recordedBy: "user-1", deviceLinkId: null },
        }}
        viewerPlan="community"
      />,
    );
  }

  it("decided + started: the section still RENDERS (audit/void history lives beside it) but is max-md:hidden", () => {
    const html = consoleHtml({ status: "decided", outcome: { kind: "win", winner: "e-home" } });
    const section = html.match(/<section class="[^"]*" data-role="console-scoring">/);
    expect(section, "the section is gone entirely, not just hidden").not.toBeNull();
    expect(section![0]).toMatch(/class="[^"]*\bmax-md:hidden\b/);
    // and it is genuinely empty on a phone: no header text, no pad
    expect(html).not.toContain('data-testid="score-pad"');
  });

  it("in_play + not decided: the section is visible on phones (the pad itself renders inside it)", () => {
    const html = consoleHtml({ status: "in_play", outcome: null });
    const section = html.match(/<section class="[^"]*" data-role="console-scoring">/);
    expect(section).not.toBeNull();
    expect(section![0]).not.toMatch(/max-md:hidden/);
    expect(html).toContain('data-testid="score-pad"');
  });

  it("scheduled (not started): the section is visible on phones (Start match button)", () => {
    const html = consoleHtml({ status: "scheduled", outcome: null });
    const section = html.match(/<section class="[^"]*" data-role="console-scoring">/);
    expect(section).not.toBeNull();
    expect(section![0]).not.toMatch(/max-md:hidden/);
  });
});
