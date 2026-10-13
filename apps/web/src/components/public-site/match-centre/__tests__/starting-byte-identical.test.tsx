// T17 owner change (2026-10-13): STARTING on an online chess board whose round is open with no move yet. The
// scorebug and the division Fixtures list are shared by every sport, so the change is gated strictly — and this
// file is the proof that nothing ELSE moved: every built-in sport × every fixture status renders the court card
// BYTE-IDENTICALLY to BASE 5ce459f89 (before the change), and so does the Fixtures list with each of its existing
// watch kinds and with none. The golden holds a hash per case, captured AT BASE by running this file with
// CAPTURE_STARTING_GOLDEN=1 — the expected values come from the code as it was, never from the code under test.
//
// A deliberate future change to the court card or the list reds this file: re-capture it in that change, and say so.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { builtinModules } from "@seazn/engine/sports";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { msgFor } from "@/lib/messages-i18n";
import { buildMatchCentre, type MatchCentreInput } from "@/server/public-site/match-centre";
import type { PublicFixture } from "@/server/public-site/data";
import type { SideT } from "@/server/public-site/match-centre-schema";
import type { PublicWatchLink } from "@/server/external-play/public-view";
import { publicWatchCopy } from "@/server/public-site/schedule-copy";
import en from "@/dictionaries/en/public.json";
import { CourtCard } from "../court-card";
import { Schedule, type ScheduleCopy } from "../../schedule";

const GOLDEN = join(__dirname, "__fixtures__", "starting-byte-identical.json");
const CAPTURE = process.env.CAPTURE_STARTING_GOLDEN === "1";
const NOW = new Date("2026-10-16T18:05:00.000Z");

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const F = (over: Partial<PublicFixture> = {}): PublicFixture => ({
  id: "fx1",
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: 1,
  home_entrant_id: "home",
  away_entrant_id: "away",
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: "2026-10-16T18:00:00.000Z",
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});
const SIDES: [SideT, SideT] = [
  { entrantId: "home", name: "Ada Okonkwo", short: "ADA", colour: null, badgeUrl: null },
  { entrantId: "away", name: "Tomasz Wieczorek", short: "TOM", colour: null, badgeUrl: null },
];

/** A sport's own default config — its schema's, or its first named preset's when the schema needs one. */
function cfgOf(m: (typeof builtinModules)[number]): unknown {
  try {
    return m.configSchema.parse({});
  } catch {
    const first = Object.values(m.variants)[0] ?? {};
    return m.configSchema.parse(first);
  }
}

/** Every case the court card must keep: each sport × each fixture status, plus R3's live fold (an online game being
 *  played) — the one online state that already existed. */
function courtCases(): Record<string, string> {
  const out: Record<string, string> = {};
  const cases: [string, Partial<MatchCentreInput>][] = [];
  for (const m of builtinModules) {
    for (const status of FIXTURE_STATUSES) cases.push([`${m.key}/${status}`, { sportKey: m.key, cfg: cfgOf(m) as never, fixture: F({ status }) }]);
    cases.push([`${m.key}/scheduled/no-time`, { sportKey: m.key, cfg: cfgOf(m) as never, fixture: F({ scheduled_at: null }) }]);
  }
  const bg = builtinModules.find((m) => m.key === "boardgame")!;
  cases.push(["boardgame/scheduled/online-live", { sportKey: "boardgame", cfg: cfgOf(bg) as never, fixture: F({ scheduled_at: null }), onlineGameInPlay: true }]);
  cases.push(["boardgame/scheduled/online-not-live", { sportKey: "boardgame", cfg: cfgOf(bg) as never, fixture: F({ scheduled_at: null }), onlineGameInPlay: false }]);
  for (const [key, over] of cases) {
    const doc = buildMatchCentre({
      fixture: F(),
      sportKey: "generic",
      cfg: undefined as never,
      events: [],
      lineups: { home: [], away: [] },
      sides: SIDES,
      venueTz: "Europe/London",
      locale: "en",
      now: NOW,
      hrefs: { division: "/d/1", competition: "/c/1", calendar: null },
      stage: null,
      moduleVersion: null,
      formatLabel: null,
      ...over,
    });
    out[`court:${key}`] = hash(renderToStaticMarkup(<CourtCard header={doc.header} dict={en as never} />));
  }
  return out;
}

