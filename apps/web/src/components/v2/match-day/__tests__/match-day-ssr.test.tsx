// Match Day, task A3 (spec docs/superpowers/specs/2026-10-31-match-day-design.md §6, §7): the court list and the focused
// court, rendered to markup. apps/web vitest is `environment: "node"`, so these see what the server paints (and what a first
// client render paints); the call → Called → Undo sequence in a real browser is e2e/match-day.spec.ts.
//
// Assertions on attributes anchor on `="` (AGENTS.md: React serialises an omitted prop as "$undefined", so a bare `data-*`
// probe passes in both states). Expected copy is read from the dictionaries, the court noun from lib/venue.ts's own
// declarations, the sport list from the engine's registry and every scoreboard's summary from the engine's own fold of its
// recorded golden streams — never from the components under test.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EngineError, foldMatchWithStoppage, outcomeOf, summaryOf, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { registerBuiltins } from "@seazn/engine/sports";
import { registry, resolvePositions, type AnySportModule, type SportRegistry } from "@seazn/engine/sport";
import { defaultLineupPair, goldenCorpora } from "@seazn/engine/testkit";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import { routes } from "@/lib/routes";
import { VENUE_NOUNS, venueNoun } from "@/lib/venue";
import { CALL_REFUSAL, TBD_ENTRANT, type CallPreview } from "@/lib/match-day/call";
import type { MatchDayCandidate, MatchDayCourt, MatchDayFixture, MatchDaySummary, MatchDayView } from "@/lib/match-day/types";
import {
  callableCount,
  courtCounts,
  filterCandidates,
  filterCourts,
  isCandidateList,
  isLive,
  isMatchDayView,
  courtScorerAttention,
  needsYouButtonParts,
  needsYouOrder,
  needsYouTone,
  primaryCandidateId,
  REFUSAL_CODES,
  streamPreviewOf,
  refusalMessage,
  resolveFocus,
  sharedNoun,
} from "@/lib/match-day/view";
import { CourtList } from "@/components/v2/match-day/court-list";
import { CourtFocus, type MatchDayCtx } from "@/components/v2/match-day/court-focus";
import { CandidateRows, FreeCourtBody } from "@/components/v2/match-day/candidate-list";
import { CallSheetBody } from "@/components/v2/match-day/call-sheet";
import { DotLine, MatchDayShell } from "@/components/v2/match-day/match-day-shell";
import { NeedsYou, needsYouItems, type NeedsYouItem } from "@/components/v2/desk/needs-you";
import { ATTENTION_SEVERITY, type Attention } from "@/lib/division-phase";
import type { CompetitionDesk } from "@/server/usecases/competition-desk";
import { SCORER_ATTENTIONS } from "@/lib/match-day/types";
import { youtubeVideoId, youtubeWatchUrl } from "@/lib/youtube";

const dict = en as Dict;
const DICTS = { en, es, fr, nl } as Record<string, Dict>;
const pub = publicEn as Dict;

// ---- A match in play, as the ENGINE folds it (review I1: never a made-up headline) --------------------------------------

try {
  registerBuiltins(registry);
} catch (err) {
  // Another suite in this worker already booted the shared default registry.
  if (!EngineError.is(err, "MODULE_DUPLICATE")) throw err;
}

/** The golden corpora (@seazn/engine/testkit): each sport's recorded streams, found by walking the engine's tree. */
interface GoldenStream {
  config: string;
  lineups?: LineupPair;
  events: { type: string; payload: unknown; voids?: string }[];
}
const CORPORA = goldenCorpora().map(({ corpus }) => corpus as { key: string; configs: Record<string, unknown>; streams: GoldenStream[] });

/** Golden streams seat their entrants as "H" and "A". */
const HOME = { id: "H", name: "Harbour Rovers" };
const AWAY = { id: "A", name: "Avenue Athletic" };

/**
 * The engine's summary of a match IN PLAY for `key`: the latest prefix of one of its recorded golden streams that has scored
 * something, folds, is not decided, and satisfies `pick`. Longest streams first, longest prefix first. Null when the sport has
 * no corpus or no such moment — a sweep counts those apart, it never invents one.
 */
function inPlaySummary(key: string, pick: (s: MatchDaySummary) => boolean = () => true): MatchDaySummary | null {
  const corpus = CORPORA.find((c) => c.key === key);
  if (corpus === undefined) return null;
  const mod = registry.latest(key) as AnySportModule;
  for (const stream of [...corpus.streams].sort((a, b) => b.events.length - a.events.length)) {
    const cfg = mod.configSchema.parse(corpus.configs[stream.config]);
    const lineups = stream.lineups ?? defaultLineupPair(resolvePositions(mod, cfg));
    const envelopes: EventEnvelope[] = stream.events.map((e, i) => ({
      id: `e-${i}`,
      fixtureId: "fx-match-day",
      seq: i,
      type: e.type,
      payload: e.payload,
      recordedAt: new Date(Date.UTC(2026, 9, 31, 11, 0, i)).toISOString(),
      recordedBy: null,
      ...(e.voids === undefined ? {} : { voids: e.voids }),
    }));
    for (let k = envelopes.length; k >= 1; k--) {
      const prefix = envelopes.slice(0, k);
      if (!prefix.some((e) => !e.type.startsWith("core."))) break;
      let folded: ReturnType<typeof foldMatchWithStoppage>;
      try {
        folded = foldMatchWithStoppage(mod, cfg, lineups, prefix);
      } catch {
        continue; // a prefix the fold refuses (a void whose target is cut off): not a moment of play
      }
      if (outcomeOf(mod, folded) !== null) continue;
      const summary = summaryOf(mod, folded) as MatchDaySummary;
      if (summary.headline && pick(summary)) return summary;
    }
  }
  return null;
}

const detailOf = (s: MatchDaySummary): Record<string, unknown> =>
  typeof s.detail === "object" && s.detail !== null ? (s.detail as Record<string, unknown>) : {};
const hasSets = (s: MatchDaySummary): boolean => Array.isArray(detailOf(s).sets) && (detailOf(s).sets as unknown[]).length > 0;
/** A set sport's summary as the engine reports it: two sides, each with its games/sets won as its line. */
const isSetSport = (s: MatchDaySummary): boolean => hasSets(s) && (s.perSide?.length ?? 0) === 2;
type SetRow = { home: number; away: number; closed: boolean };
const setsOf = (s: MatchDaySummary): SetRow[] => detailOf(s).sets as SetRow[];
/** The engine's own live points: the headline's trailing "(…)" ("19–19", tennis's "40–Ad"); null between games. */
const livePointsOf = (s: MatchDaySummary): string | null => /\(([^)]*)\)\s*$/.exec(s.headline!)?.[1] ?? null;
/** The spec's rule (§6.2, review V3): a set sport's large type is games or sets won, "0 – 1"; any other sport keeps its own
 *  headline (LiveScoreBody's). */
const gamesWon = (s: MatchDaySummary): string => `${s.perSide![0]!.line} – ${s.perSide![1]!.line}`;
/** React's text escaping, for matching a text node in static markup. */
const esc = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** Badminton mid-game 2: game 1 closed, game 2 open with points on the board ("… (19–19)"). */
const BADMINTON = inPlaySummary(
  "badminton",
  (s) =>
    isSetSport(s) &&
    livePointsOf(s) !== null &&
    setsOf(s).some((x) => x.closed) &&
    setsOf(s).some((x) => !x.closed && x.home + x.away > 0),
);
/** Tennis with the server known: the serve marker's source. */
const TENNIS = inPlaySummary("tennis", (s) => detailOf(s).serving === "home" || detailOf(s).serving === "away");

const ctx: MatchDayCtx = {
  competitionId: "comp-1",
  orgSlug: "acme",
  compSlug: "safe-badminton",
  locale: "en",
  tz: "Europe/London",
  dict,
  scoreDict: publicEn as Dict,
  viewerPlan: "pro",
};

const fx = (o: Partial<MatchDayFixture> = {}): MatchDayFixture => ({
  id: "f-1",
  division_id: "d-u14",
  division_name: "Girls U14",
  division_slug: "girls-u14",
  fixture_no: 7,
  sport_key: "badminton",
  stage_label: "Swiss round 3",
  home: "Zara Khan",
  away: "Ella Brooks",
  home_entrant_id: "e-zara",
  away_entrant_id: "e-ella",
  headline: "0 – 0 (13-11)",
  summary: null,
  serving: null,
  started_at: "2026-10-31T11:20:00.000Z",
  called_at: null,
  stream: null,
  scorer_attention: null,
  live_video: null,
  ...o,
});

