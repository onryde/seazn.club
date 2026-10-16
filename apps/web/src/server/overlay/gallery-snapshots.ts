// The staff overlay gallery's snapshots (R2007 decision 6; spec 2026-10-15 §4.8). Every one is produced the way a
// real fixture's overlay payload is: a stream of ENGINE events — drawn from each module's own `arbitraryEvent`, never
// typed by hand — folded through the real `foldFrom`, its status derived by the write path's own rule
// (`nextStatus`, which is `fixtureStatusFromFold` for every event but a finalize), and projected through the real `projectOverlayLiveData` with the same
// recent-window and cricket-bundle builders `load.ts` uses. No DB: the gallery must render on a fresh environment, and
// a hand-built `OverlayLiveData` would prove the fixture rather than the overlay (AGENTS.md class 1).
//
// `gallery-snapshots.test.ts` runs every snapshot back through the overlay's model and `slateStateOf` (the card
// layer's own authority), so a snapshot that does not show the state its kind names fails there.
import "server-only";
import { kernelOwnsEvent, mulberry32, type EventEnvelope, type Lineup, type LineupPair } from "@seazn/engine/core";
import { resolvePositions, type AnySportModule, type PositionCatalog } from "@seazn/engine/sport";
import type { OverlayLiveData } from "@/components/public-site/live-score-data";
import type { RecentPerson } from "@/lib/overlay-recent-types";
import { OVERLAY_SPORT_KEYS } from "@/components/overlay/overlay-tokens";
import {
  GALLERY_RESULT_VARIANT_SPORTS,
  type GallerySnapshotKind,
  type ResultVariant,
} from "@/components/overlay/gallery-matrix";
import { resolveLatestModule } from "@/server/engine-db/registry";
import { foldFrom, type FoldedFixture } from "@/server/engine-db/fold";
import { nextStatus } from "@/server/engine-db/append-event";
import { buildOverlayRecent, nameCricketBundle, overlayCricketBundleIds, replayDerived } from "./recent";
import { projectOverlayLiveData } from "./project";

/** The two sides every gallery cell shows. The second name is 43 characters: a realistic long club name is what
 *  exposed the `truncate`/`min-w-0` defect (AGENTS.md, the phone composition), so the gallery always carries one. */
export const GALLERY_SIDES = [
  { id: "home", name: "Ashgrove Rovers" },
  { id: "away", name: "Northbridge Athletic Football & Social Club" },
] as const;

/** The card's context pill, as the broadcast page passes it (competition name · stage name). Long on purpose: at the
 *  30 px floor a real competition name overflows the pill, and the gallery must show how it truncates. */
export const GALLERY_SLATE_META = {
  competition: "Ashgrove & District Midweek Twenty20 Championship",
  stage: "Quarter-finals",
} as const;

/** The declared preset each sport's sample is drawn under, where the bare schema default is not a format a club
 *  plays: generic has no default result mode (its schema refuses `{}`), and cricket's overlay is built around T20. */
const GALLERY_PRESET: Readonly<Record<string, string>> = { cricket: "t20", generic: "score" };

/** One seed for every walk: `mulberry32(7)` decides every shipped module by play (probe 2026-10-15: football in 8
 *  events, cricket 68, boardgame 3, carrom 20, generic 2, volleyball 7, badminton 4, tabletennis 7, tennis 5, icehockey
 *  7, hockey 9). A module that stops deciding is refused by name below, never drawn as a half-played "result". */
const SEED = 7;
const MAX_EVENTS = 1500;
/** Wall-clock spacing between sample events, so a clock read off the stream shows minutes, not days. */
const STEP_MS = 40_000;
const FIXTURE_ID = "gallery";

/** Fictional people, one per line-up slot, so a cricket crease, a scorer or a carded player is NAMED on the card
 *  the way a real fixture's consented line-up names them. */
