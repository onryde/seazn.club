// `momentsFor` — the overlay's recent window → the slabs that fire (stream
// overlay W2, spec "Step two — moments").
//
// PURE and CLIENT-SAFE: no import from `@/server/**`, which in this app is a
// BUILD FAILURE rather than a warning. It reads `RecentEvent`s the server
// projected (`server/overlay/recent.ts`) and decides which of them are worth
// interrupting a broadcast for.
//
// THE ALLOWLIST IS THE POINT. A sport with no entry renders nothing, by
// construction rather than by a guard — so a twelfth sport arriving in the
// registry cannot start throwing slabs on air because its event names happen
// to look like football's. Rules are FUNCTIONS, not a type→tone map: a
// `cricket.ball` is a six, a four, a wicket or nothing at all depending on its
// payload, and only the payload can say which.
//
// KEYS ARE PLAIN STRINGS, not the generated union. `MsgFn`'s key type is
// `keyof typeof ui.json` and would reject every `overlay.*` key, which live in
// the `public` namespace — W1 hit this first and answered it with `OverlayMsg`
// (`lib/overlay-model.ts`), reused here rather than forked. The union's safety
// is bought back by `MOMENT_KEYS` plus the test that holds it against the
// English dictionary: a mistyped key is a red test rather than a red compile.
//
// EVERY DICTIONARY KEY IS A LITERAL, never a template. The dictionary gate
// (`lib/__tests__/overlay-dict-coverage.test.ts`) scans for key literals, and a
// `` `overlay.moment.${x}` `` would register the PREFIX as dynamic and excuse
// every key under it from the orphan check — turning the gate off for exactly
// the keys it exists to hold. `DISCIPLINE_LABEL_KEYS` states the same rule for
// the same reason.
import { GAME_UNIT_SPORTS, disciplineLabel } from "@/lib/public-site";
import type { OverlayMoment as W1OverlayMoment, OverlayMsg } from "@/lib/overlay-model";
import type { RecentEvent } from "@/lib/overlay-recent-types";

/**
 * Spec "Step two", plus `seq` — the React key and the queue's identity.
 *
 * EXTENDS W1's declaration rather than restating it. `overlay-model.ts` typed
 * the shape a wave early so its components could leave room for the slab, and
 * two independent copies of `{ kind, headline, line?, tone }` would be free to
 * drift — its `tone` is already the wider `SportTone | "led"`, which is the one
 * this wave wants (hockey's green card is reachable through it).
 */
export interface OverlayMoment extends W1OverlayMoment {
  seq: number;
  /**
   * How this graphic renders. Default / absent = W2 moment slab.
   * `endOfOver` and `toss` are structured cards (2026-09-12 design).
   */
  graphic?: "slab" | "endOfOver" | "toss";
  /** Per-item hold override (toss uses 8s). Absent → queue default 4s. */
  holdMs?: number;
  /** Payload for `graphic: "endOfOver"`. */
  endOfOver?: import("@/lib/overlay-cricket").OverlayClosedOver;
}

export type MomentRule = (
  ev: RecentEvent,
  ctx: { msg: OverlayMsg; sportKey: string; sides: readonly [string, string] },
) => OverlayMoment | null;

const name = (ev: RecentEvent): string | undefined => ev.payload.person?.name;

/** Every `CricketWicket.kind` member. Stated rather than templated (see the
 *  header); the test holds this table against the engine's own enum, so a
 *  new mode of dismissal is a missing key here rather than an English word on
 *  a French broadcast. */
const WICKET_KEYS: Readonly<Record<string, string>> = {
  bowled: "overlay.moment.wicket.bowled",
  caught: "overlay.moment.wicket.caught",
  lbw: "overlay.moment.wicket.lbw",
  runout: "overlay.moment.wicket.runout",
  stumped: "overlay.moment.wicket.stumped",
  hitwicket: "overlay.moment.wicket.hitwicket",
  retired: "overlay.moment.wicket.retired",
  obstructed: "overlay.moment.wicket.obstructed",
  timedout: "overlay.moment.wicket.timedout",
  hitballtwice: "overlay.moment.wicket.hitballtwice",
};

/**
 * `cricket.ball` and its super-over twin — ONE rule, because the two share one
 * payload schema in the engine (`CRICKET_EVENT_SCHEMAS` points both keys at the
 * same object).
 *
 * The wicket is checked FIRST: a ball can be both a boundary and a dismissal
 * (a catch on the rope), and the dismissal is the moment.
 */
