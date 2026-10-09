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
import { isValidElement } from "react";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { builtinModules } from "@seazn/engine/sports";
import { foldMatch } from "@seazn/engine/core";
import { defaultLineupPair, makeEnvelope } from "@seazn/engine/testkit";
import { FixtureConsole } from "@/components/v2/fixture-console";
import { messages } from "@/lib/messages";
import type { EventIn, FixtureStreamMount, LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";
import { StreamSessionProvider } from "@/components/v2/stream-session-provider";
import type { StreamPanelContext } from "@/components/v2/fixture-stream-panel";
import type { StreamSessionView } from "@/lib/stream-session-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  // T9b: the "panel" mount renders the stream panel itself, which reads the URL (its return params).
  usePathname: () => "/o/org/c/comp/d/div/f/1",
  useSearchParams: () => new URLSearchParams(""),
}));
// The stop-only stream mount renders `PhoneStopProbe`, whose session hook asks for the page's confirm dialog. Its reads
// run in effects, so they are inert under `renderToStaticMarkup`; the dialog itself is doubled (the page provides it).
vi.mock("@/components/ui/confirm-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/confirm-provider")>()),
  useConfirm: () => async () => true,
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

type ConsoleOver = {
    status?: string;
    outcome?: unknown;
    deviceHandover?: boolean;
    // Fix round 1 (Task 4, CRITICAL) — lets a test render a TBD fixture
    // (home/away null) to prove the phone hand-over icon shares its gate
    // with the panel it opens, rather than always defaulting both sides in.
    home?: SideInfo | null;
    away?: SideInfo | null;
    /** The console's OWN canEdit (`canScore && !frozen`) — false is the read-only (frozen) shape. */
    canEdit?: boolean;
    /** W2a X-ST-2 — the viewer is an organiser (owner/admin). False is an accepted official scorer: may score, but
     *  settle/forfeit/abandon are refused to them on the server. */
    canOrganise?: boolean;
    /** W2a Task 11 — the fixture's stage kind; a bracket kind is what makes a level result HELD. */
    stageKind?: string | null;
    /** Spec 2026-09-30 §2 — the page's stream mount and its `?stream=open`. */
    stream?: FixtureStreamMount;
    streamReturn?: boolean;
    /** T9b: the page's shared stream session, seeded through `StreamSessionProvider`'s test seam (the server never
     *  passes it). The console's own provider for the same fixture adds nothing beneath it, so this IS what it reads. */
    streamView?: StreamSessionView | null;
    /** W2a fix round 1 (I1) — a fixture of ANOTHER sport: its SportInfo, folded state, ledger and pad pin. */
    other?: { sport: SportInfo; state: unknown; events: EventIn[]; moduleVersion: string; resolvedConfig: unknown };
};
/** The console element the page renders for `over` (no outer provider). */
function consoleTree(over: ConsoleOver = {}) {
  const status = over.status ?? "in_play";
  const live: LiveState = {
    status,
    last_seq: 2,
    summary: { headline: "1 — 0" },
    // P1 follow-up: a SCHEDULED fixture has no match_states row, so the page serves `state: null`
    // (getFixtureState: `row.state ?? null`). This harness used to pass `{}` for every fixture, so no console test
    // ever rendered the shape a scheduled fixture really has — and a scheduled chess knockout crashed in production.
    state: over.other !== undefined ? over.other.state : status === "scheduled" ? null : {},
    outcome: over.outcome ?? null,
  };
  const tree = (
    <FixtureConsole
      fixture={{
        id: "f1",
        status,
        scheduled_at: null,
        venue_name: null,
        court_name: null,
        round_no: 1,
      }}
      sport={over.other?.sport ?? sport}
      home={over.home !== undefined ? over.home : side("e-home", "Riverside FC")}
      away={over.away !== undefined ? over.away : side("e-away", "Summit Athletic")}
      initialState={live}
      initialEvents={status === "scheduled" ? [] : (over.other?.events ?? EVENTS)}
      canEdit={over.canEdit ?? true}
      canOrganise={over.canOrganise ?? true}
      stageKind={over.stageKind ?? null}
      deviceHandover={over.deviceHandover ?? true}
      stream={over.stream}
      streamReturn={over.streamReturn}
      recorderNames={{ "user-1": "Dana Okafor" }}
      scorePadV2={{
        moduleVersion: over.other?.moduleVersion ?? football.version,
        resolvedConfig: over.other?.resolvedConfig ?? CFG,
        initialEvents: [],
        entitlements: {},
        stageKind: null,
        identity: { recordedBy: "user-1", deviceLinkId: null },
      }}
      viewerPlan="community"
    />
  );
  return tree;
}
function consoleHtml(over: ConsoleOver = {}): string {
  const tree = consoleTree(over);
  return renderToStaticMarkup(
    over.streamView === undefined ? tree : <StreamSessionProvider fixtureId="f1" initialView={over.streamView}>{tree}</StreamSessionProvider>,
  );
}

