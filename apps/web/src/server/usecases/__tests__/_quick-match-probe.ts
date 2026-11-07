// Quick match plan 1, Task 6 — the probe that PROVES the sport offer (spec docs/superpowers/specs/2026-11-03-quick-match-
// design.md §9 "Create-and-score sweep", §13; pre-flight B6, D3). Test-only, like _seed.ts and _rig.ts: it imports
// `@seazn/engine/testkit`, which must never reach a production bundle.
//
// For every sport module (swept with the engine's own `forEachSportAsync`, which reports how many it visited) × each of
// its system variants:
//   1. generic is excluded with QUICK_MATCH_GENERIC and nothing is created: the probe is the one source that keeps it off
//      the setup screen and out of the API (B6e). A LINEUP sport (cricket) is excluded the same way, by name, with
//      QUICK_MATCH_LINEUP_SPORT (spec C11, controller ruling 2026-11-07): the engine's walk CAN score cricket with no
//      lineup, through innings summaries, but a guest on the cricket pad meets mostly named-person actions it cannot use,
//      and a summary-only match is not the product C11 deferred to v2;
//   2. THE OFFER: a league of 2 sides and 1 play through the real create (`createQuickMatchTree`, never the guarded
//      wrapper: the probe must not go through the offer it is producing, A9), with the variant's registration default
//      kind, then ONE COMPLETE MATCH scored on its only fixture through the real write path (`scoreEvent`, what
//      POST /api/v1/fixtures/{id}/events calls) with no lineup. The events are the engine's own walk for that module
//      (`buildWalk`, the walk its conformance corpora record), never a hand-typed sequence. Decided → offered; refused →
//      excluded with the refusal's code; unproven → the probe fails, naming the case and both budgets;
//   3. THE COUNTS (D3, offered variants only): for each kind the sport takes, a league of 2..6 sides and, where a knockout
//      is offered, a knockout of 3..6 — each asserting that its generated non-bye fixtures, the create's `matchCount` and
//      the preview's `matchCount` are one number, and, for a knockout, that no bracket match it seats can end level
//      (C23's premise: a level knockout result waits for an organiser, and a guest has none).
// Every create is hard-deleted after it is read.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { EngineError, isCoreEventType, type EventEnvelope, type LineupPair } from "@seazn/engine/core";
import { bracketMayEndLevel, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { buildWalk, forEachSportAsync, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isBye } from "@/lib/run-sheet-groups";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AppendEventRequest } from "@/server/api-v1/schemas";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { resolveModule } from "@/server/engine-db/registry";
import { registrationDefaultKind } from "../entrant-shape";
import { listDivisionFixtures } from "../fixtures";
import { createQuickMatchTree, sealNewHomeToken, systemAuth, type CreatedQuickMatch } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { quickMatchPreview, type QuickMatchFormat } from "../quick-match-preview";
import { offerFor, type QuickMatchOfferJson } from "../quick-match-sports";
import { scoreEvent } from "../scoring";

/** The probe's budgets: generator seeds tried per sport × variant, and events per walk. An unproven case names both. */
export const PROBE_SEEDS = 32;
export const PROBE_MAX_EVENTS = 4000;

export type OfferJson = QuickMatchOfferJson;

/** The code generic is excluded with (B6e): not a refusal of the write path, a product decision the probe owns. */
export const QUICK_MATCH_GENERIC = "QUICK_MATCH_GENERIC";
/** The code a lineup sport is excluded with (spec C11: lineup sports are optional and wait for v2; controller ruling
 *  2026-11-07). A product decision the probe owns, like generic's — not a refusal of the write path, which accepts a
 *  cricket match scored by innings summaries with no lineup (engine 3.0.2). */
export const QUICK_MATCH_LINEUP_SPORT = "QUICK_MATCH_LINEUP_SPORT";
/** The lineup sports C11 names. Typed, because no engine declaration says "this pad needs a named person to score"
 *  (`LineupPolicy` covers substitutions only). */
export const QUICK_MATCH_LINEUP_SPORTS: ReadonlySet<string> = new Set(["cricket"]);

/** The repo root's engine package.json, as toolchain.test.ts reads it: the version the offer was proven on. */
const ENGINE_PACKAGE_JSON = resolve(import.meta.dirname, "../../../../../../node_modules/@seazn/engine/package.json");

/**
 * The first seed in 1..PROBE_SEEDS whose walk reaches `module.outcome(state) !== null` through `core.start` and
 * MODULE-OWNED events only, up to and including the deciding event. A walk that draws `core.forfeit`, `core.abandon` or
 * any other `core.*` event before it decides is skipped (the generator draws them; a forfeit is not play), and so is a
 * walk the generator cannot draw at all (it throws: cricket's "ran out of eligible players" with no lineup). null = no
 * seed decides (unproven).
 */