const ball: MomentRule = (ev, { msg }) => {
  const p = ev.payload;
  if (p.wicketKind !== undefined) {
    const key = WICKET_KEYS[p.wicketKind];
    // A kind the engine grew and this table has not: still a dismissal, and
    // still announced — losing the moment entirely would be worse than losing
    // its one-word suffix.
    const kind = key ? msg(key) : undefined;
    const figures = ev.derived?.batter;
    const who = name(ev);
    // The full line only when BOTH halves exist. `kind ?? ""` rendered a
    // trailing "· " for a dismissal kind the table does not yet name, which is
    // exactly the case the fallback above exists to survive gracefully.
    const line =
      who !== undefined && figures !== undefined && kind !== undefined
        ? msg("overlay.moment.batterLine", {
            name: who,
            runs: figures.runs,
            balls: figures.balls,
            kind,
          })
        : who !== undefined && figures !== undefined
          ? `${who} ${figures.runs} (${figures.balls})`
          : (kind ?? who);
    return {
      kind: "wicket",
      headline: msg("overlay.moment.out"),
      ...(line === undefined ? {} : { line }),
      tone: "dismissal",
      seq: ev.seq,
    };
  }
  if (p.boundary === 6 || p.boundary === 4) {
    return {
      kind: p.boundary === 6 ? "six" : "four",
      headline: msg(p.boundary === 6 ? "overlay.moment.six" : "overlay.moment.four"),
      ...(name(ev) === undefined ? {} : { line: name(ev)! }),
      tone: "led",
      seq: ev.seq,
    };
  }
  return null;
};

/**
 * How a goal was scored, where the sport says — ONE table for both families.
 *
 * The two express it differently and neither can be read as the other:
 * football's `FootballGoal` has a boolean `penalty` and NO `kind` at all, while
 * the period kernel's `PeriodGoal` (`sports/period/kernel.ts`) has no `penalty`
 * field and carries a `kind` validated against `cfg.goalKinds`. `recent.ts`
 * already projects both (`kind` and `penalty`), so the mapping is the only
 * thing that was missing — and until it existed a hockey penalty stroke, the
 * exact counterpart of the football penalty the line names, reached air as a
 * bare scorer's name.
 *
 * `"penalty"` is football's boolean, read as a pseudo-kind so the line composes
 * in ONE place. No period sport declares a goal kind of that name, so the two
 * cannot collide.
 *
 * `fg` and `og` are ABSENT BY DESIGN: a plain goal has nothing to add, and an
 * own goal is the HEADLINE (`overlay.moment.ownGoal`), not a suffix. The test
 * holds this table against hockey's and ice hockey's own declared `goalKinds`
 * minus that pair, so a federation sheet growing a kind reds here rather than
 * putting a goal on air with its set piece silently dropped.
 */
export const GOAL_KIND_KEYS: Readonly<Record<string, string>> = {
  penalty: "overlay.moment.goalKind.penalty", // football — `penalty: true`
  stroke: "overlay.moment.goalKind.stroke", // hockey — penalty stroke
  pc: "overlay.moment.goalKind.penaltyCorner", // hockey — penalty corner
  ps: "overlay.moment.goalKind.penaltyShot", // ice hockey — penalty shot
  pp: "overlay.moment.goalKind.powerPlay", // ice hockey — power play
  sh: "overlay.moment.goalKind.shortHanded", // ice hockey — short-handed
};

/**
 * Football's goal and the period kernel's, which the server already projects
 * through one shape.
 *
 * A GOAL NAMES ITS SCORER **AND** SAYS HOW IT WAS SCORED (owner ruling,
 * 2026-09-11, extended to the period sports 2026-09-11). The first build read
 * `penalty` as a REPLACEMENT for the name and put "Penalty" on the line alone —
 * so the one goal a crowd most wants a name against was the only goal that
 * never carried one. Both halves now go on the line together, and each half
 * survives alone for the cases where the other is genuinely missing: a scorer
 * the visibility rules masked away, or a goal the pad recorded with no person
 * at all (`scorer`/`person` are optional in both schemas).
 *
 * ONE COMPOSITION, not one per sport. `overlay.moment.goalKindLine` is a
 * template so a locale can reorder the two halves; a `[label, who].join(" · ")`
 * here would freeze the order in code for every language at once.
 */
