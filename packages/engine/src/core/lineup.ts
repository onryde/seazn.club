// S3/W4b (#426) — the kernel-owned squad model: who is on the field, where,
// and what may still happen to them. ONE implementation for all eleven sports.
//
// WHY THIS FILE EXISTS. Before it, every fact below lived inside one module or
// nowhere at all: `squadFromLineup` was football-private and dropped
// `positionKey` one line after reading it, so "who is in goal" was unanswerable
// from any folded state in any sport; `maxSubs` was football-private with a
// single reader; and no family kernel's State held a squad at all. The next
// sport to need a substitution would have written a fourth copy. The grep that
// proves the point is `initSquads|reduceLineupEvent` — nothing under
// `src/sports/**` may re-derive either.
//
// THREE OWNER RULINGS (decision log 2026-08-09) are encoded here, and none of
// them is a hard-coded per-sport branch — all three are cfg knobs on
// `LineupPolicy`, because every one of them differs by variant, not by sport:
//
//  1. A squad MAY grow mid-fixture, gated in cfg, DEFAULT OFF. Only cricket's
//     concussion/COVID replacement genuinely comes from outside the team sheet;
//     football, both hockey codes and volleyball substitute from pre-named
//     benches and keep it off. A grown entry records `provenance: "added"` so a
//     career rollup can tell it from a team-sheet member. The engine RECORDS;
//     registration eligibility stays a competition-layer concern.
//  2. Re-entry is `none | once | unlimited`, plus FIVB's position lock.
//     Football Law 3.3 is no-return (grassroots dispensations ARE rolling), FIH
//     and ice hockey are unlimited, FIVB 15.6 is once AND only back to the
//     position left, cricket lets a retired-hurt batter resume. No global rule
//     is right for more than a third of the sports.
//  3. `role: 'player' | 'coach' | 'staff'`, default `player`. A coach is IN the
//     squad — a card can be shown to him — but never in a playing projection.
//
// THE REDUCER NEVER THROWS. Not on a bad payload, not on a cap, not on a
// forbidden re-entry. A cfg-derived throw inside a fold permanently bricks
// every recorded fixture in the division, because cfg is read live and the
// stream replays on every read (found 6× in W4a). Refusal is a returned value;
// the fold decides what a refusal MEANS, and only on the write path (§3.3).
import { z } from "zod";
import { GameTime } from "./time.ts";
import { EntrantId, LineupSlot, type LineupPair } from "./types.ts";

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

/** Ruling 3. Anything but `player` is in the squad and out of every playing
 *  projection — squad lists, on-field sets, position lookups, stat rollups. */
export const SquadRole = z.enum(["player", "coach", "staff"]);
export type SquadRole = z.infer<typeof SquadRole>;

/** Ruling 1. `named` = on the team sheet at `init`; `added` = admitted
 *  mid-fixture by a lineup event under a variant that permits growth. */
export type SquadProvenance = "named" | "added";

/** Ruling 2. Per sport, per variant — never a constant in a module. */
export type ReentryMode = "none" | "once" | "unlimited";

export interface SquadMember {
  readonly personId: string;
  readonly role: SquadRole;
  readonly provenance: SquadProvenance;
  /** Batting order, board order, team-sheet order — as declared. */
  readonly orderNo: number;
  readonly squadNumber?: number;
  /** Declared order within a pair (1 = first-named). Doubles sports read it in
   *  pass B; carrying it is this pass's job, because nothing downstream can
   *  recover an order the team sheet declared and `init` threw away. */
  readonly pairOrder?: number;
  readonly roles?: readonly string[];
  /**
   * WHERE THIS PERSON IS RIGHT NOW — present only while `onField`. This is the
   * whole point of the file: a keeper is nameable by identity
   * (`personsAtPosition(side, "GK")`) at init and after every change, in every
   * sport, without a module knowing what a keeper is.
   */
  readonly positionKey?: string;
  readonly onField: boolean;
  /** Named in the starting XI/VII/… as opposed to arriving later. */
  readonly started: boolean;
  /** Times this person has LEFT the field (substituted off, retired). */
  readonly timesOff: number;
  /** Times this person has come back after having been off. `timesOn` is the
   *  quantity ruling 2's `once` bounds; `timesOff` is not (a player may be
   *  taken off twice and have returned only once). */
  readonly timesOn: number;
  /** The position held when last leaving the field — FIVB 15.6's lock reads
   *  exactly this, and it must be recorded at the moment of leaving because the
   *  live `positionKey` is gone by then. */
  readonly lastPositionKey?: string;
}