export function decidingPrefix(module: AnySportModule, cfg: unknown, lineups: LineupPair): EventEnvelope[] | null {
  for (let seed = 1; seed <= PROBE_SEEDS; seed++) {
    let walk: { events: EventEnvelope[]; states: unknown[] };
    try {
      walk = buildWalk(module as never, cfg as never, lineups, seed, PROBE_MAX_EVENTS) as typeof walk;
    } catch {
      continue;
    }
    for (const [i, event] of walk.events.entries()) {
      if (isCoreEventType(event.type) && event.type !== "core.start") break;
      if (module.outcome(walk.states[i] as never) !== null) return walk.events.slice(0, i + 1);
    }
  }
  return null;
}

export type PlayResult =
  | { kind: "decided"; events: number; lastSeq: number; lastEventId: string }
  | { kind: "refused"; code: string; at: { seq: number; type: string; message: string } }
  | { kind: "unproven"; why: string };

/** A write-path refusal's code: an `EngineError`'s own, an `HttpError`'s third argument, else its status. Anything else
 *  is not a refusal (a crash, a bug) and is never folded into one. */
function refusalCode(err: unknown): string | null {
  if (err instanceof EngineError) return err.code;
  if (err instanceof HttpError) return err.code ?? `HTTP_${err.status}`;
  return null;
}

interface FixtureFold {
  module: AnySportModule;
  cfg: unknown;
  lineups: LineupPair;
}

/** The fixture's own sport, fold cfg (`resolveFixtureCfg`, what the write path folds with) and seats, with no lineup:
 *  `slots: []`, so a walk started from `module.init(cfg, lineups)` names the fixture's own entrants and nobody else. */
async function fixtureFold(auth: AuthCtx, fixtureId: string): Promise<FixtureFold> {
  const [row] = await withTenant(auth.orgId, (tx) => tx<{
    home_entrant_id: string | null;
    away_entrant_id: string | null;
    config_snapshot: unknown;
    rules_override: unknown;
    sport_key: string;
    module_version: string;
    division_config: unknown;
    stage_kind: string | null;
    stage_config: Record<string, unknown> | null;
  }[]>`
    select f.home_entrant_id, f.away_entrant_id, f.config_snapshot, f.rules_override,
           d.sport_key, d.module_version, d.config as division_config,
           s.kind as stage_kind, s.config as stage_config
    from fixtures f
    join divisions d on d.id = f.division_id
    left join stages s on s.id = f.stage_id
    where f.id = ${fixtureId}`);
  if (!row) throw new Error(`probe: fixture ${fixtureId} not found`);
  if (!row.home_entrant_id || !row.away_entrant_id) throw new Error(`probe: fixture ${fixtureId} has an empty seat`);
  const module = resolveModule(row.sport_key, row.module_version);
  const cfg = resolveFixtureCfg(
    { config_snapshot: row.config_snapshot, rules_override: row.rules_override },
    row.division_config,
    { kind: row.stage_kind, config: row.stage_config },
    module,
  );
  const lineups: LineupPair = {
    home: { entrantId: row.home_entrant_id, slots: [] },
    away: { entrantId: row.away_entrant_id, slots: [] },
  };
  return { module, cfg, lineups };
}

/**
 * Score one complete match on `fixtureId` through the real write path: `decidingPrefix`'s events, each posted with
 * expected_seq = the envelope's seq (the count of events before it). A refusal → refused, with its code. The last post
 * must answer status "decided"; anything else is unproven — the walk and the write path disagree (§12: stop and report).
 *
 * When NO seed decides, the write path is still asked the one question every match starts with: `core.start`. A refusal
 * there is the write path's own answer for this sport with no lineup (refused); a start it accepts leaves the case
 * unproven.
 */
export async function playToDecided(auth: AuthCtx, fixtureId: string): Promise<PlayResult> {
  const { module, cfg, lineups } = await fixtureFold(auth, fixtureId);
  const prefix = decidingPrefix(module, cfg, lineups) ?? [];
  const events = prefix.length > 0 ? prefix : [makeEnvelope(0, { type: "core.start", payload: {} })];
  let last: Awaited<ReturnType<typeof scoreEvent>> | null = null;
  for (const e of events) {
    try {
      last = await scoreEvent(auth, fixtureId, { expected_seq: e.seq, type: e.type, payload: e.payload });
    } catch (err) {
      const code = refusalCode(err);
      if (code === null) throw err;
      return { kind: "refused", code, at: { seq: e.seq, type: e.type, message: (err as Error).message } };
    }
  }
  if (prefix.length === 0) {
    return { kind: "unproven", why: `no seed in 1..${PROBE_SEEDS} decided within ${PROBE_MAX_EVENTS} events, and the write path took core.start` };
  }
  if (last?.status !== "decided") {
    return { kind: "unproven", why: `the walk decided after ${prefix.length} events but the write path answered status '${last?.status}'` };
  }
  return { kind: "decided", events: prefix.length, lastSeq: last.seq, lastEventId: last.event_id };
}