const PEOPLE: Readonly<Record<"home" | "away", readonly string[]>> = {
  home: [
    "Rashida Okonkwo",
    "Tomasz Wiśniewski",
    "Ada Okafor",
    "Ines van der Berg",
    "Mikko Lehtonen",
    "Elena Kovačević",
    "Priya Raghunathan",
    "Kwame Mensah-Boateng",
    "Siobhán Ní Dhuibhir",
    "Haruto Fujimoto",
    "Lucía Fernández",
  ],
  away: [
    "Callum MacLeod-Brennan",
    "Jean-Sébastien Tremblay",
    "Amara Diallo",
    "Ravi Chandrasekhar",
    "Freya Lindqvist",
    "Mateus Carvalho",
    "Yasmin El-Amin",
    "Oskar Nowakowski",
    "Thandiwe Dlamini",
    "Bram de Vries",
    "Noor Haddad",
  ],
};

/** A catalog-valid starting line-up: group minimums first, then round-robin padding within group maximums, each
 *  declared role on one distinct slot. The same construction the engine's conformance harness uses
 *  (`testkit/helpers.ts` `lineupFromCatalog`), restated here because a production module does not import the testkit. */
function lineupFor(catalog: PositionCatalog, entrantId: "home" | "away"): Lineup {
  const positions: (string | undefined)[] = [];
  for (const group of catalog.groups) for (let i = 0; i < (group.min ?? 0); i++) positions.push(group.key);
  const counts = new Map<string, number>(catalog.groups.map((group) => [group.key, group.min ?? 0]));
  for (let cursor = 0; positions.length < catalog.lineup.size; cursor++) {
    if (catalog.groups.length === 0) {
      positions.push(undefined);
      continue;
    }
    const group = catalog.groups[cursor % catalog.groups.length]!;
    const used = counts.get(group.key) ?? 0;
    if (group.max !== undefined && used >= group.max) {
      // Every group full and the line-up still short: the catalog cannot be filled, and looping would never end.
      if (catalog.groups.every((g) => g.max !== undefined && (counts.get(g.key) ?? 0) >= g.max)) break;
      continue;
    }
    counts.set(group.key, used + 1);
    positions.push(group.key);
  }
  const roles = catalog.roles ?? [];
  return {
    entrantId,
    slots: positions.slice(0, catalog.lineup.size).map((positionKey, i) => ({
      personId: `${entrantId}-p${i + 1}`,
      ...(positionKey === undefined ? {} : { positionKey }),
      slot: "starting" as const,
      orderNo: i + 1,
      ...(roles[i] === undefined ? {} : { roles: [roles[i]!.key] }),
    })),
  };
}

const personOf = (id: unknown): RecentPerson | undefined => {
  if (typeof id !== "string") return undefined;
  const match = /^(home|away)-p(\d+)$/.exec(id);
  if (!match) return undefined;
  const name = PEOPLE[match[1] as "home" | "away"][Number(match[2]) - 1];
  return name === undefined ? undefined : { name, masked: false };
};

interface Sample {
  sportKey: string;
  module: AnySportModule;
  cfg: unknown;
  lineups: LineupPair;
  /** The walk, ending on the event that decided the match by play. */
  played: EventEnvelope[];
}

function envelope(seq: number, type: string, payload: unknown): EventEnvelope {
  return { id: `${FIXTURE_ID}-${seq}`, fixtureId: FIXTURE_ID, seq, type, payload, recordedAt: "", recordedBy: null };
}

/** Re-number and re-time a stream so it is gapless from 1 and its last event lands at `now`. */
function stamp(events: readonly { type: string; payload: unknown }[], now: number): EventEnvelope[] {
  return events.map((e, i) => ({
    ...envelope(i + 1, e.type, e.payload),
    recordedAt: new Date(now - (events.length - 1 - i) * STEP_MS).toISOString(),
  }));
}

function sampleFor(sportKey: string): Sample {
  const sportModule = resolveLatestModule(sportKey);
  const preset = GALLERY_PRESET[sportKey];
  const cfg = sportModule.configSchema.parse(preset === undefined ? {} : (sportModule.variants[preset] ?? {}));
  const catalog = resolvePositions(sportModule, cfg);
  const lineups: LineupPair = { home: lineupFor(catalog, "home"), away: lineupFor(catalog, "away") };
  return { sportKey, module: sportModule, cfg, lineups, played: walkToDecision(sportKey, sportModule, cfg, lineups) };
}