const COPY: ScheduleCopy = {
  timeTbd: "(time tbd)", allEntrants: "(all)", live: "(live)", ended: "(ended)", tbd: "(tbd)", held: "(held)",
  filterLabel: "(filter)", viewLabel: "(view)", viewDay: "(day)", viewRound: "(round)", calendar: "(calendar)",
  timesIn: "(times in {zone})", empty: "(empty)", roundOpened: "(opened)",
};

/** The Fixtures list: each existing watch kind, a board with none, and no watch prop at all. */
function listCases(): Record<string, string> {
  const fixtures = [
    F({ id: "f1", status: "in_play", seq_in_round: 1 }),
    F({ id: "f2", status: "decided", seq_in_round: 2 }),
    F({ id: "f3", seq_in_round: 3 }),
    F({ id: "f4", seq_in_round: 4, scheduled_at: null }),
  ];
  const links: Record<string, PublicWatchLink> = { f1: { kind: "live" }, f2: { kind: "final", score: "1–0" }, f3: { kind: "not_opened" } };
  const render = (watch?: Parameters<typeof Schedule>[0]["watch"]) =>
    renderToStaticMarkup(
      <Schedule
        fixtures={fixtures}
        entrantNames={{ home: "Ada Okonkwo", away: "Tomasz Wieczorek" }}
        divisionPath="/o/c/d"
        tz="Europe/London"
        slotLabels={{}}
        roundLabels={{}}
        stageOrder={{ s1: 1 }}
        stageNames={{ s1: "League" }}
        copy={COPY}
        locale="en"
        {...(watch ? { watch } : {})}
      />,
    );
  const out: Record<string, string> = {};
  out["list:no-watch"] = hash(render());
  for (const locale of ["en", "es", "fr", "nl"] as const) {
    out[`list:links/${locale}`] = hash(render({ links, copy: publicWatchCopy((k) => msgFor(locale, k)) }));
  }
  return out;
}

describe("STARTING moves nothing else — byte-identical to BASE 5ce459f89", () => {
  it("every sport × every status on the court card, and every existing watch kind on the Fixtures list — counted", () => {
    const now = { ...courtCases(), ...listCases() };
    if (CAPTURE) {
      writeFileSync(GOLDEN, `${JSON.stringify({ capturedAt: "5ce459f89", cases: now }, null, 2)}\n`);
      return;
    }
    expect(existsSync(GOLDEN), "the BASE golden is checked in").toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { cases: Record<string, string> };
    let checked = 0;
    for (const [key, want] of Object.entries(golden.cases)) {
      expect(now[key], key).toBe(want);
      checked += 1;
    }
    expect(Object.keys(now).sort(), "the same cases as BASE").toEqual(Object.keys(golden.cases).sort());
    // 11 sports × (8 statuses + no time) + 2 online + 5 list renders, at BASE.
    expect(checked, "anti-vacuity").toBe(builtinModules.length * (FIXTURE_STATUSES.length + 1) + 2 + 5);
  });
});

// T17 fix round 4, V4: the rail shows an online board's round-open time where it said "TBD". The Fixtures list is
// every sport's, so this second golden pins the list for every fixture status × with a time and without × a court
// name or none × a short and a long score line — with no watch prop (every other division, the embed) and with an
// online division's links — captured AT b42a805ab, before V4 (`CAPTURE_V4_GOLDEN=1`). Re-captured at cacf6b6e0, the same
// commit rebased onto W2b (2026-10-13): W2b's own schedule-row markup (the `schedule-score` test id, the forfeit tag
// track) changed every hash, so the BASE is the rebased pre-V4 tree, never the code under test.
const GOLDEN_V4 = join(__dirname, "__fixtures__", "rail-round-opened-byte-identical.json");
const CAPTURE_V4 = process.env.CAPTURE_V4_GOLDEN === "1";