/**
 * `[core.start, the first PLAY event]` for the fixture's own sport, cfg and seats, as the two requests that score them:
 * expected_seq 0 and 1. The play event is the engine's own (`onePlayEvent`: module-owned, accepted strictly as the next
 * event, moves the score, leaves the match undecided). The walk's first event is `core.start`, so "the first event of the
 * sequence" was a start, not a rally (pre-flight A10). Throws when the module has no such event here.
 */
export async function firstRallyFor(fixtureId: string): Promise<AppendEventRequest[]> {
  const { module, cfg, lineups } = await fixtureFold(systemAuth(), fixtureId);
  const start = makeEnvelope(0, { type: "core.start", payload: {} });
  const play = onePlayEvent(module, cfg, lineups, [start]);
  if (play === null) throw new Error(`firstRallyFor: ${module.key} draws no play event after core.start on fixture ${fixtureId}`);
  return [
    { expected_seq: 0, type: start.type, payload: start.payload },
    { expected_seq: 1, type: play.type, payload: play.payload },
  ];
}

const SIDE_NAMES = ["Side 1", "Side 2", "Side 3", "Side 4", "Side 5", "Side 6"];

/** One create through the real tree, its own name and visitor (A16) and a fresh sealed token. */
function probeCreate(
  sport_key: string,
  variant_key: string,
  kind: Parameters<typeof createQuickMatchTree>[1],
  format: QuickMatchFormat,
  sides: number,
): Promise<CreatedQuickMatch> {
  return createQuickMatchTree(
    {
      name: `QM probe ${randomUUID().slice(0, 8)}`,
      sport_key,
      variant_key,
      format,
      sides: SIDE_NAMES.slice(0, sides),
      plays: 1,
      email: null,
      locale: "en",
    },
    kind,
    { visitorHash: `probe-visitor-${randomUUID()}`, home: sealNewHomeToken() },
  );
}

/**
 * Run the whole probe (module header). Throws when any case is unproven (naming it and both budgets), when a count
 * case disagrees (naming it), when `offered` is empty, or when it lacks badminton. `checked` counts sport × variant
 * cases, `countCases` the D3 creates; both are printed unless `quiet`.
 */