const court = (o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: "c-3",
  court_name: "Court 3",
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "playing",
  current: fx(),
  in_use_by: null,
  free_since: null,
  queue: [],
  ...o,
});

const queued = (o: Partial<MatchDayFixture> = {}, planned = "2026-10-31T12:20:00.000Z", estimated = planned) => ({
  ...fx({ id: "q-1", home: "Isha Rao", away: "Lily Chen", headline: null, started_at: null, ...o }),
  planned_at: planned,
  estimated_at: estimated,
});

const cand = (o: Partial<MatchDayCandidate> = {}, f: Partial<MatchDayFixture> = {}): MatchDayCandidate => ({
  fixture: fx({ id: "x-1", home: "Anya Das", away: "Rhea Gill", headline: null, started_at: null, ...f }),
  source: "other_court",
  from_court_name: "Court 1",
  waiting_minutes: 15,
  behind_minutes: 0,
  blocked: null,
  ...o,
});

const view = (courts: MatchDayCourt[]): MatchDayView => ({
  competition_id: "comp-1",
  date: "2026-10-31",
  tz: "Europe/London",
  now: "2026-10-31T11:31:00.000Z",
  courts,
  needs_you: [],
  results_owed: 0,
  fixtures_today: 6,
});

const focus = (c: MatchDayCourt, notice: string | null = null) =>
  renderToStaticMarkup(
    <CourtFocus
      ctx={ctx}
      court={c}
      backLabel="All courts"
      onBack={() => {}}
      onChanged={() => {}}
      onRefused={() => {}}
      notice={notice}
      refreshKey="k"
      divisions={null}
    />,
  );

/** The large type of a set sport's panel: the element carrying `data-testid="md-score-large"`, to its closing tag. */
function largeOf(html: string): string {
  const at = html.indexOf('data-testid="md-score-large"');
  if (at < 0) return "";
  return html.slice(at, html.indexOf("</p>", at));
}

/** The scoreboard's own markup: from its section to the first section closing after it (LiveScoreBody nests none). */
function scoreboardOf(html: string): string {
  const at = html.indexOf('data-testid="md-scoreboard"');
  if (at < 0) return "";
  return html.slice(at, html.indexOf("</section>", at));
}

/** A playing court whose match is the golden summary's, seated as the corpus seats it. */
const goldenCourt = (key: string, summary: MatchDaySummary, o: Partial<MatchDayFixture> = {}) =>
  court({
    sport_noun: venueNoun(key),
    current: fx({
      sport_key: key,
      home: HOME.name,
      away: AWAY.name,
      home_entrant_id: HOME.id,
      away_entrant_id: AWAY.id,
      headline: summary.headline ?? null,
      summary,
      ...o,
    }),
  });

/** The markup of the element carrying `attr="value"`, up to the next sibling of the same testid — rows here are flat lists. */
function rowsOf(html: string, testId: string): string[] {
  const parts = html.split(`data-testid="${testId}"`);
  return parts.slice(1);
}

describe("focused court: playing", () => {
  it("C1 — no stream: the sport's scoreboard, a '+ Connect a stream' link to the match's stream panel, and no video slot", () => {
    expect(BADMINTON, "a badminton golden stream mid-game").not.toBeNull();
    const html = focus(goldenCourt("badminton", BADMINTON!, { stream: null }));
    const sb = scoreboardOf(html);
    expect(sb).not.toBe("");
    const connect = t(dict, "matchDay.stream.connect");
    expect(sb).toContain(connect);
    const streamHref = `${routes.fixture("acme", "safe-badminton", "girls-u14", 7)}?stream=open`;
    expect(html).toContain(`href="${streamHref}"`);
    // No empty black video box (§5 anti-goal): no player element and no preview slot.
    expect(html).not.toMatch(/<video|<iframe/);
    expect(html).not.toContain('data-testid="md-stream-preview"');
    expect(html).not.toContain('data-md-stream="');
  });

  it("V3 — a set sport: games won in large type, the CURRENT game's points beside them, never a finished game's score; the set table, both sides named", () => {
    const summary = BADMINTON!;
    expect(summary, "a badminton golden stream mid-game 2").not.toBeNull();
    const sb = scoreboardOf(focus(goldenCourt("badminton", summary)));
    const big = largeOf(sb);
    expect(big, "the large type").not.toBe("");
    // Expected values from the engine's own fold, read off its set table (never the headline the code reads).
    const sets = setsOf(summary);
    const open = sets.find((x) => !x.closed)!;
    const live = `${open.home}–${open.away}`;
    const closed = sets.filter((x) => x.closed).map((x) => `${x.home}–${x.away}`);
    expect(closed.length).toBeGreaterThan(0);
    expect(big).toContain(`>${gamesWon(summary)}<`);
    expect(big).toContain(`>${live}<`);
    for (const done of closed) {
      expect(done, "a finished game whose score differs from the live one (else the next line proves nothing)").not.toBe(live);
      expect(big).not.toContain(done);
    }
    // Nor the engine's one-line headline, whole or with its live points stripped.
    expect(sb).not.toContain(esc(summary.headline!));
    expect(sb).not.toContain(esc(summary.headline!.replace(/\s*\([^)]*\)\s*$/, "")));
    // The set table: its heading and a column per set the engine reports (whichever unit the sport counts in).
    const unit = (["game", "set"] as const).find((u) => sb.includes(esc(t(pub, "matchCentre.scoreByUnit", { unit: t(pub, `matchCentre.unit.${u}`) }))));
    expect(unit, "the set table's heading").toBeDefined();
    for (let n = 1; n <= sets.length; n++) expect(sb).toContain(t(pub, `matchCentre.col.${unit}`, { n }));
    expect(sb).not.toContain(t(pub, `matchCentre.col.${unit}`, { n: sets.length + 1 }));
    expect(sb).toContain(HOME.name);
    expect(sb).toContain(AWAY.name);
    expect(sb).not.toContain(">—<");
  });

  it("S1 — a set kernel's serve marker comes from the wire's `serving` (the engine's serve reader): on that side, in the panel and the table, for either side", () => {
    const summary = BADMINTON!;
    // The badminton summary itself never says who serves: the marker below can only come from the wire.
    expect(detailOf(summary).serving).toBeUndefined();
    const word = t(pub, "matchCentre.serving");
    let checked = 0;
    for (const [side, name, other] of [["home", HOME.name, AWAY.name], ["away", AWAY.name, HOME.name]] as const) {
      const sb = scoreboardOf(focus(goldenCourt("badminton", summary, { serving: side })));
      const panel = sb.slice(sb.indexOf("data-md-serving"));
      expect(sb, side).toContain("data-md-serving");
      expect(panel.slice(0, panel.indexOf("</p>")), side).toContain(`${esc(name)} `);
      expect(panel.slice(0, panel.indexOf("</p>")), side).toContain(`>${esc(word)}<`);
      expect(sb, side).toContain(`● ${esc(name)}`);
      expect(sb, side).not.toContain(`● ${esc(other)}`);
      checked++;
    }
    expect(checked).toBe(2);
    // Unknown (the engine will not say): no marker anywhere — never a guess, never a placeholder.
    const unknown = scoreboardOf(focus(goldenCourt("badminton", summary, { serving: null })));
    expect(unknown).not.toContain("data-md-serving");
    expect(unknown).not.toContain("●");
  });

  it("I1 — the serve marker beside the serving side, when the engine's summary says who serves (tennis)", () => {
    expect(TENNIS, "a tennis golden stream with the server known").not.toBeNull();
    const serving = detailOf(TENNIS!).serving === "home" ? HOME.name : AWAY.name;
    const other = serving === HOME.name ? AWAY.name : HOME.name;
    const sb = scoreboardOf(focus(goldenCourt("tennis", TENNIS!)));
    expect(sb).toContain(`● ${serving}`);
    expect(sb).not.toContain(`● ${other}`);
    expect(sb).toContain("data-md-serving");
  });

  it("V1 — the panel says the match is in play; 'Live' is the stream's word only", () => {
    const quiet = scoreboardOf(focus(goldenCourt("badminton", BADMINTON!, { stream: null })));
    expect(quiet).toContain(t(pub, "matchCentre.status.in_play"));
    expect(quiet).not.toContain(`>${t(pub, "matchCentre.status.live")}<`);
    expect(quiet).not.toMatch(new RegExp(`\\b${t(dict, "matchDay.stream.live")}\\b`));
    // No score yet: the same word, never "Live".
    const blank = scoreboardOf(focus(court({ current: fx({ headline: null, summary: null }) })));
    expect(blank).toContain(t(pub, "matchCentre.status.in_play"));
    expect(blank).toContain(t(dict, "matchDay.focus.noScore"));
    expect(blank).not.toMatch(new RegExp(`\\b${t(dict, "matchDay.stream.live")}\\b`));
  });

  it("stream live: the Live badge and the watch link instead of '+ Connect a stream' (the positive half of the pair above)", () => {
    const sb = scoreboardOf(focus(goldenCourt("badminton", BADMINTON!, { stream: "live" })));
    expect(sb).toContain('data-md-stream="live"');
    expect(sb).toContain(t(dict, "matchDay.stream.watch"));
    expect(sb).not.toContain(t(dict, "matchDay.stream.connect"));
    // "Live" appears once — on the stream link — and the panel still says in play.
    expect(sb.split(`>${t(dict, "matchDay.stream.live")}<`).length - 1).toBe(1);
    expect(sb).toContain(t(pub, "matchCentre.status.in_play"));
  });

  it("names the match, its division and stage, and opens its pad at the console address", () => {
    const html = focus(court());
    expect(html).toContain("Zara Khan v Ella Brooks");
    expect(html).toContain("Girls U14");
    expect(html).toContain("Swiss round 3");
    expect(html).toContain(`href="${routes.fixture("acme", "safe-badminton", "girls-u14", 7)}"`);
    expect(html).toContain(t(dict, "matchDay.focus.openPad"));
  });

  it("the queue lists the court's next matches with their '~' estimate, and the plan when the estimate is later", () => {
    const html = focus(
      court({ queue: [queued({}, "2026-10-31T11:45:00.000Z", "2026-10-31T12:10:00.000Z"), queued({ id: "q-2", home: "Mia", away: "Dev" })] }),
    );
    const rows = rowsOf(html, "md-queue-row");
    expect(rows).toHaveLength(2);
    // Europe/London is UTC+0 on 31 Oct 2026 (BST ends 25 Oct).
    expect(rows[0]).toContain("~12:10");
    expect(rows[0]).toContain(t(dict, "matchDay.queue.planned", { time: "11:45" }));
    expect(rows[1]).toContain("~12:20");
    expect(rows[1]).not.toContain(t(dict, "matchDay.queue.planned", { time: "12:20" }));
  });
});