export interface SideSquad {
  readonly entrantId: EntrantId;
  readonly members: readonly SquadMember[];
  /** Substitutions charged against `LineupPolicy.maxSubs`. Exempt replacements
   *  are deliberately NOT here — that separation is the reason the exemption
   *  channel exists at all. */
  readonly subsUsed: number;
  /** Per exemption key: `{ concussion: 1, libero: 4 }`. Countable separately so
   *  a sport can hold a class of replacement outside its cap and still bound
   *  it. */
  readonly exemptUsed: Readonly<Record<string, number>>;
}

export interface SquadState {
  readonly home: SideSquad;
  readonly away: SideSquad;
}

// ---------------------------------------------------------------------------
// The policy — everything a variant may say about lineup changes
// ---------------------------------------------------------------------------

export interface LineupExemption {
  /** Absent = uncapped. `{max: 1}` is cricket's one concussion replacement. */
  readonly max?: number;
  /**
   * The squad role one of the two players MUST carry for this exemption to
   * apply (FIVB 19.3.2.1: `{ libero: { requiresRole: "libero" } }`). Absent
   * keeps the exemption open to any pair — cricket's `concussion` is the
   * shape that needs that, since neither the concussed player nor their
   * replacement carries a "concussion" role.
   *
   * EITHER side satisfies it, deliberately. A libero replacement runs in two
   * directions and both are 19.3.2.1 exchanges: the libero coming ON for a
   * back-row player, and that player coming back ON for the libero. Requiring
   * the role of the incoming player alone would exempt the first and refuse
   * the second.
   *
   * Why this exists: the exemption channel skips the re-entry COUNT refusals,
   * so without a bound an ordinary substitute could be cycled through it
   * indefinitely and FIVB 15.6's "once, and only once" would mean nothing —
   * a pad has only to stamp the key. Found by review on PR #678, after the
   * bypass shipped without it.
   */
  readonly requiresRole?: string;
}

export interface LineupPolicy {
  readonly reentry: ReentryMode;
  /** FIVB 15.6 — a returning player must come back to the position they left. */
  readonly reentryPositionLock: boolean;
  /** Ruling 1 — may a lineup event name a person absent from the team sheet. */
  readonly allowSquadGrowth: boolean;
  /** Ordinary substitutions per side. Absent = uncapped. */
  readonly maxSubs?: number;
  /**
   * The exemption keys this variant honours, each with its own optional cap.
   * A `core.lineup.replacement` naming a key that is NOT declared here is
   * refused — otherwise any pad could evade `maxSubs` by inventing a key, and
   * the cap would mean nothing. Football declares none; cricket declares
   * `concussion`; FIVB declares `libero`.
   */
  readonly exemptions?: Readonly<Record<string, LineupExemption>>;
  /** Honour ANY exemption key, uncapped. The kernel's replay policy sets it;
   *  a sport never should. */
  readonly anyExemption?: boolean;
}

/** What a module that declares no `lineupPolicy` gets: nothing is permitted
 *  that was not already true before this wave — no growth, no return, no
 *  exemption — and no cap, because a cap nobody declared is not the kernel's to
 *  invent. */
export const DEFAULT_LINEUP_POLICY: LineupPolicy = {
  reentry: "none",
  reentryPositionLock: false,
  allowSquadGrowth: false,
};

/**
 * Every knob at its most permissive setting — the policy the fold uses on
 * REPLAY (`strict: false`).
 *
 * The reasoning is §3.3's verbatim: a recorded substitution was legal when it
 * was scored, and an organiser later tightening `maxSubs` or switching a
 * variant from `unlimited` to `none` must not make already-scored fixtures
 * unreadable. Under this policy only STRUCTURAL refusals survive replay (an
 * unknown person, a player taken off who was never on), and the fold treats
 * those as a no-op rather than an error. cfg is not the ledger's to police
 * retroactively.
 */