const goal: MomentRule = (ev, { msg }) => {
  const who = name(ev);
  const kind = ev.payload.penalty === true ? "penalty" : ev.payload.kind;
  const key = typeof kind === "string" ? GOAL_KIND_KEYS[kind] : undefined;
  const label = key === undefined ? undefined : msg(key);
  const line =
    label === undefined
      ? who
      : who === undefined
        ? label
        : msg("overlay.moment.goalKindLine", { name: who, kind: label });
  return {
    kind: "goal",
    tone: "led",
    seq: ev.seq,
    headline: msg(ev.payload.ownGoal ? "overlay.moment.ownGoal" : "overlay.moment.goal"),
    ...(line === undefined ? {} : { line }),
  };
};

/** ONE table, key and tone together. Two parallel records let a colour exist
 *  in one and not the other — an unreachable state that a guard has to cover
 *  and no test can witness, which is decoration. Here the pair arrives or
 *  neither does.
 *
 *  Tone is a PRODUCT decision, not an engine fact — the engine's nearest
 *  analogue, `permanent`, does not map (ice hockey's `match` is a dismissal on
 *  air and is not permanent). So the tones are declared here, and the test
 *  holds the KEY SET against each module's own declared classes: a federation
 *  sheet adding a class reds rather than rendering it toneless. */
const CARDS: Readonly<Record<string, { key: string; tone: OverlayMoment["tone"] }>> = {
  green: { key: "overlay.moment.card.green", tone: "caution" },
  yellow: { key: "overlay.moment.card.yellow", tone: "caution" },
  red: { key: "overlay.moment.card.red", tone: "dismissal" },
  second_yellow: { key: "overlay.moment.card.secondYellow", tone: "dismissal" },
};

/** Football reads `colour`; the period kernel reads `class`. Same slab. */
const card =
  (field: "colour" | "class"): MomentRule =>
  (ev, { msg }) => {
    const value = ev.payload[field];
    if (value === undefined) return null;
    const card = CARDS[value];
    // A colour or class this table does not name renders NOTHING. Better a
    // missing slab than one whose tone is a guess — tone is the colour of the
    // thing on air.
    if (card === undefined) return null;
    return {
      kind: `card.${value}`,
      headline: msg(card.key),
      ...(name(ev) === undefined ? {} : { line: name(ev)! }),
      tone: card.tone,
      seq: ev.seq,
    };
  };

/** Ice hockey has one headline and seven classes, so the class rides on the
 *  LINE — and through `disciplineLabel`, which is W1's existing resolver for
 *  exactly these words. A second copy of "Bench minor" in four languages is
 *  how the chip and the slab come to disagree. */
const PENALTY_TONE: Readonly<Record<string, OverlayMoment["tone"]>> = {
  minor: "caution",
  bench_minor: "caution",
  double_minor: "caution",
  major: "caution",
  misconduct: "caution",
  game_misconduct: "dismissal",
  match: "dismissal",
};
const penalty: MomentRule = (ev, { msg }) => {
  const cls = ev.payload.class;
  if (cls === undefined) return null;
  const tone = PENALTY_TONE[cls];
  if (tone === undefined) return null;
  const label = disciplineLabel(cls, (key) => msg(key));
  return {
    kind: `penalty.${cls}`,
    headline: msg("overlay.moment.penaltyHeadline"),
    line: [label, name(ev)].filter((part) => part !== undefined).join(" · "),
    tone,
    seq: ev.seq,
  };
};

/** The one tennis point worth a slab on its own. `meta.kind` is the SHOT type,
 *  which the server projects to `payload.kind`. */
const ace: MomentRule = (ev, { msg }) =>
  ev.payload.kind === "ace"
    ? {
        kind: "ace",
        headline: msg("overlay.moment.ace"),
        ...(name(ev) === undefined ? {} : { line: name(ev)! }),
        tone: "led",
        seq: ev.seq,
      }
    : null;

/**
 * Break, set and match point — off the server's engine probe, never re-derived
 * here.
 *
 * `fresh` is the whole guard. A deuce fought out over ten points is ONE match
 * point arriving, not ten slabs.
 */
const pointState: MomentRule = (ev, { msg, sportKey }) => {
  const ps = ev.derived?.pointState;
  if (ps === undefined || !ps.fresh) return null;
  const key =
    ps.kind === "match"
      ? "overlay.moment.matchPoint"
      : ps.kind === "break"
        ? "overlay.moment.breakPoint"
        : GAME_UNIT_SPORTS.has(sportKey)
          ? "overlay.moment.gamePoint"
          : "overlay.moment.setPoint";
  return { kind: `point.${ps.kind}`, headline: msg(key), tone: "led", seq: ev.seq };
};