export async function runQuickMatchProbe(opts: { quiet?: boolean }): Promise<{ offer: OfferJson; checked: number; countCases: number }> {
  const say = (line: string) => { if (!opts.quiet) console.info(line); };
  const auth = systemAuth();
  const offered: OfferJson["offered"] = [];
  const excluded: OfferJson["excluded"] = [];
  const unproven: string[] = [];
  const countFailures: string[] = [];
  let checked = 0;
  let countCases = 0;

  const visited = await forEachSportAsync(async ({ key: sport_key }) => {
    const [sport] = await sql<{ module_version: string }[]>`select module_version from sports where key = ${sport_key}`;
    if (!sport) throw new Error(`probe: sport ${sport_key} has no catalog row (run \`npm run sync:sports\`)`);
    const variants = await sql<{ key: string; config: unknown }[]>`
      select key, config from sport_variants
      where sport_key = ${sport_key} and is_system and org_id is null order by key`;
    if (variants.length === 0) throw new Error(`probe: sport ${sport_key} has no system variant (run \`npm run sync:sports\`)`);

    for (const variant of variants) {
      const variant_key = variant.key;
      const name = `${sport_key}/${variant_key}`;
      checked++;
      if (sport_key === "generic") {
        excluded.push({ sport_key, variant_key, code: QUICK_MATCH_GENERIC });
        say(`probe ${name}: excluded ${QUICK_MATCH_GENERIC}`);
        continue;
      }
      if (QUICK_MATCH_LINEUP_SPORTS.has(sport_key)) {
        excluded.push({ sport_key, variant_key, code: QUICK_MATCH_LINEUP_SPORT });
        say(`probe ${name}: excluded ${QUICK_MATCH_LINEUP_SPORT}`);
        continue;
      }

      // 2. The offer: one full match, scored with no lineup.
      const kind = registrationDefaultKind({ sport_key, module_version: sport.module_version, config: variant.config });
      let result: PlayResult;
      let created: CreatedQuickMatch | null = null;
      try {
        created = await probeCreate(sport_key, variant_key, kind, "league", 2);
        const matches = (await listDivisionFixtures(auth, created.divisionId)).filter((f) => !isBye(f));
        if (matches.length !== 1) throw new Error(`probe ${name}: a league of 2 generated ${matches.length} matches, not 1`);
        result = await playToDecided(auth, matches[0]!.id);
      } catch (err) {
        // The create itself refusing is a refusal too: a guest could not create it either.
        const code = refusalCode(err);
        if (code === null || created !== null) throw err;
        result = { kind: "refused", code, at: { seq: -1, type: "create", message: (err as Error).message } };
      } finally {
        if (created) await hardDeleteQuickMatchCompetition(created.competitionId);
      }
      if (result.kind === "decided") {
        offered.push({ sport_key, variant_key });
        say(`probe ${name}: offered (decided after ${result.events} events)`);
      } else if (result.kind === "refused") {
        excluded.push({ sport_key, variant_key, code: result.code });
        say(`probe ${name}: excluded ${result.code} at seq ${result.at.seq} (${result.at.type}): ${result.at.message}`);
        continue;
      } else {
        unproven.push(`${name}: ${result.why}`);
        continue;
      }

      // 3. The counts, offered variants only (D3).
      const offer = await offerFor(sport_key, variant_key);
      if (offer.kinds.length === 0) throw new Error(`probe ${name}: the sport offers no entrant kind`);
      for (const k of offer.kinds) {
        const cases: [QuickMatchFormat, number][] = [
          ...[2, 3, 4, 5, 6].map((n): [QuickMatchFormat, number] => ["league", n]),
          ...(offer.knockoutAllowed ? [3, 4, 5, 6].map((n): [QuickMatchFormat, number] => ["knockout", n]) : []),
        ];
        for (const [format, n] of cases) {
          countCases++;
          const out = await probeCreate(sport_key, variant_key, k, format, n);
          try {
            const matches = (await listDivisionFixtures(auth, out.divisionId)).filter((f) => !isBye(f));
            const generated = matches.length;
            const previewed = quickMatchPreview({ format, sides: n, plays: 1 }).matchCount;
            if (generated !== out.matchCount || generated !== previewed) {
              countFailures.push(`${name} ${k} ${format} of ${n}: generated ${generated}, create said ${out.matchCount}, preview said ${previewed}`);
            }
            // C23's premise, as a guard: a knockout is offered only where no bracket match can end level, because a
            // level result waits for an organiser's settle and a guest has none. Asked of a seated first-round match's
            // own fold cfg (the stage's preset deciders included), through the engine's one answer (`canEndLevel`).
            if (format === "knockout") {
              const seated = matches.find((f) => f.home_entrant_id !== null && f.away_entrant_id !== null);
              if (!seated) throw new Error(`probe ${name} knockout of ${n}: no seated first-round match`);
              const fold = await fixtureFold(auth, seated.id);
              if (bracketMayEndLevel(fold.module, "knockout", fold.cfg)) {
                countFailures.push(`${name} ${k} knockout of ${n}: offered, but a bracket match can end level (C23)`);
              }
            }
          } finally {
            await hardDeleteQuickMatchCompetition(out.competitionId);
          }
        }
      }
    }
  }, builtinModules);

  say(`quick match probe: ${visited} sports, ${checked} sport×variant cases, ${countCases} count cases; offered ${offered.length}, excluded ${excluded.length}`);
  if (visited === 0 || checked === 0) throw new Error("quick match probe checked nothing");
  if (unproven.length > 0) {
    throw new Error(`quick match probe: ${unproven.length} case(s) unproven at PROBE_SEEDS=${PROBE_SEEDS}, PROBE_MAX_EVENTS=${PROBE_MAX_EVENTS}:\n  ${unproven.join("\n  ")}`);
  }
  if (countFailures.length > 0) throw new Error(`quick match probe: count or knockout checks failed:\n  ${countFailures.join("\n  ")}`);
  if (offered.length === 0) throw new Error("quick match probe offered nothing");
  if (!offered.some((o) => o.sport_key === "badminton")) throw new Error("quick match probe does not offer badminton (spec §9)");

  const engine = (JSON.parse(readFileSync(ENGINE_PACKAGE_JSON, "utf8")) as { version: string }).version;
  return { offer: { engine, generatedAt: new Date().toISOString(), offered, excluded }, checked, countCases };
}
