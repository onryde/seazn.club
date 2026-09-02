// R7 / Task C, C2 (D-12) + C3 (D-19) — hierarchy on the organiser console.
//
// C2. Forfeit, Abandon and "Undo last" rendered as a BARE BUTTON ROW above
// the scoring card: no container, no heading, nothing saying these end the
// match — and Abandon was the second control on the page, at thumb height,
// beside a rally tap. `Start match` and `Finalize` were both
// `btn btn-primary` and pixel-identical, so the control that begins a match
// and the one that seals it looked the same.
//
// The band is a container with a name and a sentence saying what it costs,
// BELOW the pad and BELOW the ledger, outlined buttons only so nothing in it
// competes with a scoring tile for the eye.
//
// C3. `DeviceLinkPanel` was the LAST card on the page, below the audit — at
// 375 the console is ~2400px tall, so the thing an organiser reaches for at
// the START of a fixture sat below everything they would only read at the
// end. It takes the slot the authority row vacates, beside the pad header.
//
// The ORDER assertions are the load-bearing ones. Every claim here is about
// where a control sits relative to the others, and a test that only checked
// each was "present" would have passed against the layout this fixes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { FixtureConsole } from "@/components/v2/fixture-console";
import type { EventIn, LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

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

const EVENTS: EventIn[] = [
  {
    id: "ev-1",
    seq: 1,
    type: "core.start",
    payload: {},
    recorded_at: "2026-08-30T10:01:00.000Z",
    recorded_by: "user-1",
    voids_event_id: null,
    device_link_id: null,
  },
  {
    id: "ev-2",
    seq: 2,
    type: "football.goal",
    payload: { by: "e-home" },
    recorded_at: "2026-08-30T10:05:00.000Z",
    recorded_by: "user-1",
    voids_event_id: null,
    device_link_id: null,
  },
];

function consoleHtml(
  over: {
    status?: string;
    outcome?: unknown;
    deviceHandover?: boolean;
    // Fix round 1 (Task 4, CRITICAL) — lets a test render a TBD fixture
    // (home/away null) to prove the phone hand-over icon shares its gate
    // with the panel it opens, rather than always defaulting both sides in.
    home?: SideInfo | null;
    away?: SideInfo | null;
  } = {},
): string {
  const status = over.status ?? "in_play";
  const live: LiveState = {
    status,
    last_seq: 2,
    summary: { headline: "1 — 0" },
    state: {},
    outcome: over.outcome ?? null,
  };
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{
        id: "f1",
        status,
        scheduled_at: null,
        venue_name: null,
        court_name: null,
        round_no: 1,
      }}
      sport={sport}
      home={over.home !== undefined ? over.home : side("e-home", "Riverside FC")}
      away={over.away !== undefined ? over.away : side("e-away", "Summit Athletic")}
      initialState={live}
      initialEvents={status === "scheduled" ? [] : EVENTS}
      canEdit
      deviceHandover={over.deviceHandover ?? true}
      recorderNames={{ "user-1": "Dana Okafor" }}
      scorePadV2={{
        moduleVersion: football.version,
        resolvedConfig: CFG,
        initialEvents: [],
        entitlements: {},
        identity: { recordedBy: "user-1", deviceLinkId: null },
      }}
    />,
  );
}

/** The band's own markup, so "outlined only" is asserted about the BAND and
 *  not about a page that happens to have a primary button somewhere else. */