/**
 * The seeded walk to a decision BY PLAY: the module's own generated events, applied one at a time until the module
 * decides. Exported for its guard's test.
 *
 * It records play only. A drawn `core.*` other than the start (a forfeit, an abandon, a void) would end or rewrite the
 * match by something other than play, and a kernel-owned type (suspend, resume, settle, the lineup family) is one the
 * kernel folds itself and the module refuses (review I-1, `outcome-readers.test.ts`): either is redrawn, as the
 * conformance walk does for a decided-by-play stream, and a generator that yields nothing else is refused by name.
 * The stop test reads the module's outcome of its OWN state: the walk is not a fold (no settle or withdrawal can be in
 * it, by the guard below); the snapshot it feeds is folded through `foldFrom` and read through `outcomeOf`.
 */
export function walkToDecision(
  sportKey: string,
  sportModule: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
): EventEnvelope[] {
  const rng = mulberry32(SEED);
  let state = sportModule.init(cfg, lineups);
  const played: EventEnvelope[] = [];
  const isPlay = (e: { type: string }) => !e.type.startsWith("core.") || e.type === "core.start";
  for (let n = 1; n <= MAX_EVENTS; n++) {
    let next = sportModule.arbitraryEvent?.(state, rng) ?? null;
    for (let k = 0; k < 64 && next !== null && !isPlay(next); k++) {
      next = sportModule.arbitraryEvent?.(state, rng) ?? null;
    }
    if (next === null) break;
    if (!isPlay(next) || kernelOwnsEvent(sportModule, next, { state, settled: false })) {
      throw new Error(`overlay gallery: ${sportKey}'s generator kept yielding ${next.type}; the walk records only play`);
    }
    const ev = envelope(n, next.type, next.payload);
    state = sportModule.apply(state, ev);
    played.push(ev);
    if (sportModule.outcome(state) !== null) return played;
  }
  throw new Error(`overlay gallery: ${sportKey} did not decide by play within ${MAX_EVENTS} events (seed ${SEED})`);
}

/** Fold a stream and project it exactly as `load.ts` does: status from the write path's rule unless `status` is
 *  stated (a status no event writes), recent window with the replay's annotations, cricket bundle named. */
function project(
  sample: Sample,
  events: EventEnvelope[],
  opts: { stageKind?: string | null; status?: string } = {},
): { data: OverlayLiveData; folded: FoldedFixture | null; derivedStatus: string } {
  const { sportKey, module: sportModule, cfg, lineups } = sample;
  if (events.length === 0) {
    const status = opts.status ?? "scheduled";
    return {
      data: projectOverlayLiveData({
        row: { status, summary: null, outcome: null, last_seq: null },
        folded: null,
        venueTz: "UTC",
      }),
      folded: null,
      derivedStatus: "scheduled",
    };
  }
  const stageKind = opts.stageKind ?? null;
  const folded = foldFrom(FIXTURE_ID, { sportKey, module: sportModule, cfg, lineups, envelopes: events, stageKind });
  const last = events[events.length - 1]!;
  const derivedStatus = nextStatus(last.type, folded.outcome, folded.active, stageKind);
  const { bySeq } = replayDerived({ sportKey, module: sportModule, cfg, lineups, active: folded.active });
  const recent = buildOverlayRecent({ active: folded.active, sides: ["home", "away"], personOf, derived: bySeq });
  const cricket = nameCricketBundle(
    overlayCricketBundleIds({ sportKey, module: sportModule, cfg, lineups }, folded.active),
    personOf,
  );
  const data = projectOverlayLiveData({
    row: {
      status: opts.status ?? derivedStatus,
      summary: folded.summary as OverlayLiveData["summary"],
      outcome: folded.outcome as OverlayLiveData["outcome"],
      last_seq: folded.lastSeq,
    },
    folded,
    venueTz: "UTC",
    recent,
    cricketLive: cricket.live,
    cricketToss: cricket.toss,
    lastClosedOver: cricket.lastClosedOver,
    scoringStarted: cricket.scoringStarted,
    highlights: cricket.highlights,
  });
  return { data, folded, derivedStatus };
}

function refuseUnless(cond: boolean, what: string): void {
  if (!cond) throw new Error(`overlay gallery: ${what}`);
}