export const REPLAY_LINEUP_POLICY: LineupPolicy = {
  reentry: "unlimited",
  reentryPositionLock: false,
  allowSquadGrowth: true,
  anyExemption: true,
};

// ---------------------------------------------------------------------------
// The event family — `core.lineup.*`
// ---------------------------------------------------------------------------

// SIBLING TYPES, not one type with a discriminated `kind`. Every consumer in
// the system keys on the exact envelope `type` string — `CORE_EVENT_SCHEMAS`,
// `DURING_STOPPAGE`, `postDecisionTypes`, a module's `padSpec.fidelity`
// keys, the pad's type filters, `EVENT_KEY` — and a `kind` nested
// inside one payload is invisible to all of them, so a sport could not offer
// substitutions at one fidelity tier and position changes at another. It would
// also force a `z.union`, whose first-match-wins silently swallows a sibling
// whose shape is a compatible prefix. Five `z.strictObject`s in the type map
// have neither problem, and `lineup.events.test.ts` proves it with a full
// cross-parse matrix rather than trusting the argument.
//
// `side` is an `EntrantId`, matching `core.forfeit.by` — the payload never says
// "home"/"away", because a payload that names a slot rather than an entrant
// silently attaches to the wrong team the moment sides are read in a different
// order.
//
// `at` is optional on every one of them, exactly as on `core.suspend`: the
// minute a substitution was made is a match-record fact the fold CANNOT derive,
// and the kernel's monotonic guard picks it up for free. Nothing derivable —
// the score, who was on before, the resulting squad — is ever stamped.

/** Off, on, charged to the cap. */
export const LineupSubstitution = z.strictObject({
  side: EntrantId,
  off: z.string().min(1),
  /** A full slot, so a variant that permits growth can name someone new. */
  on: LineupSlot,
  at: GameTime.optional(),
});

/** Off, on, charged to a NAMED EXEMPTION instead of the cap — concussion,
 *  blood, injury, FIVB's libero swap. `exemption` is the key the variant
 *  declares in `LineupPolicy.exemptions`. */
export const LineupReplacement = z.strictObject({
  side: EntrantId,
  off: z.string().min(1),
  on: LineupSlot,
  exemption: z.string().min(1),
  reason: z.string().min(1).optional(),
  at: GameTime.optional(),
});

/** Someone already on the field changes position: an outfield player takes the
 *  gloves after a keeper is sent off, a libero rotates, a fielder moves. */
export const LineupPositionChange = z.strictObject({
  side: EntrantId,
  personId: z.string().min(1),
  positionKey: z.string().min(1),
  at: GameTime.optional(),
});

/** Off with nobody on: retired hurt, a dismissal that leaves a side short. */
export const LineupRetirement = z.strictObject({
  side: EntrantId,
  personId: z.string().min(1),
  reason: z.string().min(1).optional(),
  at: GameTime.optional(),
});

/** On with nobody off: a retired-hurt batter resuming, a side that started a
 *  player short taking the field. Subject to the re-entry knob, charged to
 *  nothing — a side gaining a player is not a substitution. */
export const LineupEntry = z.strictObject({
  side: EntrantId,
  on: LineupSlot,
  at: GameTime.optional(),
});

export const LINEUP_EVENT_SCHEMAS = {
  "core.lineup.substitution": LineupSubstitution,
  "core.lineup.replacement": LineupReplacement,
  "core.lineup.position": LineupPositionChange,
  "core.lineup.retirement": LineupRetirement,
  "core.lineup.entry": LineupEntry,
} as const;

export type LineupEventType = keyof typeof LINEUP_EVENT_SCHEMAS;

/** The payload a given lineup type carries. `parsed.data` off the schema map is
 *  a flat union — TS cannot correlate it with the envelope's `type` string —
 *  so each branch narrows through this rather than re-parsing. */
export type LineupPayloadOf<K extends LineupEventType> = z.infer<(typeof LINEUP_EVENT_SCHEMAS)[K]>;

