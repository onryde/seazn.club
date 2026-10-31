// Match Day, task A3 (spec docs/superpowers/specs/2026-10-31-match-day-design.md §6, §7): the court list and the focused
// court, rendered to markup. apps/web vitest is `environment: "node"`, so these see what the server paints (and what a first
// client render paints); the call → Called → Undo sequence in a real browser is e2e/match-day.spec.ts.
//
// Assertions on attributes anchor on `="` (AGENTS.md: React serialises an omitted prop as "$undefined", so a bare `data-*`
// probe passes in both states). Expected copy is read from the dictionaries, the court noun from lib/venue.ts's own
// declarations and the sport list from the engine's registry — never from the components under test.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { registerBuiltins } from "@seazn/engine/sports";
import type { AnySportModule, SportRegistry } from "@seazn/engine/sport";
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
import type { MatchDayCandidate, MatchDayCourt, MatchDayFixture, MatchDayView } from "@/lib/match-day/types";
import {
  courtCounts,
  filterCandidates,
  filterCourts,
  isLive,
  REFUSAL_CODES,
  refusalMessage,
  sharedNoun,
} from "@/lib/match-day/view";
import { CourtList } from "@/components/v2/match-day/court-list";
import { CourtFocus, type MatchDayCtx } from "@/components/v2/match-day/court-focus";
import { CandidateRows, FreeCourtBody } from "@/components/v2/match-day/candidate-list";
import { CallSheetBody } from "@/components/v2/match-day/call-sheet";
import { MatchDayShell } from "@/components/v2/match-day/match-day-shell";

const dict = en as Dict;
const DICTS = { en, es, fr, nl } as Record<string, Dict>;

const ctx: MatchDayCtx = {
  competitionId: "comp-1",
  orgSlug: "acme",
  compSlug: "safe-badminton",
  locale: "en",
  tz: "Europe/London",
  dict,
  scoreDict: publicEn as Dict,
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
  headline: "0 – 0 (13-11)",
  started_at: "2026-10-31T11:20:00.000Z",
  called_at: null,
  stream: null,
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

const focus = (c: MatchDayCourt) =>
  renderToStaticMarkup(
    <CourtFocus ctx={ctx} court={c} backLabel="All courts" onBack={() => {}} onChanged={() => {}} refreshKey="k" divisions={null} />,
  );

/** The markup of the element carrying `attr="value"`, up to the next sibling of the same testid — rows here are flat lists. */
function rowsOf(html: string, testId: string): string[] {
  const parts = html.split(`data-testid="${testId}"`);
  return parts.slice(1);
}

describe("focused court: playing", () => {
  it("C1 — no stream: the scoreboard panel, a '+ Connect a stream' link to the match's stream panel, and no video slot", () => {
    const html = focus(court({ current: fx({ stream: null }) }));
    expect(html).toContain('data-testid="md-scoreboard"');
    // The engine's own headline, through LiveScoreBody — not a Match Day widget.
    expect(html).toContain("0 – 0 (13-11)");
    const connect = t(dict, "matchDay.stream.connect");
    expect(html).toContain(connect);
    const streamHref = `${routes.fixture("acme", "safe-badminton", "girls-u14", 7)}?stream=open`;
    expect(html).toContain(`href="${streamHref}"`);
    // No empty black video box (§5 anti-goal): no player element and no preview slot.
    expect(html).not.toMatch(/<video|<iframe/);
    expect(html).not.toContain('data-testid="md-stream-preview"');
    expect(html).not.toContain('data-md-stream="');
  });

  it("stream live: the Live badge and the watch link instead of '+ Connect a stream' (the positive half of the pair above)", () => {
    const html = focus(court({ current: fx({ stream: "live" }) }));
    expect(html).toContain('data-testid="md-scoreboard"');
    expect(html).toContain('data-md-stream="live"');
    expect(html).toContain(t(dict, "matchDay.stream.watch"));
    expect(html).not.toContain(t(dict, "matchDay.stream.connect"));
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

  it("a refused preview shows the organiser's words, not the code", () => {
    const html = sheet({ kind: "refused", message: refusalMessage(dict, CALL_REFUSAL.COURT_BUSY, { court_name: "Court 5", competition_name: "Winter Open" }) });
    expect(html).toContain("Winter Open");
    expect(html).not.toContain(CALL_REFUSAL.COURT_BUSY);
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
      court({ court_id: "c-1" }),
      court({ court_id: "c-2", state: "called", current: fx({ started_at: null, headline: null }) }),
      court({ court_id: "c-3", state: "free", current: null }),
      court({ court_id: "c-4", state: "in_use_elsewhere", current: null, in_use_by: "Winter Open" }),
    ];
    const rows = rowsOf(renderToStaticMarkup(<CourtList courts={courts} selectedId={null} dict={dict} onSelect={() => {}} />), "md-court-row");
    expect(rows[0]).toContain("0 – 0 (13-11)");
    expect(rows[1]).toContain(t(dict, "matchDay.state.called"));
    expect(rows[2]).toContain(t(dict, "matchDay.state.free"));
    expect(rows[3]).toContain(t(dict, "matchDay.state.inUse", { competition: "Winter Open" }));
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
  it("each registered sport's court shows its noun from matchDay.noun.* and the engine's own headline", () => {
    let checked = 0;
    const nouns = new Set<string>();
    for (const key of SPORTS) {
      const noun = venueNoun(key);
      nouns.add(noun);
      const html = focus(court({ sport_noun: noun, current: fx({ sport_key: key, headline: `${key} 2 – 1` }) }));
      expect(html, key).toContain(`>${t(dict, `matchDay.noun.${noun}`)}<`);
      expect(html, key).toContain(`${key} 2 – 1`);
      expect(html, key).toContain('data-testid="md-scoreboard"');
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
    expect(checked).toBe(SPORTS.length);
    // The sweep can witness a hard-coded "Court": at least one registered sport plays on something else.
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