describe("focused court: called, free, in use elsewhere", () => {
  it("called: 'Called: waiting for players', the match, and Undo call", () => {
    const html = focus(court({ state: "called", current: fx({ started_at: null, headline: null, called_at: "2026-10-31T11:31:00.000Z" }) }));
    expect(html).toContain(t(dict, "matchDay.called.title"));
    expect(html).toContain("Zara Khan v Ella Brooks");
    expect(html).toMatch(new RegExp(`<button[^>]*data-testid="md-undo-call"[^>]*>${t(dict, "matchDay.called.undo")}<`));
    expect(html).not.toContain('data-testid="md-scoreboard"');
  });

  it("free: '<court> is free', free since, and the candidate count over the candidates it lists", () => {
    const c = court({ court_name: "Court 5", state: "free", current: null, free_since: "2026-10-31T11:31:00.000Z" });
    const candidates = [cand({ source: "this_court", from_court_name: null }), cand({}, { id: "x-2" }), cand({ source: "no_court", from_court_name: null }, { id: "x-3" })];
    const html = renderToStaticMarkup(
      <FreeCourtBody ctx={ctx} court={c} load={{ status: "ready", candidates }} onCall={() => {}} onRetry={() => {}} />,
    );
    expect(html).toContain(t(dict, "matchDay.free.title", { court: "Court 5" }));
    expect(html).toContain(t(dict, "matchDay.free.since", { time: "11:31" }));
    expect(html).toContain(plural(dict, "matchDay.free.count", 3, "en"));
    expect(rowsOf(html, "md-candidate")).toHaveLength(3);
  });

  it("free, nothing can start: says so — never a count of zero over an empty list", () => {
    const c = court({ court_name: "Court 5", state: "free", current: null });
    const html = renderToStaticMarkup(
      <FreeCourtBody ctx={ctx} court={c} load={{ status: "ready", candidates: [] }} onCall={() => {}} onRetry={() => {}} />,
    );
    expect(html).toContain(t(dict, "matchDay.free.countNone"));
    expect(html).not.toContain('data-testid="md-candidate"');
  });

  it("I2 — the count is of matches that could start NOW: a blocked candidate is listed but not counted", () => {
    const c = court({ court_name: "Court 5", state: "free", current: null });
    const busy = { kind: "player_busy" as const, person_name: "Zara Khan", court_name: "Court 3" };
    const candidates = [cand({}, { id: "ok-1" }), cand({ blocked: busy }, { id: "busy-1" }), cand({}, { id: "ok-2" }), cand({ blocked: busy }, { id: "busy-2" })];
    expect(callableCount(candidates)).toBe(2);
    const html = renderToStaticMarkup(
      <FreeCourtBody ctx={ctx} court={c} load={{ status: "ready", candidates }} onCall={() => {}} onRetry={() => {}} />,
    );
    expect(html).toContain(plural(dict, "matchDay.free.count", 2, "en"));
    expect(html).not.toContain(plural(dict, "matchDay.free.count", 4, "en"));
    expect(rowsOf(html, "md-candidate")).toHaveLength(4);
  });

  it("I2 — every candidate blocked: 'No match can start here right now', and the blocked rows still say why", () => {
    const c = court({ court_name: "Court 5", state: "free", current: null });
    const busy = { kind: "player_busy" as const, person_name: "Zara Khan", court_name: "Court 3" };
    const candidates = [cand({ blocked: busy }, { id: "busy-1" }), cand({ blocked: busy }, { id: "busy-2" })];
    expect(callableCount(candidates)).toBe(0);
    const html = renderToStaticMarkup(
      <FreeCourtBody ctx={ctx} court={c} load={{ status: "ready", candidates }} onCall={() => {}} onRetry={() => {}} />,
    );
    expect(html).toContain(t(dict, "matchDay.free.countNone"));
    expect(html).not.toMatch(new RegExp(plural(dict, "matchDay.free.count", 2, "en")));
    expect(rowsOf(html, "md-candidate")).toHaveLength(2);
    expect(html).toContain(t(dict, "matchDay.candidate.blocked", { person: "Zara Khan", court: "Court 3" }));
  });

  it("free, while the candidates load (the first paint): a loading line, no count", () => {
    const html = focus(court({ court_name: "Court 5", state: "free", current: null }));
    expect(html).toContain(t(dict, "matchDay.free.title", { court: "Court 5" }));
    expect(html).toContain(t(dict, "matchDay.free.loading"));
  });

  it("in use by another competition: greyed, names it, and offers nothing to press", () => {
    const html = focus(court({ state: "in_use_elsewhere", current: null, in_use_by: "Winter Open" }));
    expect(html).toContain('data-state="in_use_elsewhere"');
    expect(html).toContain(t(dict, "matchDay.state.inUse", { competition: "Winter Open" }));
    // Only the phone's back control may be a button here.
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.every((b) => b.includes('data-testid="md-back"'))).toBe(true);
    expect(html).not.toContain(t(dict, "matchDay.stream.connect"));
  });
});