function bandHtml(html: string): string {
  const start = html.indexOf('data-role="match-actions"');
  expect(start, "no authority band rendered").toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("the authority band (D-12)", () => {
  it("gathers the match-ending controls into one named, explained container", () => {
    const band = bandHtml(consoleHtml());
    expect(band, "the caption names what this group is").toContain("Match actions");
    expect(band, "and a sentence says what it costs").toContain("end the match record");
    expect(band).toContain("Forfeit");
    expect(band).toContain("Abandon");
  });

  it("holds Finalize too — the most-used authority action, not buried (R7-3a)", () => {
    const band = bandHtml(consoleHtml({ outcome: { kind: "win", winner: "e-home" } }));
    expect(band).toContain("Finalize");
  });

  // R7/C review — the design of record's own wording, which C shipped without
  // because `gallery.capture.ts` matched the old Finalize literal with
  // `exact: true` (that file's two recipes moved in the same commit).
  // Pinned as the exact sentences a user reads, not as `toContain`: "Finalize"
  // and "Abandon" both still matched the strings this replaces.
  it("reads Finalize result and Abandon…, the approved wording", () => {
    expect(bandHtml(consoleHtml())).toContain(">Abandon…<");
    expect(
      bandHtml(consoleHtml({ outcome: { kind: "win", winner: "e-home" } })),
      "the button no longer explains its own mechanism in its label",
    ).toContain(">Finalize result<");
  });

  it("uses outlined buttons only — nothing here competes with a scoring tile", () => {
    expect(
      bandHtml(consoleHtml()),
      "a filled button in this band reads as the thing to press",
    ).not.toContain("btn-primary");
    expect(bandHtml(consoleHtml({ outcome: { kind: "win", winner: "e-home" } }))).not.toContain(
      "btn-primary",
    );
  });

  it("sits BELOW the pad and BELOW the ledger", () => {
    const html = consoleHtml();
    const pad = html.indexOf('data-testid="score-pad"');
    const ledger = html.indexOf('data-role="v3-activity"');
    const band = html.indexOf('data-role="match-actions"');
    expect(pad).toBeGreaterThan(-1);
    expect(ledger, "the ledger follows the pad").toBeGreaterThan(pad);
    expect(band, "nothing that ends a match sits at thumb height by a rally tap").toBeGreaterThan(
      ledger,
    );
  });

  it("wraps the pad in no overflow-hidden ancestor", () => {
    // The 44px floor on 40px minor tiles rides on a 2px `::before` bleed that
    // any such ancestor silently clips back to 40 (R1's open item, unresolved).
    // The deleted page ledger carried exactly that class, and console chrome
    // is what wraps the pad — so the claim is about THIS FILE, not about the
    // rendered page: the pad's own scorebug and sheets legitimately clip
    // themselves, and they are siblings of the tile grid, not ancestors of it.
    const src = readFileSync(join(process.cwd(), "src/components/v2/fixture-console.tsx"), "utf8");
    expect(src, "no console-chrome element may clip the pad's bleed").not.toContain(
      "overflow-hidden",
    );
  });

  it("stops Start match and Finalize being the same button", () => {
    const scheduled = consoleHtml({ status: "scheduled" });
    expect(scheduled, "starting a match is the one thing to press before kick-off").toContain(
      "btn btn-primary",
    );
    expect(scheduled).toContain("Start match");
    // ...and it is NOT in the authority band, which is outlined throughout.
    expect(bandHtml(scheduled)).not.toContain("Start match");
  });
});

describe("device handover moves up beside the pad (D-19)", () => {
  it("renders above the ledger, not as the last card on the page", () => {
    const html = consoleHtml();
    const handover = html.indexOf('data-role="device-handover"');
    const ledger = html.indexOf('data-role="v3-activity"');
    expect(handover, "the handover control must be on the console at all").toBeGreaterThan(-1);
    expect(handover, "it used to sit ~1900px below the pad, under the audit strip").toBeLessThan(
      ledger,
    );
  });

  it("renders nothing when the page says this fixture may not be handed over", () => {
    expect(consoleHtml({ deviceHandover: false })).not.toContain('data-role="device-handover"');
  });
});

describe("the console's own undo says what it does (ruling R7-5)", () => {
  it("names the permanent void it writes, never sharing a word with the pad's take-back", () => {
    const html = consoleHtml();
    expect(html, "it ALWAYS writes a core.void row — it can never cancel before send").toContain(
      "Void last entry",
    );
    expect(html).not.toContain("Undo last");
  });
});

// Task 4 (2026-09-02 phone-composition plan, spec §3.1) — below md the
// header re-lays as a compact match strip: names on one truncated line, the
// status badge, a compact score, a 44px hand-over icon, and a toggle that
// reveals the round/venue/time line.
//
// This file mocks no `useMsg`/`DictProvider` — `consoleHtml` renders
// `<FixtureConsole>` bare (see the helper above), and dict-provider.tsx's
// `useMsg` falls back to the real English catalog (`@/lib/messages`)
// OUTSIDE a `<DictProvider>`. So every assertion below matches the actual
// English sentence a viewer would read (e.g. "recorded by the referee"),
// never the raw dictionary key — an alternation accepting either shape
// would pass without checking anything real (the brief's own draft had
// exactly that bug: an un-grouped `|` splits the whole regex, so its
// right-hand side matched the bare literal "recorded by" unconditionally).
describe("phone composition — the match strip (spec §3.1)", () => {
  // Fix round 1 (Important 1) — `\bmd:hidden\b` also matches inside
  // `max-md:hidden`: the char before "md" is "-", and "-" -> "m" is a JS
  // regex word boundary just like " " -> "m" is. So a build where a phone
  // control's OWN class had regressed to "max-md:hidden" (hidden on phones,
  // shown on desktop — backwards) would still satisfy `\bmd:hidden\b`,
  // because that substring is still sitting right there inside
  // "max-md:hidden". Every assertion below that has to tell the two classes
  // apart now requires a real class-boundary (a space, not a hyphen) before
  // "md:hidden", which "max-md:hidden" can never supply.
  it("offers Hand over device twice: the desktop button hides on phones, the phone icon hides on desktop, and both share one accessible name", () => {
    const html = consoleHtml({ deviceHandover: true });
    expect(html).toMatch(/data-role="device-handover"[^>]*class="[^"]*\smax-md:hidden"/);
    expect(html).toMatch(/data-role="device-handover"[^>]*>Hand over device</);
    expect(html).toMatch(/<button[^>]*data-role="device-handover-phone"[^>]*>/);
    expect(html).toMatch(/data-role="device-handover-phone"[^>]*class="[^"]*\smd:hidden"/);
    expect(html).toMatch(/data-role="device-handover-phone"[^>]*aria-label="Hand over device"/);
  });

  it("renders neither hand-over control when the page says this fixture may not be handed over", () => {
    const html = consoleHtml({ deviceHandover: false });
    expect(html).not.toContain('data-role="device-handover"');
    expect(html).not.toContain('data-role="device-handover-phone"');
  });

  // Fix round 1 (CRITICAL) — the phone icon used to be gated on
  // `deviceHandover` alone while the `DeviceLinkPanel` it discloses sits
  // behind `scoring && home && away`. A TBD fixture (home/away null) with
  // `canEdit`/`deviceHandover` both true rendered a control that opened
  // nothing. `canHandOver` now folds in `!!home && !!away` too, so neither
  // copy renders here.
  it("renders NEITHER hand-over control on a TBD fixture — the panel it opens needs home AND away", () => {
    const html = consoleHtml({ home: null, away: null });
    expect(html).not.toContain('data-role="device-handover"');
    expect(html).not.toContain('data-role="device-handover-phone"');
  });

  it("ships a phone-only match-details toggle, closed, and hides the meta line behind it on phones", () => {
    const html = consoleHtml();
    expect(html).toMatch(/data-role="match-details-toggle"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/data-role="match-details-toggle"[^>]*class="[^"]*\smd:hidden"/);
    // The round/venue/recorded-by line — real English catalog, so this reads
    // "… recorded by the referee", never the "score.recordedBy" key.
    const metaIdx = html.indexOf("recorded by the referee");
    expect(metaIdx, "the round/venue/recorded-by line must still render").toBeGreaterThan(-1);
    // Fix round 1 (Minor) — a bare `lastIndexOf` of the class string only had
    // teeth because no earlier element happened to carry this exact full
    // class attribute; assert the wrapper element itself: its opening tag
    // sits before the meta text, and its OWN closing tag sits after it (so
    // the text is still inside the wrapper, not past it).
    const wrapperOpen = html.lastIndexOf('<div class="max-md:hidden">', metaIdx);
    expect(
      wrapperOpen,
      "closed by default, the meta line must sit inside its OWN max-md:hidden wrapper div",
    ).toBeGreaterThan(-1);
    const wrapperClose = html.indexOf("</div>", wrapperOpen);
    expect(
      wrapperClose,
      "the meta text must still be inside the wrapper when it closes, not after",
    ).toBeGreaterThan(metaIdx);
  });

  it("hides the Scoring heading on phones — the strip is the heading there", () => {
    const html = consoleHtml();
    // Real English catalog again: "score.scoring" renders as "Scoring".
    expect(html).toMatch(/<h2[^>]*class="[^"]*\smax-md:hidden"[^>]*>[^<]*Scoring</);
  });

  // Fix round 1 (Important 2) — every test above defaults to `status:
  // "in_play"`, so `started` is always true and the Scoring header row's
  // `!started` branch (Start match) never rendered in any assertion. Pin the
  // one condition that could strand it: before kickoff, the row itself must
  // stay reachable at phone widths even though the Scoring <h2> inside it
  // keeps hiding there (the strip is the heading once started).
  it("keeps the Scoring header row (and Start match) reachable on phones before kickoff", () => {
    const html = consoleHtml({ status: "scheduled" });
    const row = /<div class="(mb-3 flex flex-wrap items-center justify-between gap-2[^"]*)">/.exec(html);
    expect(row, "the Scoring header row must render").not.toBeNull();
    expect(
      row![1],
      "before kickoff the row itself carries no phone-hide class — Start match must stay reachable",
    ).toBe("mb-3 flex flex-wrap items-center justify-between gap-2");
    expect(html).toMatch(/<h2[^>]*class="[^"]*\smax-md:hidden"[^>]*>[^<]*Scoring</);
    expect(html).toContain("Start match");
  });
});