/** The match in play: the longest prefix of the walk that leaves it undecided — the most score a live frame can show. */
const livePrefix = (sample: Sample) => sample.played.slice(0, -1).map(({ type, payload }) => ({ type, payload }));
const fullPlay = (sample: Sample) => sample.played.map(({ type, payload }) => ({ type, payload }));

export type GallerySnapshots = Record<string, Record<GallerySnapshotKind, OverlayLiveData>>;

/** Every overlay sport × warming / live / ended. `now` anchors the event times (the live clock reads them). */
export function gallerySnapshots(now: number = Date.now()): GallerySnapshots {
  const out: GallerySnapshots = {};
  for (const sportKey of OVERLAY_SPORT_KEYS) {
    const sample = sampleFor(sportKey);
    const warming = project(sample, []);
    const live = project(sample, stamp(livePrefix(sample), now));
    const ended = project(sample, stamp(fullPlay(sample), now));
    // Guards, not comments: each kind is the state it names, by the write path's own rule.
    refuseUnless(live.derivedStatus === "in_play", `${sportKey} live prefix folds to ${live.derivedStatus}`);
    refuseUnless(ended.derivedStatus === "decided", `${sportKey} full play folds to ${ended.derivedStatus}`);
    out[sportKey] = { warming: warming.data, live: live.data, ended: ended.data };
  }
  return out;
}

/** The Result-card variants other than "decided by play" (review m11), in display order. */
export const GALLERY_RESULT_STATUSES = ["finalized", "forfeited", "abandoned", "cancelled", "needs_decision"] as const;

/**
 * How each variant is produced. `derived` variants come out of the write path's status rule over real events; the
 * `stated` ones are statuses no event writes for the sport, so the row carries them over a real fold:
 *  - `cancelled` is written by the organiser and the import path, never by an event (`stages.ts`);
 *  - `needs_decision` is a LEVEL result in a bracket (ruling 79), and badminton cannot finish level; it is stated for
 *    both sports so the two cards are drawn over the same in-play fold.
 * `abandoned` runs in a knockout stage: a cricket abandon with no result folds to a level no-result (CK-AB-2), which
 * the status rule holds as "abandoned" only where a level result is forbidden.
 */
type Recipe = (sample: Sample, now: number) => ReturnType<typeof project> & { stated: boolean };

const RECIPES: Readonly<Record<(typeof GALLERY_RESULT_STATUSES)[number], Recipe>> = {
  finalized: (s, now) => ({
    ...project(s, stamp([...fullPlay(s), { type: "core.finalize", payload: {} }], now)),
    stated: false,
  }),
  forfeited: (s, now) => ({
    ...project(s, stamp([{ type: "core.forfeit", payload: { by: "away", reason: "walkover" } }], now)),
    stated: false,
  }),
  abandoned: (s, now) => ({
    ...project(s, stamp([...livePrefix(s), { type: "core.abandon", payload: { reason: "weather" } }], now), {
      stageKind: "knockout",
    }),
    stated: false,
  }),
  cancelled: (s, now) => ({ ...project(s, stamp(livePrefix(s), now), { status: "cancelled" }), stated: true }),
  needs_decision: (s, now) => ({
    ...project(s, stamp(livePrefix(s), now), { status: "needs_decision" }),
    stated: true,
  }),
};

export interface GalleryResultVariant {
  variant: ResultVariant;
  snapshot: OverlayLiveData;
}

/** One snapshot per (variant sport, result status). A derived variant whose events do not produce its status is
 *  refused by name: the card would otherwise be drawn for a status the product never reaches that way. */
export function galleryResultVariants(now: number = Date.now()): GalleryResultVariant[] {
  const out: GalleryResultVariant[] = [];
  for (const sportKey of GALLERY_RESULT_VARIANT_SPORTS) {
    const sample = sampleFor(sportKey);
    for (const status of GALLERY_RESULT_STATUSES) {
      const made = RECIPES[status](sample, now);
      if (!made.stated) refuseUnless(made.derivedStatus === status, `${sportKey}/${status} folds to ${made.derivedStatus}`);
      out.push({ variant: { status, sportKey }, snapshot: made.data });
    }
  }
  return out;
}