describe("candidates", () => {
  it("a blocked candidate has no enabled call button and names the person and the court; a free one has its call button", () => {
    const ok = cand({}, { id: "x-ok", home: "Ravi Iyer", away: "Leo Park" });
    const blocked = cand(
      { blocked: { kind: "player_busy", person_name: "Zara Khan", court_name: "Court 3" } },
      { id: "x-busy", home: "Isha Rao", away: "Zara Khan" },
    );
    const html = renderToStaticMarkup(<CandidateRows ctx={ctx} court={court({ court_name: "Court 5" })} candidates={[ok, blocked]} onCall={() => {}} />);
    const [okRow, busyRow] = rowsOf(html, "md-candidate");
    expect(okRow).toMatch(new RegExp(`<button[^>]*>${t(dict, "matchDay.candidate.call", { court: "Court 5" })}</button>`));
    expect(okRow).not.toMatch(/<button[^>]*disabled=""/);
    expect(busyRow).toContain('data-blocked="true"');
    expect(busyRow).toContain(t(dict, "matchDay.candidate.blocked", { person: "Zara Khan", court: "Court 3" }));
    const enabled = (busyRow!.match(/<button[^>]*>/g) ?? []).filter((b) => !b.includes('disabled=""'));
    expect(enabled).toEqual([]);
  });

  it("a blocked candidate whose busy match has no court says the person is in another match", () => {
    const blocked = cand({ blocked: { kind: "player_busy", person_name: "Omar Ali", court_name: null } });
    const html = renderToStaticMarkup(<CandidateRows ctx={ctx} court={court()} candidates={[blocked]} onCall={() => {}} />);
    expect(html).toContain(t(dict, "matchDay.candidate.blockedNoCourt", { person: "Omar Ali" }));
  });

  it("groups in rank order — due here, waiting elsewhere, no court yet — and says where each waits", () => {
    const html = renderToStaticMarkup(
      <CandidateRows
        ctx={ctx}
        court={court({ court_name: "Court 5" })}
        candidates={[
          cand({ source: "this_court", from_court_name: null, waiting_minutes: 0, behind_minutes: 0 }, { id: "a" }),
          cand({ behind_minutes: 25, waiting_minutes: 0 }, { id: "b" }),
          cand({ waiting_minutes: 15 }, { id: "c" }),
          cand({ source: "no_court", from_court_name: null, waiting_minutes: 0, behind_minutes: 0 }, { id: "d" }),
        ]}
        onCall={() => {}}
      />,
    );
    const groups = ["this_court", "other_court", "no_court"].map((g) => html.indexOf(t(dict, `matchDay.candidate.group.${g}`)));
    expect(groups.every((i) => i >= 0)).toBe(true);
    expect([...groups].sort((a, b) => a - b)).toEqual(groups);
    expect(html).toContain(`${t(dict, "matchDay.candidate.where.nextOn", { court: "Court 1" })} · ${t(dict, "matchDay.candidate.when.behind", { minutes: 25 })}`);
    expect(html).toContain(`${t(dict, "matchDay.candidate.where.nextOn", { court: "Court 1" })} · ${t(dict, "matchDay.candidate.when.in", { minutes: 15 })}`);
    expect(html).toContain(t(dict, "matchDay.candidate.where.noCourt"));
  });
});

describe("V2 — one primary action per list", () => {
  const busy = { kind: "player_busy" as const, person_name: "Zara Khan", court_name: "Court 3" };
  const primaries = (html: string) => (html.match(/<button[^>]*class="[^"]*\bbtn-primary\b[^"]*"[^>]*>/g) ?? []).length;

  it("only the top-ranked callable candidate is primary, even when a blocked one is drawn above it; the rest are secondary, 44px", () => {
    // Rank order (estimate.ts): unblocked first — but the rows are drawn grouped, so the blocked "due here" row is drawn FIRST.
    const candidates = [
      cand({}, { id: "top" }),
      cand({ waiting_minutes: 30 }, { id: "second" }),
      cand({ source: "no_court", from_court_name: null }, { id: "third" }),
      cand({ source: "this_court", from_court_name: null, blocked: busy }, { id: "busy-here" }),
    ];
    expect(primaryCandidateId(candidates)).toBe("top");
    const html = renderToStaticMarkup(<CandidateRows ctx={ctx} court={court({ court_name: "Court 5" })} candidates={candidates} onCall={() => {}} />);
    const rows = rowsOf(html, "md-candidate");
    expect(rows[0]).toContain('data-fixture-id="busy-here"');
    expect(primaries(html)).toBe(1);
    const byId = (id: string) => rows.find((r) => r.startsWith(` data-fixture-id="${id}"`))!;
    expect(byId("top")).toMatch(/\bbtn-primary\b/);
    expect(byId("top")).toContain('data-md-primary="true"');
    for (const id of ["second", "third"]) {
      expect(byId(id), id).not.toMatch(/\bbtn-primary\b/);
      expect(byId(id), id).toMatch(/<button[^>]*class="[^"]*\bbtn-ghost\b[^"]*\bmin-h-11\b|<button[^>]*class="[^"]*\bmin-h-11\b[^"]*\bbtn-ghost\b/);
    }
    // Every call button keeps a 44px target at every width (no lg: shrink).
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(b).toMatch(/\bmin-h-11\b/);
      expect(b).not.toMatch(/min-h-0/);
    }
  });

  it("every candidate blocked: no primary at all", () => {
    const candidates = [cand({ blocked: busy }, { id: "a" }), cand({ blocked: busy }, { id: "b" })];
    expect(primaryCandidateId(candidates)).toBeNull();
    const html = renderToStaticMarkup(<CandidateRows ctx={ctx} court={court()} candidates={candidates} onCall={() => {}} />);
    expect(primaries(html)).toBe(0);
  });
});