export function isLineupEventType(type: string): type is LineupEventType {
  return Object.hasOwn(LINEUP_EVENT_SCHEMAS, type);
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

/**
 * Why the codes are split the way they are: the first two are about the EVENT
 * (a malformed or unknown payload — no config edit changes the answer), the
 * next five are STRUCTURAL (incoherent against the squad as folded so far), and
 * the last six are POLICY — every one of them a cfg-derived verdict that the
 * replay policy deliberately cannot reach.
 */
export type LineupRejectionReason =
  | "unknown-lineup-event"
  | "invalid-payload"
  | "unknown-entrant"
  | "unknown-person"
  | "not-on-field"
  | "already-on-field"
  | "not-a-player"
  | "squad-growth-forbidden"
  | "reentry-forbidden"
  | "reentry-limit"
  | "reentry-position"
  | "sub-cap-reached"
  | "exemption-not-declared"
  | "exemption-role-absent"
  | "exemption-cap-reached";

/** The shape the reducer reads — structurally satisfied by an EventEnvelope,
 *  so the fold passes one straight through and this file never imports the
 *  event kernel back. */
export interface LineupEventInput {
  readonly type: string;
  readonly payload: unknown;
}

export type LineupReduceResult =
  | { readonly ok: true; readonly squads: SquadState }
  | { readonly ok: false; readonly reason: LineupRejectionReason; readonly message: string };

// ---------------------------------------------------------------------------
// Selectors — the read side. Every one filters to `role === "player"`
// (ruling 3), so no caller has to remember to.
// ---------------------------------------------------------------------------

export function sideOf(squads: SquadState, entrantId: string): "home" | "away" | null {
  if (squads.home.entrantId === entrantId) return "home";
  if (squads.away.entrantId === entrantId) return "away";
  return null;
}

export function memberOf(side: SideSquad, personId: string): SquadMember | undefined {
  return side.members.find((m) => m.personId === personId);
}

export function playingSquad(side: SideSquad): readonly SquadMember[] {
  return side.members.filter((m) => m.role === "player");
}

export function onFieldPersons(side: SideSquad): readonly string[] {
  return playingSquad(side)
    .filter((m) => m.onField)
    .map((m) => m.personId);
}

/**
 * Who occupies `positionKey` RIGHT NOW, by identity.
 *
 * An array, not a single id, because position maxima are the sport's business
 * (`PositionCatalog` via `resolvePositions`) and most keys hold several people.
 * Derived from `members` rather than stored as an index on purpose: a recorded
 * index and the members it summarises are a recorded-vs-derived pair of the
 * same fact, and those silently disagree (the `DisciplineCard.entrantSide`
 * shape). One source, projected on read.
 */
export function personsAtPosition(side: SideSquad, positionKey: string): readonly string[] {
  return playingSquad(side)
    .filter((m) => m.onField && m.positionKey === positionKey)
    .map((m) => m.personId);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function memberFromSlot(
  slot: LineupSlot,
  provenance: SquadProvenance,
  onField: boolean,
  started: boolean,
): SquadMember {
  return {
    personId: slot.personId,
    role: slot.role ?? "player",
    provenance,
    orderNo: slot.orderNo,
    ...(slot.squadNumber === undefined ? {} : { squadNumber: slot.squadNumber }),
    ...(slot.pairOrder === undefined ? {} : { pairOrder: slot.pairOrder }),
    ...(slot.roles === undefined ? {} : { roles: [...slot.roles] }),
    // A BENCH slot's declared position is a preference, not an occupancy: a
    // substitute keeper on the bench is not in goal. Carrying it would make
    // `personsAtPosition` answer with two keepers from the first event onward,
    // and would let FIVB's lock be satisfied by a position never actually left.
    ...(onField && slot.positionKey !== undefined ? { positionKey: slot.positionKey } : {}),
    onField,
    started,
    timesOff: 0,
    timesOn: 0,
  };
}

function initSide(lineup: LineupPair["home"]): SideSquad {
  return {
    entrantId: lineup.entrantId,
    members: lineup.slots.map((slot) => {
      const onField = slot.slot === "starting";
      return memberFromSlot(slot, "named", onField, onField);
    }),
    subsUsed: 0,
    exemptUsed: {},
  };
}

/** The squad as the team sheets declared it — the state every fold starts from. */
export function initSquads(lineups: LineupPair): SquadState {
  return { home: initSide(lineups.home), away: initSide(lineups.away) };
}

// ---------------------------------------------------------------------------
// reduce
// ---------------------------------------------------------------------------

interface Refusal {
  readonly reason: LineupRejectionReason;
  readonly message: string;
}

type Members = readonly SquadMember[];

const isRefusal = (x: Members | Refusal): x is Refusal => !Array.isArray(x);

const refuse = (reason: LineupRejectionReason, message: string): LineupReduceResult => ({
  ok: false,
  reason,
  message,
});

/** Take a person off the field, remembering where they were (FIVB's lock). */
function takeOff(members: Members, personId: string): Members | Refusal {
  const i = members.findIndex((m) => m.personId === personId);
  const current = members[i];
  if (current === undefined) {
    return { reason: "unknown-person", message: `"${personId}" is not in this squad` };
  }
  if (current.role !== "player") {
    return { reason: "not-a-player", message: `"${personId}" is squad ${current.role}, not a player` };
  }
  if (!current.onField) {
    return { reason: "not-on-field", message: `"${personId}" is not on the field` };
  }
  // The key is DELETED rather than set to undefined: `positionKey` means
  // "where this person is now", and nowhere is the absence of the key.
  const { positionKey, ...rest } = current;
  const next: SquadMember = {
    ...rest,
    onField: false,
    timesOff: current.timesOff + 1,
    ...(positionKey === undefined ? {} : { lastPositionKey: positionKey }),
  };
  return members.map((m, j) => (j === i ? next : m));
}

/**
 * Put a person on the field — the only place ruling 1 and ruling 2 bite.
 *
 * `exemptReplacement` is true ONLY for the `on` half of a
 * `core.lineup.replacement` that named a declared exemption (FIVB 19.3.2.1's
 * libero, cricket/football's concussion swap). `reentry` bounds the ordinary
 * SUBSTITUTION allowance (FIVB 15.6); a replacement carrying an exemption is
 * by definition not a substitution, so the two COUNT refusals below
 * (`reentry-forbidden`, `reentry-limit`) do not apply to it — each exemption
 * is bounded instead by its own `LineupPolicy.exemptions[key].max`, already
 * enforced by the caller before this function runs. `reentryPositionLock` is
 * NOT part of that allowance — FIVB 15.6's lock applies to a libero exactly
 * as it does to an ordinary substitute — so it stays live regardless of this
 * flag.
 */
function bringOn(
  members: Members,
  slot: LineupSlot,
  policy: LineupPolicy,
  exemptReplacement = false,
): Members | Refusal {
  const i = members.findIndex((m) => m.personId === slot.personId);
  const current = members[i];

  if (current === undefined) {
    // RULING 1 — growth. Default off, and the refusal is cfg-derived, so replay
    // never sees it.
    if (!policy.allowSquadGrowth) {
      return {
        reason: "squad-growth-forbidden",
        message: `"${slot.personId}" is not on the team sheet and this variant does not permit a mid-fixture addition`,
      };
    }
    if ((slot.role ?? "player") !== "player") {
      return { reason: "not-a-player", message: `"${slot.personId}" is not added as a player` };
    }
    return [...members, memberFromSlot(slot, "added", true, false)];
  }

  if (current.role !== "player") {
    return {
      reason: "not-a-player",
      message: `"${slot.personId}" is squad ${current.role} and cannot take the field`,
    };
  }
  if (current.onField) {
    return { reason: "already-on-field", message: `"${slot.personId}" is already on the field` };
  }

  // RULING 2 — a return, and only a return. Someone who has never left (a
  // starting bench player coming on for the first time, a person just added) is
  // not re-entering and must not be measured against this knob.
  if (current.timesOff > 0) {
    // The two COUNT refusals ARE the substitution allowance (FIVB 15.6) and
    // do not bind an exempt replacement (19.3.2.1) — see the doc comment
    // above. The position lock a few lines down is NOT skipped.
    if (!exemptReplacement) {
      if (policy.reentry === "none") {
        return {
          reason: "reentry-forbidden",
          message: `"${slot.personId}" has left the field and this variant does not permit a return`,
        };
      }
      if (policy.reentry === "once" && current.timesOn >= 1) {
        return {
          reason: "reentry-limit",
          message: `"${slot.personId}" has already returned once and this variant permits no more`,
        };
      }
    }
    if (
      policy.reentryPositionLock &&
      current.lastPositionKey !== undefined &&
      slot.positionKey !== current.lastPositionKey
    ) {
      return {
        reason: "reentry-position",
        message: `"${slot.personId}" must return to ${current.lastPositionKey}, not ${slot.positionKey ?? "an unstated position"}`,
      };
    }
  }

  const next: SquadMember = {
    ...current,
    onField: true,
    ...(current.timesOff > 0 ? { timesOn: current.timesOn + 1 } : {}),
    ...(slot.positionKey === undefined ? {} : { positionKey: slot.positionKey }),
    // ROLES are recorded here for the same reason `positionKey` is, and by
    // the same rule as `memberFromSlot`: the event states a fact about this
    // person, and dropping it loses information the fold cannot recover.
    //
    // It became load-bearing with `LineupExemption.requiresRole`. A libero
    // whose role is declared on the replacement that brings them ON — rather
    // than on the team sheet — never carried it on the member, so the RETURN
    // leg of that same exchange found no libero on either side and was
    // refused `exemption-role-absent`. Half of normal play, broken by a
    // silent omission. Absent `roles` still changes nothing, so a member's
    // existing roles survive an event that does not mention them.
    ...(slot.roles === undefined ? {} : { roles: [...slot.roles] }),
  };
  return members.map((m, j) => (j === i ? next : m));
}

function moveTo(members: Members, personId: string, positionKey: string): Members | Refusal {
  const i = members.findIndex((m) => m.personId === personId);
  const current = members[i];
  if (current === undefined) {
    return { reason: "unknown-person", message: `"${personId}" is not in this squad` };
  }
  if (current.role !== "player") {
    return { reason: "not-a-player", message: `"${personId}" is squad ${current.role}` };
  }
  if (!current.onField) {
    return { reason: "not-on-field", message: `"${personId}" is not on the field` };
  }
  return members.map((m, j) => (j === i ? { ...m, positionKey } : m));
}

/**
 * Fold one `core.lineup.*` event into the squads.
 *
 * PURE, TOTAL, AND NEVER THROWING — see the file header. Every refusal is a
 * value, and the caller (the fold kernel) decides whether it is an error, which
 * it only ever is on the write path.
 */
export function reduceLineupEvent(
  squads: SquadState,
  event: LineupEventInput,
  policy: LineupPolicy,
): LineupReduceResult {
  if (!isLineupEventType(event.type)) {
    return refuse("unknown-lineup-event", `"${event.type}" is not a lineup event`);
  }
  const parsed = LINEUP_EVENT_SCHEMAS[event.type].safeParse(event.payload);
  if (!parsed.success) {
    return refuse("invalid-payload", `invalid ${event.type} payload`);
  }
  const payload = parsed.data;
  const key = sideOf(squads, payload.side);
  if (key === null) {
    return refuse("unknown-entrant", `"${payload.side}" is neither side of this fixture`);
  }
  const side = squads[key];

  // Counting first: it reads only the side totals, mutates nothing, and its
  // verdict does not depend on the swap succeeding.
  let subsUsed = side.subsUsed;
  let exemptUsed = side.exemptUsed;
  if (event.type === "core.lineup.substitution") {
    if (policy.maxSubs !== undefined && subsUsed >= policy.maxSubs) {
      return refuse(
        "sub-cap-reached",
        `this side has used all ${policy.maxSubs} substitutions this variant allows`,
      );
    }
    subsUsed += 1;
  }
  if (event.type === "core.lineup.replacement") {
    const exemption = (payload as z.infer<typeof LineupReplacement>).exemption;
    const declared = policy.exemptions?.[exemption];
    if (policy.anyExemption !== true) {
      if (declared === undefined) {
        return refuse(
          "exemption-not-declared",
          `this variant does not recognise the "${exemption}" replacement exemption`,
        );
      }
      const used = exemptUsed[exemption] ?? 0;
      if (declared.max !== undefined && used >= declared.max) {
        return refuse(
          "exemption-cap-reached",
          `this side has used all ${declared.max} "${exemption}" replacements`,
        );
      }
      // The exemption must be EARNED, not merely claimed. Without this a pad
      // stamps the key on any pair and the channel launders an ordinary
      // substitution past FIVB 15.6's re-entry cap — the exemption skips the
      // COUNT refusals, so an unbounded key makes "once, and only once" mean
      // nothing at all. (Review, PR #678: reproduced against this engine —
      // an ordinary player who had already used their one return was accepted
      // for a second through `exemption: "libero"`.)
      //
      // EITHER player satisfies it: a libero replacement runs both ways, and
      // the return leg brings an ORDINARY player on for the libero.
      if (declared.requiresRole !== undefined) {
        const replacement = payload as z.infer<typeof LineupReplacement>;
        const offRoles = side.members.find((m) => m.personId === replacement.off)?.roles ?? [];
        const onExisting = side.members.find((m) => m.personId === replacement.on.personId)?.roles ?? [];
        const onDeclared = replacement.on.roles ?? [];
        const carried =
          offRoles.includes(declared.requiresRole) ||
          onExisting.includes(declared.requiresRole) ||
          onDeclared.includes(declared.requiresRole);
        if (!carried) {
          return refuse(
            "exemption-role-absent",
            `a "${exemption}" replacement needs one of the two players to be ${declared.requiresRole}`,
          );
        }
      }
    }
    exemptUsed = { ...exemptUsed, [exemption]: (exemptUsed[exemption] ?? 0) + 1 };
  }

  // Then the swap. Off before on, so a player may be replaced by the very
  // person whose place they take in the same event without a false
  // `already-on-field`.
  let members: Members = side.members;
  // Switched on the ENVELOPE TYPE rather than on the presence of a payload key.
  // `parsed.data` is a plain union here, so `"off" in payload` narrows to
  // `unknown` for the branches that lack the key — the type is only sound
  // because the type string already told us which schema produced it.
  if (event.type === "core.lineup.substitution" || event.type === "core.lineup.replacement") {
    const swap = payload as LineupPayloadOf<
      "core.lineup.substitution" | "core.lineup.replacement"
    >;
    const afterOff = takeOff(members, swap.off);
    if (isRefusal(afterOff)) return refuse(afterOff.reason, afterOff.message);
    // Exempt ONLY for a replacement — see `bringOn`'s doc comment. An
    // ordinary substitution still measures fully against `policy.reentry`.
    const afterOn = bringOn(afterOff, swap.on, policy, event.type === "core.lineup.replacement");
    if (isRefusal(afterOn)) return refuse(afterOn.reason, afterOn.message);
    members = afterOn;
  } else if (event.type === "core.lineup.entry") {
    const afterOn = bringOn(members, (payload as z.infer<typeof LineupEntry>).on, policy);
    if (isRefusal(afterOn)) return refuse(afterOn.reason, afterOn.message);
    members = afterOn;
  } else if (event.type === "core.lineup.retirement") {
    const afterOff = takeOff(members, (payload as z.infer<typeof LineupRetirement>).personId);
    if (isRefusal(afterOff)) return refuse(afterOff.reason, afterOff.message);
    members = afterOff;
  } else {
    const move = payload as z.infer<typeof LineupPositionChange>;
    const moved = moveTo(members, move.personId, move.positionKey);
    if (isRefusal(moved)) return refuse(moved.reason, moved.message);
    members = moved;
  }

  const nextSide: SideSquad = { entrantId: side.entrantId, members, subsUsed, exemptUsed };
  return {
    ok: true,
    squads: key === "home" ? { home: nextSide, away: squads.away } : { home: squads.home, away: nextSide },
  };
}
