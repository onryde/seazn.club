// W2b ruling 120 follow-up (2026-10-12): a career listing and its match count must agree, in every sport.
//
// The defect: the three career rollups (the console's ?group=sport, /me Career, the public card) listed a sport from
// the person's snapshot rows, and counted its matches from the fixtures. A fold credits only the keys a fact applies
// to, so a match played that credits a person nothing leaves no snapshot row: generic's abandon that decided nobody,
// and — the same shape, far more often — a footballer who scored nothing, a draw in a sport with no W/D/L key. The
// listing then left the sport out while its count read 1.
//
// The rule, from the career card's own contract (`groupCareerStatsBySport`: "a career card is also a record that you
// PLAYED the sport"): a sport is listed exactly when the person played a match in it or holds a figure in it, and the
// card's match count is the count's. Every scene is folded through the real engine — the snapshot rows are the fold's
// own (`aggregatePlayerStats`), the count is the engine's one players'-stats reader (`playedInStats`, which the career
// count's `fixturesPlayedInStats` asks) — and handed to the listing as the career rollups hand it. Scenes per declared
// cfg of every sport: a played abandon (an event of the sport's own play, then the abandon), and complete matches the
// module's own generator plays to their end (the first win, and the first draw, among the seeds). Counted; the
// shape the defect hid (a match played, no snapshot row) is counted per sport and must be reached.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { aggregatePlayerStats, playedInStats, type PlayerStatRow, type PlayerStatsFoldCtx } from "@seazn/engine/stats";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { buildStream, declaredCfgs, defaultLineupPair, forEachSport, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";
import { groupCareerStatsBySport, type CareerPlayedDivision, type CareerSnapshotRow } from "@/server/player-stats";
import type { MsgFn } from "@/lib/scoring-vocab";
import uiEn from "@/dictionaries/en/ui.json";

const en: MsgFn = (k) => (uiEn as Record<string, string>)[k];
const H = "H";
const A = "A";
/** Generator seeds per cfg, looking for a complete win and a complete draw. */
const SEEDS = 24;
const MAX_EVENTS = 800;
const DIVISION = "d-sweep";
const VARIANT = "v-sweep";

function foldOf(m: AnySportModule, cfg: unknown, l: LineupPair, events: readonly EventEnvelope[]) {
  try {
    return foldMatchWithStoppage(m as never, cfg as never, l, [...events]);
  } catch {
    return null;
  }
}

function rowsOf(m: AnySportModule, cfg: unknown, l: LineupPair, events: readonly EventEnvelope[]): PlayerStatRow[] {
  const persons: Record<string, string[]> = { [H]: l.home.slots.map((s) => s.personId), [A]: l.away.slots.map((s) => s.personId) };
  const ctx: PlayerStatsFoldCtx = { entrants: [{ id: H, kind: "individual" }, { id: A, kind: "individual" }], personsOf: (id) => persons[id] ?? [], cfg };
  return aggregatePlayerStats([...events], m.playerStats!, l, ctx);
}