const setWon: MomentRule = (ev, { msg, sportKey, sides }) => {
  const s = ev.derived?.setWon;
  if (s === undefined) return null;
  const unitIsGame = GAME_UNIT_SPORTS.has(sportKey);
  return {
    kind: "setWon",
    headline: msg(unitIsGame ? "overlay.moment.gameWon" : "overlay.moment.setWon", { n: s.set }),
    line: msg("overlay.moment.setWonLine", {
      short: sides[s.winner],
      home: s.home,
      away: s.away,
    }),
    tone: "led",
    seq: ev.seq,
  };
};

/**
 * sportKey → (engine event type | "derived.setWon" | "derived.pointState") → rule.
 *
 * Volleyball takes the SAME `pointState` probe as the racket sports (owner
 * answer 21 / Q10, 2026-09-06). It is not in `GAME_UNIT_SPORTS`, so it picks
 * SET POINT and SET {n} with no per-sport branch anywhere — which is the whole
 * reason the unit lives in one shared set.
 */
export const MOMENT_RULES: Readonly<Record<string, Readonly<Record<string, MomentRule>>>> = {
  cricket: { "cricket.ball": ball, "cricket.superover.ball": ball },
  football: { "football.goal": goal, "football.card": card("colour") },
  hockey: { "hockey.goal": goal, "hockey.suspension.start": card("class") },
  icehockey: { "icehockey.goal": goal, "icehockey.suspension.start": penalty },
  tennis: {
    "tennis.point": ace,
    "derived.setWon": setWon,
    "derived.pointState": pointState,
  },
  badminton: { "derived.setWon": setWon, "derived.pointState": pointState },
  tabletennis: { "derived.setWon": setWon, "derived.pointState": pointState },
  volleyball: { "derived.setWon": setWon, "derived.pointState": pointState },
  boardgame: {},
  carrom: {},
  generic: {},
};

/** Every dictionary key a rule can emit — the coverage gate's input. */
export const MOMENT_KEYS: readonly string[] = [
  "overlay.moment.six",
  "overlay.moment.four",
  "overlay.moment.out",
  "overlay.moment.batterLine",
  ...Object.values(WICKET_KEYS),
  "overlay.moment.goal",
  "overlay.moment.ownGoal",
  "overlay.moment.goalKindLine",
  ...Object.values(GOAL_KIND_KEYS),
  ...Object.values(CARDS).map((c) => c.key),
  "overlay.moment.penaltyHeadline",
  "overlay.moment.ace",
  "overlay.moment.breakPoint",
  "overlay.moment.setPoint",
  "overlay.moment.gamePoint",
  "overlay.moment.matchPoint",
  "overlay.moment.setWon",
  "overlay.moment.gameWon",
  "overlay.moment.setWonLine",
];

/** The highest sequence a window carries — the stage's mount mark, so OBS
 *  opening mid-stream replays nothing. 0 for an absent or empty window, which
 *  is below every real `seq` (the ledger is 1-based and gapless). */
export function maxSeq(recent: readonly RecentEvent[] | undefined): number {
  let max = 0;
  for (const ev of recent ?? []) if (ev.seq > max) max = ev.seq;
  return max;
}

/**
 * The moments in `recent` newer than `sinceSeq`, oldest first.
 *
 * `sinceSeq` is EXCLUSIVE: the stage passes the highest seq it has already
 * shown, and passing the tip must yield nothing.
 *
 * Order WITHIN one event is recorded fact, then the set it closed, then the
 * point it opened — a set-winning point announces the set before the match
 * point it creates, which is the order a commentator says them in.
 */
export function momentsFor(
  sportKey: string,
  recent: readonly RecentEvent[],
  sinceSeq: number,
  msg: OverlayMsg,
  sides: readonly [string, string],
): OverlayMoment[] {
  const rules = MOMENT_RULES[sportKey];
  if (rules === undefined) return [];
  const ctx = { msg, sportKey, sides };
  const out: OverlayMoment[] = [];
  for (const ev of [...recent].sort((a, b) => a.seq - b.seq)) {
    if (ev.seq <= sinceSeq) continue;
    const candidates = [
      rules[ev.type],
      ev.derived?.setWon === undefined ? undefined : rules["derived.setWon"],
      ev.derived?.pointState === undefined ? undefined : rules["derived.pointState"],
    ];
    for (const rule of candidates) {
      const moment = rule?.(ev, ctx);
      if (moment !== null && moment !== undefined) out.push(moment);
    }
  }
  return out;
}