/** A minimal session as `current` returns it — what the Stream control and the stop probe read. */
function streamView(state: StreamSessionView["state"], output: StreamSessionView["output"] = null): StreamSessionView {
  return {
    id: `s-${state}`,
    fixtureId: "f1",
    state,
    output,
    ingest: null,
    startedAt: state === "live" || state === "ending" ? "2026-09-30T12:00:00.000Z" : null,
    endedAt: null,
    target: { id: "t1", kind: "youtube", label: "Club YouTube" },
  } as unknown as StreamSessionView;
}

/** The "panel" mount — the whole Stream panel (entitled, not frozen) — with the relay off, so its Phone tab renders the
 *  switched-off line and fetches nothing. */
const PANEL_MOUNT: FixtureStreamMount = {
  mode: "panel",
  context: {
    entitled: true,
    relayEntitled: false,
    relayDisabled: false,
    sportKey: "football",
    overlayDict: {},
    orgId: "o-1",
    streamBalance: 2,
    streamSplit: null,
    monthlyAllowance: 0,
    currency: "gbp",
    overlayKeys: {},
    phoneCapture: true,
    phoneLostMinutes: 15,
    autoStopMinutes: 3,
  } satisfies StreamPanelContext,
  fixture: { id: "f1", status: "finalized", outcome: null, scheduled_at: null, home_entrant_id: "e-home", away_entrant_id: "e-away" },
  entrantNames: { "e-home": "Riverside FC", "e-away": "Summit Athletic" },
  tz: "UTC",
};

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