describe("career listing vs the career count, every sport (ruling 120 follow-up)", () => {
  it("a sport is listed exactly when the person played a match in it or holds a figure in it, and its count is the count's — a played abandon, a complete win and a complete draw, every declared cfg", () => {
    const n = { sports: 0, cfgs: 0, scenes: 0, persons: 0, playedNoRow: 0, rowNotPlayed: 0, abandons: 0, wins: 0, draws: 0, refused: 0 };
    const shapeBySport = new Map<string, number>();
    const sports = new Set<string>();
    forEachSport(({ module: m }) => {
      if (m.playerStats === undefined) return;
      n.sports++;
      sports.add(m.key);
      const l = defaultLineupPair(m.positions);
      const persons = [...l.home.slots, ...l.away.slots].map((s) => s.personId);
      for (const { name, cfg } of declaredCfgs(m as never)) {
        n.cfgs++;
        const scenes: [string, unknown, EventEnvelope[]][] = [];
        // A played abandon: the sport's own play after the Start, then the abandon (decides nobody in most sports).
        const start = [makeEnvelope(1, { type: "core.start", payload: {} })];
        const playCfg = [cfg, m.configSchema.parse({ ...(cfg as object), ...m.bracketDeciders(cfg as never) })].find((c) => onePlayEvent(m, c, l, start) !== null);
        const play = playCfg === undefined ? null : onePlayEvent(m, playCfg, l, start);
        if (play !== null) {
          scenes.push(["a played abandon", playCfg, [...start, makeEnvelope(2, { type: play.type, payload: play.payload }), makeEnvelope(3, { type: "core.abandon", payload: { reason: "rain" } })]]);
        }
        // Complete matches from the module's own generator: the first win and the first draw.
        let win = false;
        let draw = false;
        for (let seed = 1; seed <= SEEDS && !(win && draw); seed++) {
          const events = buildStream(m as never, cfg as never, l, seed, MAX_EVENTS);
          const folded = foldOf(m, cfg, l, events);
          if (folded === null) continue;
          const kind = (outcomeOf(m as never, folded as never) as { kind?: string } | null)?.kind;
          if (!win && kind === "win") {
            win = true;
            scenes.push(["a complete win", cfg, events]);
          } else if (!draw && (kind === "draw" || kind === "tie")) {
            draw = true;
            scenes.push(["a complete draw", cfg, events]);
          }
        }
        for (const [what, c, events] of scenes) {
          if (foldOf(m, c, l, events) === null) {
            n.refused++;
            continue;
          }
          n.scenes++;
          if (what === "a played abandon") n.abandons++;
          else if (what === "a complete win") n.wins++;
          else n.draws++;
          const played = playedInStats(events, m);
          const rows = rowsOf(m, c, l, events);
          for (const p of persons) {
            n.persons++;
            const label = `${m.key}/${name}: ${what}: ${p}`;
            const snapshot: CareerSnapshotRow[] = rows
              .filter((r) => r.personId === p)
              .map((r) => ({ division_id: DIVISION, sport_key: m.key, variant_key: VARIANT, stats: r.stats as Record<string, number> }));
            const count = new Map<string, CareerPlayedDivision>(played ? [[DIVISION, { sport_key: m.key, variant_key: VARIANT, matches: 1 }]] : []);
            if (played && snapshot.length === 0) {
              n.playedNoRow++;
              shapeBySport.set(m.key, (shapeBySport.get(m.key) ?? 0) + 1);
            }
            if (!played && snapshot.length > 0) n.rowNotPlayed++;
            const listing = groupCareerStatsBySport(snapshot, count, en);
            const card = listing.find((x) => x.sport_key === m.key);
            expect(listing.length, `${label}: one card at most`).toBeLessThanOrEqual(1);
            expect(card !== undefined, `${label}: listed exactly when played or holding a figure`).toBe(played || snapshot.length > 0);
            if (card !== undefined) {
              expect(card.matches, `${label}: the card's count is the count's`).toBe(played ? 1 : 0);
              expect([card.divisions, card.variants], `${label}: one division, one variant`).toEqual([1, 1]);
            }
          }
        }
      }
    });
    const report = JSON.stringify({ ...n, shapeBySport: Object.fromEntries(shapeBySport) });
    // Not vacuous: every sport with a players'-stats model, every scene kind reached, and the shape the defect hid.
    expect([...sports].sort(), report).toEqual(builtinModules.filter((m) => m.playerStats !== undefined).map((m) => m.key).sort());
    expect(n.abandons, report).toBe(n.cfgs);
    expect(n.wins, report).toBeGreaterThan(0);
    expect(n.draws, report).toBeGreaterThan(0);
    expect(n.persons, report).toBeGreaterThan(n.scenes);
    expect(n.playedNoRow, `a match played with no snapshot row (the defect's shape): ${report}`).toBeGreaterThan(0);
    expect(shapeBySport.has("generic"), `generic's played abandon that decided nobody: ${report}`).toBe(true);
  });
});