describe("the call sheet", () => {
  const sheet = (state: Parameters<typeof CallSheetBody>[0]["state"]) =>
    renderToStaticMarkup(<CallSheetBody ctx={ctx} court={court({ court_name: "Court 5" })} candidate={cand()} state={state} />);

  it("shows the knock-on before anything changes: each pushed match, planned → ~estimate, and the warnings", () => {
    const preview: CallPreview = {
      shifts: [{ fixture_id: "s1", label: "Das v Gill", planned_at: "2026-10-31T11:45:00.000Z", estimated_at: "2026-10-31T12:10:00.000Z" }],
      warnings: [
        { kind: "pushes_later", count: 1 },
        { kind: "rest_gap", person_name: "Zara Khan", minutes: 5, min_rest: 20 },
        { kind: "past_day_end", court_name: "Court 5", until: "2026-10-31T18:00:00.000Z" },
      ],
    };
    const html = sheet({ kind: "ready", preview });
    expect(html).toContain(t(dict, "matchDay.sheet.shift", { match: "Das v Gill", from: "11:45", to: "12:10" }));
    expect(html).toContain(plural(dict, "matchDay.sheet.warn.pushesLater", 1, "en"));
    expect(html).toContain(t(dict, "matchDay.sheet.warn.restGap", { person: "Zara Khan", minutes: 5, min: 20 }));
    expect(html).toContain(t(dict, "matchDay.sheet.warn.pastDayEnd", { court: "Court 5", time: "18:00" }).replace(/'/g, "&#x27;"));
  });

  it("nothing pushed: says nothing else moves (never an empty list)", () => {
    const html = sheet({ kind: "ready", preview: { shifts: [], warnings: [] } });
    expect(html).toContain(t(dict, "matchDay.sheet.noShift", { court: "Court 5" }));
    expect(html).not.toContain('data-testid="md-shift"');
  });

  it("M5 — a refusal is held by the court focus, whatever state the refresh left the court in, until dismissed", () => {
    const message = refusalMessage(dict, CALL_REFUSAL.COURT_BUSY, { court_name: "Court 5", competition_name: "Winter Open" });
    let checked = 0;
    for (const c of [
      court({ court_name: "Court 5", state: "free", current: null }),
      court({ court_name: "Court 5", state: "in_use_elsewhere", current: null, in_use_by: "Winter Open" }),
      court({ court_name: "Court 5", state: "called", current: fx({ started_at: null, called_at: "2026-10-31T11:31:00.000Z" }) }),
      court({ court_name: "Court 5" }),
    ]) {
      const html = focus(c, message);
      const notice = html.match(/<div role="alert" data-testid="md-notice"[\s\S]*?<\/div>/)?.[0] ?? "";
      expect(notice, c.state).toContain(esc(message));
      expect(notice, c.state).not.toContain(CALL_REFUSAL.COURT_BUSY);
      expect(notice, c.state).toContain(t(dict, "matchDay.notice.dismiss"));
      expect(focus(c), c.state).not.toContain('data-testid="md-notice"');
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("the court list", () => {
  it("a stream badge only on the court whose match is live — none for waiting, none for no stream, none when free", () => {
    const courts = [
      court({ court_id: "c-1", court_name: "Court 1", current: fx({ id: "a", stream: "live" }) }),
      court({ court_id: "c-2", court_name: "Court 2", current: fx({ id: "b", stream: "waiting" }) }),
      court({ court_id: "c-3", court_name: "Court 3", current: fx({ id: "c", stream: null }) }),
      court({ court_id: "c-4", court_name: "Court 4", state: "called", current: fx({ id: "d", stream: null, started_at: null }) }),
      court({ court_id: "c-5", court_name: "Court 5", state: "free", current: null }),
    ];
    const html = renderToStaticMarkup(<CourtList courts={courts} selectedId="c-3" dict={dict} onSelect={() => {}} />);
    const rows = rowsOf(html, "md-court-row");
    expect(rows).toHaveLength(5);
    const withBadge = rows.map((r) => r.includes('data-md-stream="live"'));
    expect(withBadge).toEqual([true, false, false, false, false]);
    expect(html.split('data-md-stream="').length - 1).toBe(1);
  });

  it("each row says what is on: the match and its score, Called, Free, or In use", () => {
    const courts = [
      goldenCourt("badminton", BADMINTON!, { home: "Zara Khan", away: "Ella Brooks" }),
      court({ court_id: "c-2", state: "called", current: fx({ started_at: null, headline: null }) }),
      court({ court_id: "c-3", state: "free", current: null }),
      court({ court_id: "c-4", state: "in_use_elsewhere", current: null, in_use_by: "Winter Open" }),
    ];
    const rows = rowsOf(renderToStaticMarkup(<CourtList courts={courts} selectedId={null} dict={dict} onSelect={() => {}} />), "md-court-row");
    expect(rows[0]).toContain("Zara Khan v Ella Brooks");
    expect(rows[0]).toContain("data-md-row-score");
    expect(rows[1]).toContain(t(dict, "matchDay.state.called"));
    expect(rows[2]).toContain(t(dict, "matchDay.state.free"));
    expect(rows[3]).toContain(t(dict, "matchDay.state.inUse", { competition: "Winter Open" }));
  });

  it("V4 — a set sport's row: games won and the current game's points, compact — no brackets, no finished game, no monospace", () => {
    const summary = BADMINTON!;
    const rows = rowsOf(
      renderToStaticMarkup(<CourtList courts={[goldenCourt("badminton", summary)]} selectedId={null} dict={dict} onSelect={() => {}} />),
      "md-court-row",
    );
    expect(rows).toHaveLength(1);
    const at = rows[0]!.indexOf("data-md-row-score");
    expect(at, "the row's score").toBeGreaterThan(-1);
    const tag = rows[0]!.slice(rows[0]!.lastIndexOf("<", at), rows[0]!.indexOf(">", at));
    const score = rows[0]!.slice(rows[0]!.indexOf(">", at) + 1, rows[0]!.indexOf("</span>", at));
    const open = setsOf(summary).find((x) => !x.closed)!;
    const won = summary.perSide!.map((x) => x.line);
    expect(score).toBe(`${won[0]}–${won[1]} · ${open.home}–${open.away}`);
    expect(score).not.toMatch(/[()]/);
    for (const x of setsOf(summary).filter((y) => y.closed)) expect(score).not.toContain(`${x.home}–${x.away}`);
    expect(tag).not.toContain("font-mono");
    expect(tag).toContain("tabular-nums");
  });

  it("a non-set sport's row keeps its own headline, whole", () => {
    const football = inPlaySummary("football");
    expect(football, "a football golden stream in play").not.toBeNull();
    expect(isSetSport(football!)).toBe(false);
    const row = rowsOf(
      renderToStaticMarkup(<CourtList courts={[goldenCourt("football", football!)]} selectedId={null} dict={dict} onSelect={() => {}} />),
      "md-court-row",
    )[0]!;
    expect(row).toContain(`>${esc(football!.headline!)}</span>`);
  });

  it("marks the selected court, and only it", () => {
    const courts = [court({ court_id: "c-1" }), court({ court_id: "c-2" })];
    const rows = rowsOf(renderToStaticMarkup(<CourtList courts={courts} selectedId="c-2" dict={dict} onSelect={() => {}} />), "md-court-row");
    expect(rows.map((r) => /aria-current="true"/.test(r.slice(0, r.indexOf(">"))))).toEqual([false, true]);
  });
});

/** Every sport the engine registers (never a list typed here: a new sport joins the sweep by registering). */
const SPORTS: string[] = [];
registerBuiltins({
  register(m: AnySportModule) {
    SPORTS.push(m.key);
  },
  get: () => {
    throw new Error("capture registry: get");
  },
  latest: () => {
    throw new Error("capture registry: latest");
  },
} as SportRegistry);

describe("every sport: the court noun and the scoreboard follow the sport (G5)", () => {
  it("each registered sport's court shows its noun, and its scoreboard from the ENGINE's folded summary, both sides named", () => {
    const swept: string[] = [];
    const setSports: string[] = [];
    const noCorpus: string[] = [];
    const nouns = new Set<string>();
    for (const key of SPORTS) {
      const summary = inPlaySummary(key);
      if (summary === null) {
        // Only a sport with no recorded golden stream may sit out — never one whose streams yield no moment of play.
        expect(CORPORA.some((c) => c.key === key), `${key} has a corpus but no in-play moment`).toBe(false);
        noCorpus.push(key);
        continue;
      }
      const noun = venueNoun(key);
      nouns.add(noun);
      const html = focus(goldenCourt(key, summary));
      expect(html, key).toContain(`>${t(dict, `matchDay.noun.${noun}`)}<`);
      const sb = scoreboardOf(html);
      expect(sb, key).not.toBe("");
      if (isSetSport(summary)) {
        // V3: games or sets won large, the engine's live points beside them, no finished set's score.
        const big = largeOf(sb);
        expect(big, key).toContain(`>${esc(gamesWon(summary))}<`);
        const live = livePointsOf(summary);
        if (live !== null) expect(big, key).toContain(`>${esc(live)}<`);
        for (const x of setsOf(summary).filter((y) => y.closed)) {
          const done = `${x.home}–${x.away}`;
          if (done !== live) expect(big, `${key} shows finished ${done}`).not.toContain(done);
        }
        setSports.push(key);
      } else {
        expect(sb, key).toContain(`>${esc(summary.headline!)}</p>`);
        expect(largeOf(sb), key).toBe("");
      }
      expect(sb, key).toContain(esc(HOME.name));
      expect(sb, key).toContain(esc(AWAY.name));
      expect(sb, key).not.toContain(">—<");
      // Each side's own line, where the engine gives one and no set table takes its place.
      if (!hasSets(summary)) for (const side of summary.perSide ?? []) expect(sb, key).toContain(`>${esc(side.line)}<`);
      expect(sb, key).toContain(t(pub, "matchCentre.status.in_play"));
      swept.push(key);
    }
    // Anti-vacuity: every registered sport is accounted for, and the sweep really ran.
    expect(swept.length + noCorpus.length).toBe(SPORTS.length);
    expect(swept.length).toBeGreaterThan(5);
    expect(swept.length, `swept ${swept.join(",")}; no corpus: ${noCorpus.join(",")}`).toBe(CORPORA.filter((c) => SPORTS.includes(c.key)).length);
    // Both shapes were really drawn: set sports through Match Day's own large type, the rest through their own scorebug.
    expect(setSports.length, `set sports: ${setSports.join(",")}`).toBeGreaterThan(1);
    expect(swept.length - setSports.length, "non-set sports").toBeGreaterThan(1);
    // The sweep can witness a hard-coded "Court": at least one swept sport plays on something else.
    expect([...nouns].filter((n) => n !== "court").length).toBeGreaterThan(0);
  });

  it("every noun lib/venue.ts can answer has its words in all four locales (singular, the header count, the back link)", () => {
    let checked = 0;
    for (const noun of VENUE_NOUNS) {
      for (const [locale, d] of Object.entries(DICTS)) {
        for (const key of [`matchDay.noun.${noun}`, `matchDay.header.places.${noun}.one`, `matchDay.header.places.${noun}.other`, `matchDay.back.${noun}`]) {
          expect(typeof d[key], `${locale} ${key}`).toBe("string");
          checked++;
        }
      }
    }
    expect(checked).toBe(VENUE_NOUNS.length * 4 * 4);
  });
});

describe("the header, the filter and the poll's cadence", () => {
  it("counts courts, playing and free; called and in-use courts are neither", () => {
    expect(
      courtCounts([court(), court({ state: "called" }), court({ state: "free" }), court({ state: "in_use_elsewhere" }), court({ state: "free" })]),
    ).toEqual({ courts: 5, playing: 1, free: 2 });
    expect(courtCounts([])).toEqual({ courts: 0, playing: 0, free: 0 });
  });

  it("the set noun: shared when every court agrees, else 'court'; none for no courts", () => {
    expect(sharedNoun([court({ sport_noun: "pitch" }), court({ sport_noun: "pitch" })])).toBe("pitch");
    expect(sharedNoun([court({ sport_noun: "pitch" }), court({ sport_noun: "board" })])).toBe("court");
    expect(sharedNoun([])).toBe("court");
  });

  it("the shell's header: 'Match Day · <weekday date>', the competition, and the counts in the courts' noun", () => {
    const html = renderToStaticMarkup(
      <MatchDayShell
        competitionId="comp-1"
        competitionName="Safe Football 2026"
        orgSlug="acme"
        compSlug="safe-football"
        locale="en"
        divisions={[{ id: "d-u14", name: "Girls U14" }]}
        initial={view([court({ sport_noun: "pitch" }), court({ court_id: "c-2", sport_noun: "pitch", state: "free", current: null })])}
        dict={dict}
        scoreDict={publicEn as Dict}
        viewerPlan="pro"
      />,
    );
    expect(html).toContain(t(dict, "matchDay.title", { date: "Saturday 31 Oct" }));
    expect(html).toContain("Safe Football 2026");
    expect(html).toContain(plural(dict, "matchDay.header.places.pitch", 2, "en"));
    expect(html).toContain(t(dict, "matchDay.header.playing", { count: 1 }));
    expect(html).toContain(t(dict, "matchDay.header.free", { count: 1 }));
    expect(html).toContain(t(dict, "matchDay.back.pitch"));
  });

  it("phone composition: the list is home and the focus waits behind it (one DOM, branched at md)", () => {
    const html = renderToStaticMarkup(
      <MatchDayShell
        competitionId="comp-1"
        competitionName="Safe Badminton 2026"
        orgSlug="acme"
        compSlug="safe-badminton"
        locale="en"
        divisions={[]}
        initial={view([court(), court({ court_id: "c-5", state: "free", current: null })])}
        dict={dict}
        scoreDict={publicEn as Dict}
        viewerPlan="pro"
      />,
    );
    const tagOf = (testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
    // `\s…hidden"`-anchored (AGENTS.md: /\bmd:hidden\b/ also matches inside max-md:hidden).
    expect(tagOf("md-list")).not.toMatch(/max-md:hidden/);
    expect(tagOf("md-focus")).toMatch(/[\s"]max-md:hidden[\s"]/);
    expect(tagOf("md-back")).toMatch(/[\s"]md:hidden[\s"]/);
    // Desktop shows the first court focused before anything is tapped.
    expect(tagOf("md-focus")).toContain('data-court-id="c-3"');
  });

  it("the division filter keeps free courts, drops a court busy with another division, and narrows queues and candidates", () => {
    const courts = [
      court({ court_id: "c-1", current: fx({ division_id: "d-u14" }) }),
      court({ court_id: "c-2", current: fx({ division_id: "d-u17" }), queue: [queued({ division_id: "d-u17" })] }),
      court({ court_id: "c-3", current: fx({ division_id: "d-u17" }), queue: [queued({ division_id: "d-u14" }), queued({ id: "q-2", division_id: "d-u17" })] }),
      court({ court_id: "c-4", state: "free", current: null }),
    ];
    const only = new Set(["d-u14"]);
    const kept = filterCourts(courts, only);
    expect(kept.map((c) => c.court_id)).toEqual(["c-1", "c-3", "c-4"]);
    expect(kept.find((c) => c.court_id === "c-3")!.queue.map((q) => q.division_id)).toEqual(["d-u14"]);
    expect(filterCourts(courts, null)).toEqual(courts);
    const cands = [cand({}, { id: "a", division_id: "d-u14" }), cand({}, { id: "b", division_id: "d-u17" })];
    expect(filterCandidates(cands, only).map((c) => c.fixture.id)).toEqual(["a"]);
    expect(filterCandidates(cands, null)).toHaveLength(2);
  });

  it("M6 — the opened court while it is on the list; none opened → the first; opened but gone → lost, by name", () => {
    const courts = [court({ court_id: "c-1", court_name: "Court 1" }), court({ court_id: "c-2", court_name: "Court 2" })];
    expect(resolveFocus(courts, null)).toEqual({ kind: "court", court: courts[0] });
    expect(resolveFocus(courts, { id: "c-2", name: "Court 2" })).toEqual({ kind: "court", court: courts[1] });
    // The filter (or the day) took Court 3 away: say so, never fall back to Court 1.
    expect(resolveFocus(courts, { id: "c-3", name: "Court 3" })).toEqual({ kind: "lost", name: "Court 3" });
    expect(resolveFocus([], { id: "c-3", name: "Court 3" })).toEqual({ kind: "lost", name: "Court 3" });
    expect(resolveFocus([], null)).toEqual({ kind: "none" });
    // And in a filtered list: the opened court's division unchosen, it is lost.
    const kept = filterCourts([court({ court_id: "c-9", current: fx({ division_id: "d-u17" }) })], new Set(["d-u14"]));
    expect(resolveFocus(kept, { id: "c-9", name: "Court 9" })).toEqual({ kind: "lost", name: "Court 9" });
  });

  it("M1 — a poll's or a candidates fetch's answer is used only when it has the shape (a cut-off 200 is undefined)", () => {
    expect(isMatchDayView(view([court()]))).toBe(true);
    expect(isMatchDayView(view([]))).toBe(true);
    for (const bad of [undefined, null, {}, [], { courts: "x", date: "d", tz: "UTC", now: "n" }, { ...view([]), courts: undefined }]) {
      expect(isMatchDayView(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isCandidateList([])).toBe(true);
    expect(isCandidateList([cand()])).toBe(true);
    for (const bad of [undefined, null, {}, "x"]) expect(isCandidateList(bad), String(bad)).toBe(false);
  });

  it("polls fast while a match is playing or called, slow otherwise", () => {
    expect(isLive(view([court()]))).toBe(true);
    expect(isLive(view([court({ state: "called" })]))).toBe(true);
    expect(isLive(view([court({ state: "free", current: null }), court({ state: "in_use_elsewhere", current: null })]))).toBe(false);
    expect(isLive(view([]))).toBe(false);
  });
});

describe("refusals in organiser words, every locale", () => {
  const extras: Record<string, Record<string, unknown>> = {
    PLAYER_BUSY: { person_name: "Zara Khan", court_name: "Court 3" },
    COURT_BUSY: { court_name: "Court 5", competition_name: "Winter Open" },
    NOT_CALLABLE: { status: "in_play" },
    NOT_CALLED: {},
    SEQ_CONFLICT: {},
  };

  it("each code reads as a sentence with its details in it, never the raw code, in en/es/fr/nl", () => {
    let checked = 0;
    for (const code of REFUSAL_CODES) {
      for (const [locale, d] of Object.entries(DICTS)) {
        const msg = refusalMessage(d, code, extras[code]);
        expect(msg, `${locale} ${code}`).not.toContain(code);
        expect(msg, `${locale} ${code}`).not.toMatch(/matchDay\./);
        expect(msg, `${locale} ${code}`).not.toMatch(/\{\w+\}/);
        for (const v of Object.values(extras[code]!)) if (typeof v === "string" && v !== "in_play") expect(msg, `${locale} ${code}`).toContain(v);
        checked++;
      }
    }
    expect(checked).toBe(REFUSAL_CODES.length * 4);
    expect(REFUSAL_CODES.length).toBe(5);
  });

  it("the variants: a busy person with no court, a side still to be decided, and an unknown code", () => {
    expect(refusalMessage(dict, CALL_REFUSAL.PLAYER_BUSY, { person_name: "Omar Ali", court_name: null })).toBe(
      t(dict, "matchDay.refusal.PLAYER_BUSY.noCourt", { person: "Omar Ali" }),
    );
    expect(refusalMessage(dict, CALL_REFUSAL.NOT_CALLABLE, { status: TBD_ENTRANT })).toBe(t(dict, "matchDay.refusal.NOT_CALLABLE.tbd"));
    expect(refusalMessage(dict, "SOMETHING_NEW")).toBe(t(dict, "matchDay.refusal.other"));
  });
});

// ---- Task A4: Needs you in the header, the scorer QR, the court marks and the stream preview ------------------------------

/** One `Attention` of every kind the desk declares. A `Record` over the kinds, so a kind added to lib/division-phase.ts is a
 *  compile error here until the sweep below covers it. */
const ONE_OF_EACH: { [K in Attention["kind"]]: Extract<Attention, { kind: K }> } = {
  needs_draw: { kind: "needs_draw", stageName: "Knockout", door: "compute" },
  needs_fixtures: { kind: "needs_fixtures", stageName: "Plate" },
  needs_decision: { kind: "needs_decision", count: 1, fixtureIds: ["f-dec"] },
  no_scorer: { kind: "no_scorer", count: 1, fixtureIds: ["f-ns"], minutesSinceKickoff: 12 },
  not_recording: { kind: "not_recording", count: 1, fixtureIds: ["f-nr"], minutesSinceKickoff: 20 },
  unscheduled: { kind: "unscheduled", count: 2 },
  result_missing: { kind: "result_missing", count: 3, fixtureIds: ["f-r1", "f-r2", "f-r3"] },
  bans_waiting: { kind: "bans_waiting", count: 1 },
  registrations_waiting: { kind: "registrations_waiting", count: 4 },
};
/** The kinds, from the desk's own declaration (`ATTENTION_SEVERITY` is a Record over every kind), never a list typed here. */
const KINDS = Object.keys(ATTENTION_SEVERITY) as Attention["kind"][];

/** The desk's Needs-you rows for a division carrying `attention`, built by the desk's own `needsYouItems` (the rows Match Day's
 *  view carries, translated server-side). */
function deskRows(attention: Attention[], d: Dict = dict): NeedsYouItem[] {
  const names = { home: "Zara Khan", away: "Ella Brooks", fixture_no: 7 };
  const fixture_names = Object.fromEntries(attention.flatMap((a) => ("fixtureIds" in a ? a.fixtureIds : [])).map((id) => [id, names]));
  const desk = { divisions: new Map([["d-u14", { attention, fixture_names }]]) } as unknown as CompetitionDesk;
  return needsYouItems(d, desk, [{ id: "d-u14", name: "Girls U14", slug: "girls-u14" }], "acme", "safe-badminton", "en");
}

const shellHtml = (v: MatchDayView) =>
  renderToStaticMarkup(
    <MatchDayShell
      competitionId="comp-1"
      competitionName="Safe Badminton 2026"
      orgSlug="acme"
      compSlug="safe-badminton"
      locale="en"
      divisions={[]}
      initial={v}
      dict={dict}
      scoreDict={publicEn as Dict}
      viewerPlan="pro"
    />,
  );
const tagWith = (html: string, testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";

describe("A4 — Needs you, behind the header's attention button", () => {
  it("EMPTY CASE FIRST: nothing needs the organiser — no button and no list", () => {
    const html = shellHtml(view([court()]));
    expect(html).not.toContain('data-testid="md-needs-you-toggle"');
    expect(html).not.toContain('data-testid="md-needs-you"');
    expect(needsYouTone([])).toBeNull();
  });

  it("the button reads 'N need you · M results owed' (the list's own row count; the desk's result_missing count), closed at first", () => {
    const rows = deskRows([ONE_OF_EACH.no_scorer, ONE_OF_EACH.result_missing, ONE_OF_EACH.unscheduled]);
    expect(rows).toHaveLength(3);
    const html = shellHtml({ ...view([court()]), needs_you: rows, results_owed: 3 });
    const toggle = html.slice(html.indexOf('data-testid="md-needs-you-toggle"'), html.indexOf("</button>", html.indexOf('data-testid="md-needs-you-toggle"')));
    expect(toggle).toContain(`>${plural(dict, "matchDay.needsYou.count", 3, "en")}<`);
    expect(toggle).toContain(`>${plural(dict, "matchDay.needsYou.owed", 3, "en")}<`);
    // Its tone is its most urgent row's: a red no_scorer row (the desk's declared severity) makes it red.
    expect(tagWith(html, "md-needs-you-toggle")).toContain(`data-severity="${ATTENTION_SEVERITY.no_scorer}"`);
    expect(tagWith(html, "md-needs-you-toggle")).toContain('aria-expanded="false"');
    // Closed: the list's box is there for aria-controls, hidden and empty.
    expect(tagWith(html, "md-needs-you")).toContain('hidden=""');
    expect(html).not.toContain('data-testid="desk-needs-you"');
    // aria-controls names the list's box.
    const controls = /aria-controls="([^"]+)"/.exec(tagWith(html, "md-needs-you-toggle"))?.[1];
    expect(controls).toBeTruthy();
    expect(tagWith(html, "md-needs-you")).toContain(`id="${controls}"`);
  });

  it("no result owed: the button names the rows only; one row reads in the singular", () => {
    const one = needsYouButtonParts(dict, { needs_you: deskRows([ONE_OF_EACH.unscheduled]), results_owed: 0 }, "en");
    expect(one).toEqual([plural(dict, "matchDay.needsYou.count", 1, "en")]);
    expect(one[0]).not.toBe(plural(dict, "matchDay.needsYou.count", 2, "en"));
  });

  it("results owed come FIRST (spec §6.3), every other row after them in the desk's own order — and each owed row says Enter result", () => {
    const desk = deskRows([ONE_OF_EACH.no_scorer, ONE_OF_EACH.unscheduled, ONE_OF_EACH.result_missing, ONE_OF_EACH.registrations_waiting]);
    // Premise: the desk's own order does NOT put the owed row first (a red row outranks it), so the order below is Match Day's.
    expect(desk[0]!.kind).not.toBe("result_missing");
    const ordered = needsYouOrder(desk);
    expect(ordered.map((r) => r.kind)).toEqual([
      "result_missing",
      ...desk.filter((r) => r.kind !== "result_missing").map((r) => r.kind),
    ]);
    const html = renderToStaticMarkup(<NeedsYou dict={dict} items={ordered} />);
    const order = [...html.matchAll(/data-attention="([a-z_]+)"/g)].map((m) => m[1]);
    expect(order[0]).toBe("result_missing");
    const owed = html.slice(html.indexOf('data-attention="result_missing"'), html.indexOf("data-attention=", html.indexOf('data-attention="result_missing"') + 1));
    expect(owed).toContain(t(dict, "desk.needsYou.result_missing.action"));
    // The empty list orders to an empty list.
    expect(needsYouOrder([])).toEqual([]);
  });

  it("SWEEP — every Attention kind the desk declares renders in Match Day's list, exactly once (count reported; zero fails)", () => {
    const rows = deskRows(KINDS.map((k) => ONE_OF_EACH[k]));
    const html = renderToStaticMarkup(<NeedsYou dict={dict} items={needsYouOrder(rows)} />);
    let checked = 0;
    for (const kind of KINDS) {
      expect(html.split(`data-attention="${kind}"`).length - 1, kind).toBe(1);
      checked++;
    }
    console.info(`[A4 sweep] Attention kinds rendered in the Match Day list: ${checked} of ${KINDS.length}`);
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(KINDS.length);
    // Every row's copy is a sentence, never a key.
    expect(html).not.toMatch(/desk\.needsYou\./);
  });
});

describe("A4 — the scorer's QR on a called or playing court", () => {
  it("playing and called: the console's Remote scoring panel, embedded, under the court's own heading for it", () => {
    let checked = 0;
    for (const c of [
      court(),
      court({ state: "called", current: fx({ started_at: null, headline: null, called_at: "2026-10-31T11:31:00.000Z" }) }),
    ]) {
      const html = focus(c);
      const at = html.indexOf('data-testid="md-scorer"');
      expect(at, c.state).toBeGreaterThan(-1);
      const section = html.slice(at, html.indexOf("</section>", html.indexOf('data-role="device-link-panel"', at)));
      expect(section, c.state).toContain(`>${t(dict, "dlink.title")}<`);
      expect(section, c.state).toContain('data-role="device-link-panel"');
      // Embedded: no card of its own and no second "Remote scoring" heading inside it.
      expect(section.split(`>${t(dict, "dlink.title")}<`).length - 1, c.state).toBe(1);
      expect(section, c.state).toContain('data-testid="device-link-mint"');
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("free and in use elsewhere: no scorer QR (nothing to score here) — decided by the court's STATE, not by whether a match rode along", () => {
    for (const c of [
      court({ state: "free", current: null }),
      court({ state: "in_use_elsewhere", current: null, in_use_by: "Winter Open" }),
      // The wire never sends a match with these states (types.ts); the gate is the state, so it does not lean on that.
      court({ state: "free", current: fx() }),
      court({ state: "in_use_elsewhere", current: fx(), in_use_by: "Winter Open" }),
    ]) {
      const html = focus(c);
      expect(html, c.state).not.toContain('data-testid="md-scorer"');
      expect(html, c.state).not.toContain('data-role="device-link-panel"');
    }
  });
});

describe("A4 — no_scorer / not_recording mark the affected court's row", () => {
  const rowOf = (c: MatchDayCourt) => renderToStaticMarkup(<CourtList courts={[c]} selectedId={null} dict={dict} onSelect={() => {}} />);

  it("EMPTY CASE FIRST: a playing court with no attention carries no mark", () => {
    const html = rowOf(court());
    expect(html).not.toContain("data-md-scorer=");
    expect(html).not.toContain('data-scorer="');
  });

  it("each scorer kind marks its court's row, in its own words and the desk's declared severity, in every locale (count reported)", () => {
    let checked = 0;
    for (const kind of SCORER_ATTENTIONS) {
      for (const [locale, d] of Object.entries(DICTS)) {
        const html = renderToStaticMarkup(
          <CourtList courts={[court({ current: fx({ scorer_attention: kind }) })]} selectedId={null} dict={d} onSelect={() => {}} />,
        );
        expect(html, `${locale} ${kind}`).toContain(`data-scorer="${kind}"`);
        expect(html, `${locale} ${kind}`).toContain(`data-md-scorer="${kind}"`);
        expect(html, `${locale} ${kind}`).toContain(`data-severity="${ATTENTION_SEVERITY[kind]}"`);
        expect(html, `${locale} ${kind}`).toContain(`>${esc(t(d, `matchDay.scorer.${kind}`))}<`);
        expect(html, `${locale} ${kind}`).not.toMatch(/matchDay\.scorer\./);
        checked++;
      }
    }
    console.info(`[A4 sweep] scorer marks checked: ${checked} (${SCORER_ATTENTIONS.length} kinds × ${Object.keys(DICTS).length} locales)`);
    expect(checked).toBe(SCORER_ATTENTIONS.length * 4);
    // The two kinds read differently (else the mark could not tell the organiser which it is).
    expect(t(dict, "matchDay.scorer.no_scorer")).not.toBe(t(dict, "matchDay.scorer.not_recording"));
  });

  it("only a PLAYING court carries a mark (only a match in play can be unscored)", () => {
    for (const state of ["called", "free", "in_use_elsewhere"] as const) {
      const c = court({ state, current: fx({ scorer_attention: "no_scorer" }) });
      expect(courtScorerAttention(c), state).toBeNull();
      expect(rowOf(c), state).not.toContain("data-md-scorer=");
    }
    expect(courtScorerAttention(court({ current: fx({ scorer_attention: "not_recording" }) }))).toBe("not_recording");
  });

  it("the focused court's QR heading carries the same mark", () => {
    const html = focus(court({ current: fx({ scorer_attention: "no_scorer" }) }));
    const scorer = html.slice(html.indexOf('data-testid="md-scorer"'));
    expect(scorer.slice(0, scorer.indexOf('data-role="device-link-panel"'))).toContain('data-md-scorer="no_scorer"');
  });
});

describe("A4 — a playing court with a live stream shows its preview; any other shows the scoreboard (never an empty video box)", () => {
  const VIDEO = "dQw4w9WgXcQ";
  const live = (o: Partial<MatchDayFixture> = {}) =>
    goldenCourt("badminton", BADMINTON!, {
      stream: "live",
      serving: "away",
      live_video: { url: youtubeWatchUrl(VIDEO), made_for_kids: false },
      ...o,
    });

  it("live, on a YouTube video that may be embedded: 'Live on YouTube', the click-to-play facade on the video's thumbnail, the score under it", () => {
    expect(BADMINTON).not.toBeNull();
    const html = focus(live());
    expect(html).toContain('data-testid="md-stream-preview"');
    expect(html).not.toContain('data-testid="md-scoreboard"');
    const preview = html.slice(html.indexOf('data-testid="md-stream-preview"'));
    expect(preview).toContain(`>${t(dict, "stream.youtube.link.live")}<`);
    expect(preview).toContain('data-testid="replay-facade"');
    expect(preview).toContain(`/vi/${VIDEO}/hqdefault.jpg`);
    // Nothing loads from YouTube until a tap: no player in the first paint.
    expect(preview).not.toMatch(/<iframe/);
    // Named as the court's live stream, not a replay.
    expect(preview).toContain(`aria-label="${esc(t(dict, "matchDay.preview.label", { court: "Court 3" }))}"`);
    // The score under the picture, by Match Day's rule (games won, the current game's points), and who serves.
    const score = preview.slice(preview.indexOf('data-testid="md-preview-score"'));
    expect(score).toContain(`>${gamesWon(BADMINTON!)}<`);
    const open = setsOf(BADMINTON!).find((x) => !x.closed)!;
    expect(score).toContain(`>${open.home}–${open.away}<`);
    expect(score).toContain(`${esc(AWAY.name)} `);
    // The stream panel is one tap away.
    expect(preview).toContain(`href="${routes.fixture("acme", "safe-badminton", "girls-u14", 7)}?stream=open"`);
    expect(preview).toContain(`>${t(dict, "matchDay.stream.settings")}<`);
  });

  it("every case with nothing to embed falls back to the C1 scoreboard, with no video box (count reported)", () => {
    const cases: [string, MatchDayCourt][] = [
      ["live, pasted key (no video)", live({ live_video: null })],
      ["live, made for kids", live({ live_video: { url: youtubeWatchUrl(VIDEO), made_for_kids: true } })],
      ["live, not a YouTube video address", live({ live_video: { url: "https://example.com/watch?v=dQw4w9WgXcQ", made_for_kids: false } })],
      ["waiting for the phone", live({ stream: "waiting" })],
      ["no stream", live({ stream: null })],
    ];
    let checked = 0;
    for (const [name, c] of cases) {
      const html = focus(c);
      expect(html, name).not.toContain('data-testid="md-stream-preview"');
      expect(html, name).toContain('data-testid="md-scoreboard"');
      expect(html, name).not.toMatch(/<iframe|<video|data-testid="replay-box"|data-testid="replay-facade"/);
      checked++;
    }
    console.info(`[A4 sweep] preview fallbacks checked: ${checked}`);
    expect(checked).toBe(cases.length);
  });

  it("streamPreviewOf: the part only for a live stream on an embeddable YouTube video", () => {
    expect(youtubeVideoId(youtubeWatchUrl(VIDEO))).toBe(VIDEO);
    expect(streamPreviewOf({ stream: "live", live_video: { url: youtubeWatchUrl(VIDEO), made_for_kids: false } })).toEqual({
      partNo: 1,
      url: youtubeWatchUrl(VIDEO),
      madeForKids: false,
    });
    expect(streamPreviewOf({ stream: "live", live_video: null })).toBeNull();
    expect(streamPreviewOf({ stream: "live", live_video: { url: youtubeWatchUrl(VIDEO), made_for_kids: true } })).toBeNull();
    expect(streamPreviewOf({ stream: "waiting", live_video: { url: youtubeWatchUrl(VIDEO), made_for_kids: false } })).toBeNull();
    expect(streamPreviewOf({ stream: null, live_video: { url: youtubeWatchUrl(VIDEO), made_for_kids: false } })).toBeNull();
  });
});

describe("A3 carry-in — a middle-dot line never leaves a dot dangling", () => {
  it("the header: the competition on its own line, the counts as dot-led parts in a box that clips the dot of a part starting a line", () => {
    const html = shellHtml(view([court(), court({ court_id: "c-2", state: "free", current: null })]));
    const header = html.slice(html.indexOf('data-testid="md-header"'), html.indexOf("</header>"));
    // No stand-alone separator between the competition and the counts (the dangling dot of the 320 screenshot).
    expect(header).not.toMatch(/<span aria-hidden="true">·<\/span>/);
    const counts = header.slice(header.indexOf('data-testid="md-counts"'));
    const box = tagWith(header, "md-counts");
    expect(box).toMatch(/[\s"]overflow-hidden[\s"]/);
    // Every dot is inside its part, in front of it, and the part is pulled left by exactly the dot's width.
    const partsHtml = counts.split("data-dot-part").slice(1);
    expect(partsHtml).toHaveLength(3);
    for (const part of partsHtml) {
      const w = /-ml-\[([\d.]+em)\]/.exec(part)?.[1];
      const dot = /data-dot="true" class="[^"]*w-\[([\d.]+em)\]/.exec(part)?.[1] ?? /data-dot="" class="[^"]*w-\[([\d.]+em)\]/.exec(part)?.[1];
      expect(w).toBeDefined();
      expect(dot).toBe(w);
    }
    const gap = /gap-x-\[([\d.]+em)\]/.exec(box)?.[1];
    expect(gap).toBe(/-ml-\[([\d.]+em)\]/.exec(partsHtml[0]!)?.[1]);
  });

  it("DotLine renders each part once, in order, with one dot each", () => {
    const html = renderToStaticMarkup(<DotLine parts={["a", "b", "c"]} />);
    expect([...html.matchAll(/>([abc])</g)].map((m) => m[1])).toEqual(["a", "b", "c"]);
    expect(html.split(">·<").length - 1).toBe(3);
  });
});