describe("W2a: held bracket fixtures and organiser-only actions (finding 11, finding 27, X-ST-2, ruling C12)", () => {
  const HELD = { status: "needs_decision", outcome: { kind: "draw" }, stageKind: "knockout" } as const;
  const BLOCK = 'data-testid="needs-decision"';
  const FINALIZE = 'data-testid="score-finalize"';

  it("X-ST-2: an organiser is offered Forfeit and Abandon; an official scorer (canOrganise false) is offered neither", () => {
    const organiser = bandHtml(consoleHtml({ canOrganise: true }));
    expect(organiser).toContain('data-testid="score-forfeit"');
    expect(organiser).toContain(">Abandon…<");
    const scorer = consoleHtml({ canOrganise: false });
    expect(scorer).not.toContain('data-testid="score-forfeit"');
    expect(scorer).not.toContain(">Abandon…<");
    // Nothing left to offer ⇒ no empty "Match actions" container either.
    expect(scorer).not.toContain('data-role="match-actions"');
  });

  it("a scorer still finalizes a decided match: Finalize is not organiser-only", () => {
    expect(bandHtml(consoleHtml({ canOrganise: false, outcome: { kind: "win", winner: "e-home" } }))).toContain(FINALIZE);
  });

  it("finding 27 + C12: a held knockout fixture shows the block and hides Finalize, for the organiser", () => {
    const html = consoleHtml(HELD);
    expect(html).toContain(BLOCK);
    expect(html, "D-H3: a level result says so").toContain('data-cause="level"');
    expect(html).toContain('data-testid="settle-open"');
    expect(html).not.toContain(FINALIZE);
  });

  it("the positive pair: the same level result in a LEAGUE is a result — no block, Finalize offered", () => {
    const html = consoleHtml({ ...HELD, status: "decided", stageKind: "league" });
    expect(html).not.toContain(BLOCK);
    expect(html).toContain(FINALIZE);
  });

  /** The REAL fold of a drawn chess knockout game (I1's rig): phase "tiebreak", status in_play, outcome null. */
  function chessTiebreak() {
    const chess = builtinModules.find((m) => m.key === "boardgame")!;
    const ko = chess.configSchema.parse({ ...chess.bracketDeciders!(chess.configSchema.parse({})) });
    const lineups = defaultLineupPair(chess.positions);
    const ledger = [
      makeEnvelope(1, { type: "core.start", payload: {} } as never),
      makeEnvelope(2, { type: "boardgame.result", payload: { winner: null, method: "agreement" } } as never),
    ];
    const state = foldMatch(chess, ko, lineups, ledger);
    expect((state as { phase?: string }).phase, "the rig must reach the tie-break").toBe("tiebreak");
    const events: EventIn[] = ledger.map((e, i) => ({ ...EVENTS[0]!, id: `ev-${i + 1}`, seq: i + 1, type: e.type, payload: e.payload as Record<string, unknown> }));
    return { sport: { ...sport, key: "boardgame", scorerLabel: "Arbiter", lineupSize: 1 }, state, events, moduleVersion: chess.version, resolvedConfig: ko };
  }

  it("I1: a chess knockout in its tie-break is HELD — the organiser gets the block and NO Forfeit/Abandon (held: the settle is the way out — the engine refuses forfeit WRONG_PHASE but would take an abandon)", () => {
    // The REAL fold: a drawn knockout game opens phase "tiebreak" with status in_play and outcome null — not `decided`,
    // so only the held gate keeps the band's two organiser writes off it (boardgame.ts refuses a forfeit in this phase;
    // an abandon it accepts — tiebreak.test.ts — so the gate, not the engine, keeps Abandon off a held match).
    const chess = builtinModules.find((m) => m.key === "boardgame")!;
    const ko = chess.configSchema.parse({ ...chess.bracketDeciders!(chess.configSchema.parse({})) });
    const lineups = defaultLineupPair(chess.positions);
    const ledger = [
      makeEnvelope(1, { type: "core.start", payload: {} } as never),
      makeEnvelope(2, { type: "boardgame.result", payload: { winner: null, method: "agreement" } } as never),
    ];
    const state = foldMatch(chess, ko, lineups, ledger);
    expect((state as { phase?: string }).phase, "the rig must reach the tie-break").toBe("tiebreak");
    const events: EventIn[] = ledger.map((e, i) => ({ ...EVENTS[0]!, id: `ev-${i + 1}`, seq: i + 1, type: e.type, payload: e.payload as Record<string, unknown> }));
    const other = {
      sport: { ...sport, key: "boardgame", scorerLabel: "Arbiter", lineupSize: 1 },
      state,
      events,
      moduleVersion: chess.version,
      resolvedConfig: ko,
    };
    const held = consoleHtml({ status: "in_play", outcome: null, stageKind: "knockout", other });
    expect(held, "the tie-break is owed: the block shows").toContain(BLOCK);
    expect(held, "D-H3: and says the tie-break is what is owed").toContain('data-cause="tiebreak"');
    expect(held).not.toContain('data-testid="score-forfeit"');
    expect(held).not.toContain(">Abandon…<");
    // The positive pair: the SAME chess game in play, before the draw, still offers both to the organiser.
    const live = foldMatch(chess, ko, lineups, ledger.slice(0, 1));
    const open = consoleHtml({ status: "in_play", outcome: null, stageKind: "knockout", other: { ...other, state: live, events: events.slice(0, 1) } });
    expect(open).not.toContain(BLOCK);
    expect(bandHtml(open)).toContain('data-testid="score-forfeit"');
    expect(bandHtml(open)).toContain(">Abandon…<");
  });

  it("P1 follow-up: a SCHEDULED chess knockout renders its console — not held, Start match offered (the page serves state null before kickoff)", () => {
    const rig = chessTiebreak();
    const html = consoleHtml({ status: "scheduled", outcome: null, stageKind: "knockout", other: { ...rig, state: null, events: [] } });
    expect(html).toContain("Start match");
    expect(html, "nothing is owed before the game is played").not.toContain(BLOCK);
    expect(html).not.toContain(FINALIZE);
    // The positive pair is I1 above: the same sport, stage kind and module pin, drawn, IS held.
  });

  it("an official scorer on a held fixture sees no block and no Settle (the settle is organiser-only)", () => {
    const html = consoleHtml({ ...HELD, canOrganise: false });
    expect(html, "the scorer still sees the fixture is held — its status reads so").toContain(">Needs a decision<");
    // Fix round 1 (M6): `.badge` is `capitalize` (globals.css), which Title-Cased the localised word ("Needs A
    // Decision") — a textContent assertion is blind to it, so the class is pinned on the badge that carries the word.
    expect(html).toMatch(/<span class="badge [^"]*\bnormal-case\b[^"]*">Needs a decision<\/span>/);
    expect(html).not.toContain(BLOCK);
    expect(html).not.toContain('data-testid="settle-open"');
    expect(html).not.toContain(FINALIZE);
  });

  it("M7: the official scorer on a held fixture is told WHY it is held — one line; the organiser (who has the block) and a scorer on a live match are not", () => {
    const NOTE = 'data-testid="held-note"';
    const WAITING = messages["score.needsDecision.waiting"];
    const scorer = consoleHtml({ ...HELD, canOrganise: false });
    expect(scorer).toContain(NOTE);
    expect(scorer).toContain(WAITING);
    expect(consoleHtml(HELD), "the organiser has the block instead").not.toContain(NOTE);
    expect(consoleHtml({ canOrganise: false }), "a scorer on a live match").not.toContain(NOTE);
  });

  it("N2 (fix round 2): an official on a chess TIE-BREAK is told to record it on the pad — never to wait for the organiser; level and abandoned holds keep the organiser line", () => {
    const NOTE = /<p data-testid="held-note" data-cause="([a-z]+)"[^>]*>([^<]*)<\/p>/;
    const WAITING = messages["score.needsDecision.waiting"];
    const TIEBREAK = messages["score.needsDecision.waiting.tiebreak"];
    // Empty case first: the two lines are different words (a key that fell back to the other would pass on its inversion).
    expect(TIEBREAK).toBeTypeOf("string");
    expect(TIEBREAK).not.toBe(WAITING);
    const note = (html: string) => {
      const m = NOTE.exec(html);
      return m === null ? null : { cause: m[1], text: m[2]!.replaceAll("&#x27;", "'") };
    };
    // The REAL fold (I1's rig) at canOrganise false: in_play, outcome null, held by the pending tie-break.
    const tiebreak = consoleHtml({ status: "in_play", outcome: null, stageKind: "knockout", canOrganise: false, other: chessTiebreak() });
    expect(note(tiebreak)).toEqual({ cause: "tiebreak", text: TIEBREAK });
    expect(tiebreak, "the organiser's line is not shown on a tie-break").not.toContain(WAITING);
    // The organiser line stays where the organiser IS what happens next: a level result, and an abandon that decided nobody.
    const abandoned = consoleHtml({
      status: "abandoned",
      outcome: null,
      stageKind: "knockout",
      canOrganise: false,
      other: { ...chessTiebreak(), events: [{ ...EVENTS[0]! }, { ...EVENTS[0]!, id: "ev-2", seq: 2, type: "core.abandon", payload: { reason: "rain" } }] },
    });
    const rows = [
      { name: "level", html: consoleHtml({ ...HELD, canOrganise: false }), want: { cause: "level", text: WAITING } },
      { name: "abandoned", html: abandoned, want: { cause: "abandoned", text: WAITING } },
    ];
    let checked = 0;
    for (const r of rows) {
      expect(note(r.html), r.name).toEqual(r.want);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("m5 (fix round 2): the official's held note sits straight under the Scoring card — above the ledger and the lineups", () => {
    const html = consoleHtml({ ...HELD, canOrganise: false });
    const scoring = html.indexOf('data-role="console-scoring"');
    const note = html.indexOf('data-testid="held-note"');
    const ledger = html.indexOf('data-role="v3-activity"');
    const lineups = html.indexOf('data-testid="lineup-editor"');
    expect(scoring).toBeGreaterThan(-1);
    expect(note, "the note follows the Scoring card").toBeGreaterThan(scoring);
    expect(ledger, "the rig renders the ledger").toBeGreaterThan(-1);
    expect(lineups, "the rig renders the lineups").toBeGreaterThan(-1);
    expect(note, "above the ledger").toBeLessThan(ledger);
    expect(note, "above the lineups").toBeLessThan(lineups);
  });
  it("loop R M7(a): an official on a held fixture gets NO empty Scoring card at any width — and the card stays wherever it holds something", () => {
    // At 1280 and 768 the card rendered its "Scoring" heading over nothing (no pad once held, no hand-over, no stream):
    // the phone gate (`consoleScoringEmptyOnPhone`) hid it below md only. The class token is read exactly — "hidden",
    // never the phone-only "max-md:hidden".
    const tokens = (html: string) => /<section class="([^"]*)" data-role="console-scoring"/.exec(html)?.[1]?.split(/\s+/) ?? null;
    // Empty case first: nothing in the card at ANY width.
    const empty = tokens(consoleHtml({ ...HELD, canOrganise: false, deviceHandover: false }));
    expect(empty, "the section still renders, hidden, so the held note keeps its place after it").not.toBeNull();
    expect(empty).toContain("hidden");
    // Each thing that does fill the card keeps it shown — one row per content source.
    const rows: [string, string][] = [
      ["organiser (hand-over button)", consoleHtml(HELD)],
      ["official with the hand-over", consoleHtml({ ...HELD, canOrganise: false })],
      ["official with a stream", consoleHtml({ ...HELD, canOrganise: false, deviceHandover: false, stream: PANEL_MOUNT })],
      ["official on a live match (the pad)", consoleHtml({ canOrganise: false, deviceHandover: false })],
    ];
    let checked = 0;
    for (const [name, html] of rows) {
      const t = tokens(html);
      expect(t, name).not.toBeNull();
      expect(t!.includes("hidden"), name).toBe(false);
      checked++;
    }
    expect(checked).toBe(rows.length);
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
  it("offers Remote scoring twice (D4): the desktop button hides on phones, the phone icon hides on desktop, and both share one accessible name", () => {
    const html = consoleHtml({ deviceHandover: true });
    expect(html).toMatch(/data-role="device-handover"[^>]*class="[^"]*\smax-md:hidden"/);
    expect(html).toMatch(/data-role="device-handover"[^>]*>Remote scoring</);
    expect(html).toMatch(/<button[^>]*data-role="device-handover-phone"[^>]*>/);
    expect(html).toMatch(/data-role="device-handover-phone"[^>]*class="[^"]*\smd:hidden"/);
    expect(html).toMatch(/data-role="device-handover-phone"[^>]*aria-label="Remote scoring"/);
  });

  // Spec 2026-09-30 §2 (P1): Stream is the SECOND control that exists twice, beside Remote scoring.
  it("offers Stream twice when mounted: desktop btn-ghost min-h-11 max-md:hidden, phone 44px md:hidden, one accessible name — and BEFORE the hand-over control in both places", () => {
    const html = consoleHtml({ deviceHandover: true, stream: { mode: "stop-only" } });
    expect(html).toMatch(/data-role="fixture-stream"[^>]*class="btn btn-ghost min-h-11\smax-md:hidden"/);
    expect(html).toMatch(/data-role="fixture-stream"[^>]*>Stream</);
    expect(html).toMatch(/data-role="fixture-stream-phone"[^>]*class="[^"]*\sh-11 w-11\s[^"]*\smd:hidden"/);
    expect(html).toMatch(/data-role="fixture-stream-phone"[^>]*aria-label="Stream"/);
    expect(html.indexOf('data-role="fixture-stream-phone"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-role="fixture-stream-phone"')).toBeLessThan(html.indexOf('data-role="device-handover-phone"'));
    expect(html.indexOf('data-role="fixture-stream"')).toBeLessThan(html.indexOf('data-role="device-handover"'));
  });

  it("renders neither Stream control without a mount — the positive pair's other half", () => {
    const html = consoleHtml({ deviceHandover: true });
    expect(html).not.toMatch(/data-role="fixture-stream"/);
    expect(html).not.toMatch(/data-role="fixture-stream-phone"/);
    expect(html).not.toMatch(/data-role="console-stream"/);
  });

  it("Review Focus 4: Stream stays reachable when the Scoring section does not render — finalized, cancelled, read-only (frozen) and TBD-sided", () => {
    const shapes: { name: string; props: Parameters<typeof consoleHtml>[0] }[] = [
      { name: "finalized", props: { status: "finalized" } },
      { name: "cancelled", props: { status: "cancelled" } },
      { name: "read-only", props: { canEdit: false } },
      { name: "TBD side", props: { away: null } },
    ];
    let checked = 0;
    for (const s of shapes) {
      const html = consoleHtml({ ...s.props, stream: { mode: "stop-only" } });
      expect(html, s.name).not.toMatch(/data-role="console-scoring"/);
      expect(html, s.name).toMatch(/data-role="console-stream"/);
      expect(html, s.name).toMatch(/data-role="fixture-stream"/);
      expect(html, s.name).toMatch(/data-role="fixture-stream-phone"/);
      // Closed, the card is an empty box on a phone — it hides there until the strip icon opens it.
      expect(html, s.name).toMatch(/<section class="card p-5 max-md:p-3 max-md:hidden" data-role="console-stream">/);
      // …and it holds the ONE desktop Stream button.
      expect(html.match(/data-role="fixture-stream"/g), s.name).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(4);
  });

  // B3 fix round 1, Minor 6: the OPEN fallback card must show on a phone — the path an organiser at the court takes on a
  // finalized or frozen fixture (the strip icon). Its closed class is pinned above; this pins the open one, anchored on the
  // whole attribute value so a class list that still carries `max-md:hidden` cannot match.
  // B3 N-2 (T9b): the card names itself ALWAYS — open or closed, in BOTH mounts. The panel inside no longer carries a
  // visible title (spec §3.1: no heading, the frame is labelled for assistive tech), and the stop probe never did.
  it("the OPEN fallback card shows on phones (no max-md:hidden); open or closed, in BOTH mounts, it keeps its own heading", () => {
    const shapes: { name: string; props: Parameters<typeof consoleHtml>[0] }[] = [
      { name: "finalized", props: { status: "finalized" } },
      { name: "cancelled", props: { status: "cancelled" } },
      { name: "read-only", props: { canEdit: false } },
      { name: "TBD side", props: { away: null } },
    ];
    const mounts: { name: string; stream: FixtureStreamMount }[] = [
      { name: "stop-only", stream: { mode: "stop-only" } },
      { name: "panel", stream: PANEL_MOUNT },
    ];
    const heading = `<h2 class="text-sm font-semibold text-slate-700">${messages["stream.title"]}</h2>`;
    let checked = 0;
    for (const s of shapes) for (const mount of mounts) {
      const at = `${s.name}, ${mount.name}`;
      const open = consoleHtml({ ...s.props, stream: mount.stream, streamReturn: true });
      expect(open, `${at}: open`).toMatch(/<section class="card p-5 max-md:p-3" data-role="console-stream">/);
      expect(open, `${at}: the body is inside the card`).toMatch(/data-role="console-stream">[\s\S]*data-role="fixture-stream-body"/);
      expect(open.split(heading).length - 1, `${at}: open, the card names itself once`).toBe(1);
      const closed = consoleHtml({ ...s.props, stream: mount.stream });
      expect(closed, `${at}: closed`).toMatch(/<section class="card p-5 max-md:p-3 max-md:hidden" data-role="console-stream">/);
      expect(closed.split(heading).length - 1, `${at}: closed, the card names itself once`).toBe(1);
      checked++;
    }
    expect(checked).toBe(shapes.length * mounts.length);
    // The panel mount really rendered the panel: its frame carries the name the card's heading shows.
    const panelOpen = consoleHtml({ status: "finalized", stream: PANEL_MOUNT, streamReturn: true });
    expect(panelOpen).toContain(`data-testid="stream-panel" aria-label="${messages["stream.title"]}"`);
    expect(panelOpen, "the panel has no visible heading of its own").not.toMatch(/data-testid="stream-panel"[^>]*>\s*<h3/);
  });

  // Spec §2 (T9b): the Stream button's dot and label read the page's ONE session — the same one the panel reads.
  it("the Stream control's dot and label follow the shared session: none idle, red + 'Live' while live, amber while waiting — both twins", () => {
    const dotOf = (html: string, role: string) => new RegExp(`data-role="${role}"[^>]*data-dot="([a-z]+)"`).exec(html)?.[1] ?? null;
    const labelOf = (html: string) => /data-role="fixture-stream"[^>]*>(?:<span[^>]*><\/span>)?([^<]*)</.exec(html)?.[1];
    const ariaOf = (html: string) => /data-role="fixture-stream-phone"[^>]*aria-label="([^"]*)"/.exec(html)?.[1];
    const rows: { name: string; view: StreamSessionView | null; dot: string | null; label: string }[] = [
      { name: "no session", view: null, dot: null, label: messages["stream.button"] },
      { name: "waiting", view: streamView("warming"), dot: "amber", label: messages["stream.button"] },
      { name: "live", view: streamView("live", { state: "ok", since: "2026-09-30T12:00:00.000Z", elapsedMs: 0 } as never), dot: "red", label: messages["stream.buttonLive"] },
      { name: "live, D3", view: streamView("live", { state: "connecting", since: "2026-09-30T12:00:00.000Z", elapsedMs: 30_000 } as never), dot: "amber", label: messages["stream.buttonLive"] },
      { name: "ended", view: streamView("completed"), dot: null, label: messages["stream.button"] },
    ];
    let checked = 0;
    for (const r of rows) {
      const html = consoleHtml({ stream: { mode: "stop-only" }, streamView: r.view });
      expect(dotOf(html, "fixture-stream"), `${r.name}: desktop dot`).toBe(r.dot);
      expect(dotOf(html, "fixture-stream-phone"), `${r.name}: phone dot`).toBe(r.dot);
      expect(labelOf(html), `${r.name}: desktop label`).toBe(r.label);
      // WCAG 1.4.1: the dot is colour only, so the icon twin's NAME says it too.
      expect(ariaOf(html), `${r.name}: the phone twin's accessible name`).toBe(r.label);
      if (r.dot === null) expect(html, `${r.name}: no data-dot at all`).not.toContain('data-dot="');
      checked++;
    }
    expect(checked).toBe(rows.length);
    expect(messages["stream.buttonLive"], "the case can witness the label change").not.toBe(messages["stream.button"]);
  });

  it("the fallback card is absent whenever the Scoring section renders (no second Stream button)", () => {
    const html = consoleHtml({ stream: { mode: "stop-only" } });
    expect(html).toMatch(/data-role="console-scoring"/);
    expect(html).not.toMatch(/data-role="console-stream"/);
    expect(html.match(/data-role="fixture-stream"/g)).toHaveLength(1);
  });

  it("?stream=open opens the stream panel on first render (streamReturn), and only then", () => {
    const opened = consoleHtml({ stream: { mode: "stop-only" }, streamReturn: true });
    expect(opened).toMatch(/data-role="fixture-stream"[^>]*aria-expanded="true"/);
    expect(opened).toMatch(/data-role="fixture-stream-phone"[^>]*aria-expanded="true"/);
    expect(opened).toMatch(/data-role="fixture-stream-body"/);
    // One panel at a time: the hand-over panel is closed while Stream is open.
    expect(opened).toMatch(/data-role="device-handover"[^>]*aria-expanded="false"/);
    const closed = consoleHtml({ stream: { mode: "stop-only" } });
    expect(closed).toMatch(/data-role="fixture-stream"[^>]*aria-expanded="false"/);
    expect(closed).not.toMatch(/data-role="fixture-stream-body"/);
    // A return param with no mount opens nothing (there is nothing to open).
    expect(consoleHtml({ streamReturn: true })).not.toMatch(/data-role="fixture-stream-body"/);
  });

  it("an OPEN stream panel keeps a started, pad-less Scoring section on phones — exactly as an open hand-over panel does", () => {
    // Decided football: the pad unmounts (no post-phase panel), so the section would hide on a phone…
    const decided = { outcome: { kind: "win", winner: "e-home" } };
    const scoringClass = (html: string) => /<section class="([^"]*)" data-role="console-scoring">/.exec(html)?.[1];
    expect(scoringClass(consoleHtml({ ...decided, stream: { mode: "stop-only" } })), "closed: nothing to show on a phone").toBe(
      "card p-5 max-md:p-3 max-md:hidden",
    );
    // …unless the stream panel is open inside it.
    expect(scoringClass(consoleHtml({ ...decided, stream: { mode: "stop-only" }, streamReturn: true }))).toBe("card p-5 max-md:p-3");
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
    // Review fix (final wave, MINOR 7): the wrapper now also carries
    // `id="match-details-body"`, matched by the toggle's own `aria-controls`.
    const wrapperOpen = html.lastIndexOf('<div class="max-md:hidden" id="match-details-body">', metaIdx);
    expect(
      wrapperOpen,
      "closed by default, the meta line must sit inside its OWN max-md:hidden wrapper div",
    ).toBeGreaterThan(-1);
    const wrapperClose = html.indexOf("</div>", wrapperOpen);
    expect(
      wrapperClose,
      "the meta text must still be inside the wrapper when it closes, not after",
    ).toBeGreaterThan(metaIdx);
    expect(
      html,
      "the toggle points aria-controls at the region it actually opens/closes",
    ).toMatch(/data-role="match-details-toggle"[^>]*aria-controls="match-details-body"/);
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

// B5 review m-1: the console's root ELEMENT TYPE must not depend on whether the page mounts a stream. A stop-only mount
// whose session ends turns `stream` null on the next `router.refresh()` (every scored event); a root that flips between
// `<StreamSessionProvider>` and the bare tree remounts the pad, the disclosures and the ledger mid-match. So the
// provider is always there, and `enabled` says whether it polls.
describe("the console root is stable across the stream mount (B5 review m-1)", () => {
  it("every mount shape — none, stop-only, panel — renders the SAME root element type; only `enabled` differs", () => {
    const shapes: { name: string; stream: FixtureStreamMount | undefined; polls: boolean }[] = [
      { name: "no stream", stream: undefined, polls: false },
      { name: "stop-only", stream: { mode: "stop-only" }, polls: true },
      { name: "panel", stream: PANEL_MOUNT, polls: true },
    ];
    const roots = shapes.map((shape) => {
      const island = renderIsland(FixtureConsole, consoleTree({ stream: shape.stream }).props);
      const out = island.tree()[0];
      island.unmount();
      expect(isValidElement(out), `${shape.name}: the console rendered an element`).toBe(true);
      return { ...shape, root: out! };
    });
    expect(roots.length).toBe(3);
    for (const r of roots) {
      expect(r.root.type, `${r.name}: the root is the session provider`).toBe(StreamSessionProvider);
      expect((r.root.props as { enabled?: boolean }).enabled, `${r.name}: polls only with a stream mounted`).toBe(r.polls);
    }
  });
});