/** The list sweep's fixtures: one row per shape, ids in render order. */
function railSweepFixtures(): PublicFixture[] {
  const out: PublicFixture[] = [];
  let n = 0;
  for (const status of FIXTURE_STATUSES) {
    for (const timed of [true, false]) {
      for (const court of [null, "Board 3"]) {
        n += 1;
        const decided = status === "decided" || status === "finalized" || status === "needs_decision";
        out.push(
          F({
            id: `r${n}`,
            seq_in_round: n,
            status,
            scheduled_at: timed ? "2026-10-16T18:00:00.000Z" : null,
            court_name: court,
            outcome: decided ? { kind: "win", winner: "home" } : null,
            summary:
              status === "in_play" || decided
                ? { perSide: n % 2 === 0 ? [{ entrantId: "home", line: "1" }, { entrantId: "away", line: "0" }] : [{ entrantId: "home", line: "156/6 (20)" }, { entrantId: "away", line: "120/9 (20)" }] }
                : null,
          }),
        );
      }
    }
  }
  return out;
}

function renderRailSweep(watch?: Parameters<typeof Schedule>[0]["watch"]): string {
  return renderToStaticMarkup(
    <Schedule
      fixtures={railSweepFixtures()}
      entrantNames={{ home: "Ada Okonkwo", away: "Tomasz Wieczorek" }}
      divisionPath="/o/c/d"
      tz="Europe/London"
      slotLabels={{}}
      roundLabels={{}}
      stageOrder={{ s1: 1 }}
      stageNames={{ s1: "League" }}
      copy={COPY}
      locale="en"
      {...(watch ? { watch } : {})}
    />,
  );
}

function railCases(): Record<string, string> {
  const out: Record<string, string> = { "rail:no-watch": hash(renderRailSweep()) };
  const ids = railSweepFixtures().map((f) => f.id);
  const live: Record<string, PublicWatchLink> = Object.fromEntries(ids.filter((_, i) => i % 3 === 0).map((id) => [id, { kind: "live" as const }]));
  for (const locale of ["en", "fr"] as const) {
    const copy = publicWatchCopy((k) => msgFor(locale, k));
    out[`rail:links-empty/${locale}`] = hash(renderRailSweep({ links: {}, copy }));
    out[`rail:links-some/${locale}`] = hash(renderRailSweep({ links: live, copy }));
  }
  return out;
}

describe("V4 moves nothing else on the Fixtures list — byte-identical to b42a805ab", () => {
  it("every fixture status × time or none × court or none × score line, without and with an online division's links — counted", () => {
    const now = railCases();
    if (CAPTURE_V4) {
      writeFileSync(GOLDEN_V4, `${JSON.stringify({ capturedAt: "b42a805ab", cases: now }, null, 2)}\n`);
      return;
    }
    expect(existsSync(GOLDEN_V4), "the b42a805ab golden is checked in").toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_V4, "utf8")) as { cases: Record<string, string> };
    let checked = 0;
    for (const [key, want] of Object.entries(golden.cases)) {
      expect(now[key], key).toBe(want);
      checked += 1;
    }
    expect(Object.keys(now).sort(), "the same cases as b42a805ab").toEqual(Object.keys(golden.cases).sort());
    expect(checked, "anti-vacuity: one bare render + two link sets in two locales").toBe(1 + 2 * 2);
    // The sweep itself: every status, twice for the time, twice for the court.
    expect(railSweepFixtures(), "anti-vacuity: the rows swept").toHaveLength(FIXTURE_STATUSES.length * 4);
  });
});
