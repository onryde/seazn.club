import "server-only";
// Player discipline & suspensions (SPEC-1 / PROMPT-78): the read-side fold over
// the score-event ledger. Card events (football.card, {hockey,icehockey}.
// suspension.start) are projected by the sport module's discipline descriptor,
// accumulated per person against configurable thresholds, and raised as
// *pending* suspensions the organiser confirms/waives/adjusts. Everything is
// recompute-on-read (the `suspensions` table IS the snapshot) + a hook on the
// scoring decided/void seam. Idempotent under the partial unique index
// (suspensions_auto_once), never via application-side pre-checks. Zero engine
// reducer/replay/golden change (D2).
import type postgres from "postgres";
import type { DisciplineModel, EventEnvelope } from "@seazn/engine/core";
import { parseRoundRoleKey, roundRoleKey } from "@seazn/engine/competition";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";
import { msgFor } from "@/lib/messages-i18n";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasFeature, requireFeature } from "@/lib/entitlements";
import { resolvePersonDisplayName } from "@/lib/name-display";
import { suspensionConfirmedEmail, suspensionServedEmail } from "@/lib/email";
import { dispatchNow, enqueueEmailOnce, expiryWithin, onceKey, recipientLocale } from "@/server/email-outbox";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveModule } from "@/server/engine-db";
import { suspendedPlayersMessage } from "@/lib/registration-rules";
import { SUSPENSION_NO_ENTRANT_CODE } from "@/lib/suspension-no-entrant";
import { deferred } from "@/lib/deferred";
import { audit } from "./audit";

type Tx = postgres.TransactionSql;

// The key is spelled out at every gate below, deliberately, and the module-local
// constant it replaces is NOT coming back. `discipline.enforced` is
// Event-Pass-lifted (V393), and lib/__tests__/pass-scoping-guard.test.ts finds
// an unscoped gate by matching a string LITERAL in the resolver's second
// argument — an identifier is invisible to it. Six gates in this file therefore
// resolved org-wide for a whole wave with that guard green.

export type SuspensionStatus = "pending" | "active" | "served" | "waived";
export type SuspensionSource = "auto_accumulation" | "auto_dismissal" | "manual" | "report";

export interface DisciplineRules {
  accumulation: {
    key: string;
    color: string;
    count: number;
    ban_matches: number;
    // S4 (#428) — scope the rule to ONE DisciplineCard.reason ("three cards
    // for dissent"), not just the colour. Omitted ⇒ every card of the colour
    // is eligible, exactly the pre-#428 behaviour — every existing rules
    // document in the DB parses and fires identically with this absent.
    reason?: string;
  }[];
  dismissal: { key: string; color: string; ban_matches: number }[];
}

export interface Suspension {
  id: string;
  divisionId: string;
  personId: string;
  personName: string;
  entrantId: string | null;
  entrantName: string | null;
  status: SuspensionStatus;
  source: SuspensionSource;
  reason: string;
  matchesTotal: number;
  matchesServed: number;
  fixtureId: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** true when a trigger event is now voided (the console shows a hint chip;
   *  the row itself is never auto-deleted once decided). */
  triggerVoided: boolean;
  /** The matches this ban still covers, in the order they will be missed (`coveredMatches` below): for an ACTIVE ban
   *  the next `matchesTotal - matchesServed`, for a PENDING one the next `matchesTotal` were it confirmed now. Empty
   *  for a served or waived ban, and for a pending one whose player is on no entrant here (confirm refuses it). */
  coveredMatches: CoveredMatch[];
}

/** One match a ban covers. `fixtureId` null is a PLACEHOLDER: the team has fewer fixtures left to play than the ban
 *  has matches to run, so it covers a match that does not exist yet ("Next match (not scheduled yet)"). */
export interface CoveredMatch {
  fixtureId: string | null;
  /** `roundRoleKey()` of the fixture's round within its OWN stage ("plain_round_4", "semi_final") — language-free, so a
   *  surface renders it through `roundRoleLabel` in its reader's language. Null for a placeholder. */
  roundRole: string | null;
  /** The other side's entrant name; null while that seat is undecided (TBD), and for a placeholder. */
  opponentName: string | null;
  /** ISO instant, or null when the fixture has no time yet. */
  scheduledAt: string | null;
}

// Sport defaults prefilled in the rules editor on first open (editable). Kept
// in the usecase — the engine descriptor supplies only the offerable colours.
const SPORT_DEFAULT_RULES: Record<string, DisciplineRules> = {
  football: {
    accumulation: [
      { key: "yellow_5", color: "yellow", count: 5, ban_matches: 1 },
      { key: "yellow_10", color: "yellow", count: 10, ban_matches: 2 },
    ],
    dismissal: [
      { key: "second_yellow", color: "second_yellow", ban_matches: 1 },
      { key: "red", color: "red", ban_matches: 1 },
    ],
  },
  // Field hockey / ice hockey: dismissal-only (red / match penalty → 1 match).
  hockey: { accumulation: [], dismissal: [{ key: "red", color: "red", ban_matches: 1 }] },
  icehockey: {
    accumulation: [],
    dismissal: [
      { key: "game_misconduct", color: "game_misconduct", ban_matches: 1 },
      { key: "match", color: "match", ban_matches: 1 },
    ],
  },
};

/** The competition an Event-Pass-lifted gate must be resolved against.
 *
 *  lib/entitlements.ts consults `competition_passes` only when a competition is
 *  in scope, so a gate on `discipline.enforced` that omits it makes the pass
 *  INVISIBLE — the org pays for one competition and is refused on it. Same
 *  shape as usecases/officials.ts's `competitionForDivision` (T6).
 *
 *  Pooled `sql`, and deliberately OUTSIDE any tenant transaction: `resolve`
 *  queries the pooled proxy, and issuing that from inside a pinned tenant
 *  transaction asks the pool for a second connection while the first is still
 *  held — the self-deadlock lib/db.ts guards against.
 *
 *  A missing row yields `undefined`, which resolves the gate org-wide (the
 *  pre-V393 behaviour) and the 404 is raised inside the transaction as before. */
async function competitionForDivision(divisionId: string): Promise<string | undefined> {
  const [row] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  return row?.competition_id;
}

/** As above, one hop further out: suspensions -> divisions -> competition.
 *  `decideSuspension` is handed a suspension id and nothing else. Unscoped by
 *  org on purpose — the pass overlay itself joins on `cp.org_id = orgId`, so a
 *  foreign competition id grants nothing, and the row's real tenancy check is
 *  the 404 raised inside `withTenant`. */
async function competitionForSuspension(suspensionId: string): Promise<string | undefined> {
  const [row] = await sql<{ competition_id: string }[]>`
    select d.competition_id from suspensions s
    join divisions d on d.id = s.division_id
    where s.id = ${suspensionId}`;
  return row?.competition_id;
}

function defaultRules(sportKey: string): DisciplineRules {
  return SPORT_DEFAULT_RULES[sportKey] ?? { accumulation: [], dismissal: [] };
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

// ---------------------------------------------------------------------------
// The fold + detection + serving (recompute-on-read; idempotent).
// ---------------------------------------------------------------------------

interface EventRow {
  fixture_id: string;
  id: string;
  seq: number;
  type: string;
  payload: unknown;
  recorded_at: Date;
  voids_event_id: string | null;
}

interface ExtractedCard {
  personId?: string;
  color: string;
  eventId: string;
  recordedAt: Date;
  seq: number;
  fixtureId: string;
  // S4 (#428) — carried through so an accumulation rule can scope to it.
  reason?: string;
}

interface WantRow {
  personId: string;
  source: "auto_accumulation" | "auto_dismissal";
  ruleKey: string;
  bucket: number;
  reason: string;
  matchesTotal: number;
  triggerEventIds: string[];
  fixtureId: string;
}

/** Recompute-on-read fold + detection + serving. Idempotent. Safe on divisions
 *  with no rules row and no active suspensions (no-op).
 *
 *  Returns the ids of the bans THIS pass flipped active→served. Each one's
 *  "served" notice is already queued on `tx` (`updateServing`), so it commits
 *  or rolls back with the flip, and the retry worker sends it: callers have
 *  nothing to do after their transaction. */
export async function detectSuspensions(tx: Tx, divisionId: string): Promise<string[]> {
  const [rules] = await tx<
    { org_id: string; enabled: boolean; rules: DisciplineRules; sport_key: string; module_version: string }[]
  >`
    select dr.org_id, dr.enabled, dr.rules, d.sport_key, d.module_version
    from discipline_rules dr join divisions d on d.id = dr.division_id
    where dr.division_id = ${divisionId}`;
  const enabled = rules?.enabled ?? false;
  if (!enabled) {
    // No auto-detection to run; only touch the DB further if there is an active
    // ban whose serving counter might need advancing (manual bans included).
    const [active] = await tx`
      select 1 from suspensions where division_id = ${divisionId} and status = 'active' limit 1`;
    if (!active) return [];
  }

  // Ledger — the recomputePlayerStats query, per fixture, void-aware.
  const events = await tx<EventRow[]>`
    select se.fixture_id, se.id, se.seq, se.type, se.payload, se.recorded_at, se.voids_event_id
    from score_events se join fixtures f on f.id = se.fixture_id
    where f.division_id = ${divisionId}
    order by se.fixture_id, se.seq`;

  if (enabled) {
    const model = resolveModule(rules!.sport_key, rules!.module_version).discipline;
    if (model) await detect(tx, divisionId, rules!.org_id, rules!.rules, model, events);
  }
  return updateServing(tx, divisionId, events);
}

async function detect(
  tx: Tx,
  divisionId: string,
  orgId: string,
  rules: DisciplineRules,
  model: DisciplineModel,
  events: EventRow[],
): Promise<void> {
  const byFixture = new Map<string, EventEnvelope[]>();
  const meta = new Map<string, { recordedAt: Date; seq: number; fixtureId: string }>();
  for (const e of events) {
    meta.set(e.id, { recordedAt: e.recorded_at, seq: e.seq, fixtureId: e.fixture_id });
    const env = {
      id: e.id,
      fixtureId: e.fixture_id,
      seq: e.seq,
      type: e.type,
      payload: e.payload,
      recordedAt: e.recorded_at.toISOString(),
      recordedBy: null,
      ...(e.voids_event_id !== null ? { voids: e.voids_event_id } : {}),
    } as EventEnvelope;
    (byFixture.get(e.fixture_id) ?? byFixture.set(e.fixture_id, []).get(e.fixture_id)!).push(env);
  }

  const cards: ExtractedCard[] = [];
  for (const ledger of byFixture.values()) {
    for (const c of model.extractCards(ledger)) {
      const m = meta.get(c.eventId);
      if (!m) continue;
      cards.push({
        ...(c.personId !== undefined ? { personId: c.personId } : {}),
        color: c.color,
        eventId: c.eventId,
        recordedAt: m.recordedAt,
        seq: m.seq,
        fixtureId: m.fixtureId,
        ...(c.reason !== undefined ? { reason: c.reason } : {}),
      });
    }
  }
  // Anonymous cards accumulate nothing (SPEC-1). Global chronological order
  // drives bucket assignment and the trigger audit trail.
  const attributed = cards
    .filter((c): c is ExtractedCard & { personId: string } => c.personId !== undefined)
    .sort(
      (a, b) =>
        a.recordedAt.getTime() - b.recordedAt.getTime() ||
        a.fixtureId.localeCompare(b.fixtureId) ||
        a.seq - b.seq,
    );

  const colorLabel = new Map(model.colors.map((c) => [c.key, c.label]));
  const wants: WantRow[] = [];

  // Accumulation — per colour, rules sorted by count asc; bucket = its rank.
  const byColor = new Map<string, DisciplineRules["accumulation"]>();
  for (const r of rules.accumulation ?? []) {
    (byColor.get(r.color) ?? byColor.set(r.color, []).get(r.color)!).push(r);
  }
  for (const [color, colorRules] of byColor) {
    const sorted = [...colorRules].sort((a, b) => a.count - b.count);
    const byPerson = groupByPerson(attributed.filter((c) => c.color === color));
    for (const [personId, personCards] of byPerson) {
      sorted.forEach((rule, idx) => {
        // S4 (#428) — "three cards for the same offence": a rule scoped to a
        // `reason` counts only cards carrying THAT reason, not every card of
        // the colour. Unscoped (the pre-#428 shape, still the common case)
        // keeps every card of the colour eligible.
        const eligible =
          rule.reason === undefined ? personCards : personCards.filter((c) => c.reason === rule.reason);
        if (eligible.length < rule.count) return;
        const trigger = eligible.slice(0, rule.count);
        wants.push({
          personId,
          source: "auto_accumulation",
          ruleKey: rule.key,
          bucket: idx + 1,
          reason:
            `${ordinal(rule.count)} ${(colorLabel.get(color) ?? color).toLowerCase()}` +
            (rule.reason === undefined ? "" : ` (${rule.reason})`),
          matchesTotal: rule.ban_matches,
          triggerEventIds: trigger.map((c) => c.eventId),
          fixtureId: trigger[trigger.length - 1]!.fixtureId,
        });
      });
    }
  }

  // Dismissal — each matching card is one incident; bucket = its Nth occurrence.
  for (const rule of rules.dismissal ?? []) {
    const byPerson = groupByPerson(attributed.filter((c) => c.color === rule.color));
    for (const [personId, personCards] of byPerson) {
      personCards.forEach((card, i) => {
        wants.push({
          personId,
          source: "auto_dismissal",
          ruleKey: rule.key,
          bucket: i + 1,
          reason: colorLabel.get(rule.color) ?? rule.color,
          matchesTotal: rule.ban_matches,
          triggerEventIds: [card.eventId],
          fixtureId: card.fixtureId,
        });
      });
    }
  }

  // Insert wanted rows; the partial unique index makes this idempotent.
  for (const w of wants) {
    await tx`
      insert into suspensions
        (org_id, division_id, person_id, status, source, rule_key, bucket, reason,
         matches_total, trigger_event_ids, fixture_id)
      values (${orgId}, ${divisionId}, ${w.personId}, 'pending', ${w.source}, ${w.ruleKey},
              ${w.bucket}, ${w.reason}, ${w.matchesTotal}, ${w.triggerEventIds}, ${w.fixtureId})
      on conflict do nothing`;
  }

  // Delete PENDING auto rows whose trigger no longer holds (voided card dropped
  // the total below the threshold). Confirmed rows are the organiser's.
  const wantKeys = new Set(wants.map((w) => `${w.personId}|${w.ruleKey}|${w.bucket}`));
  const pendingAuto = await tx<{ id: string; person_id: string; rule_key: string; bucket: number }[]>`
    select id, person_id, rule_key, bucket from suspensions
    where division_id = ${divisionId} and status = 'pending'
      and source in ('auto_accumulation', 'auto_dismissal')`;
  for (const row of pendingAuto) {
    if (!wantKeys.has(`${row.person_id}|${row.rule_key}|${row.bucket}`)) {
      await tx`delete from suspensions where id = ${row.id}`;
    }
  }
}

function groupByPerson<T extends { personId: string }>(cards: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const c of cards) (map.get(c.personId) ?? map.set(c.personId, []).get(c.personId)!).push(c);
  return map;
}

// Serving — matches_served is derived, stored and monotonic (SPEC-1). No lineup
// entity exists, so a match is "served" per decided/finalized fixture of the
// suspended entrant that STARTED after the ban's decided_at — a fixture's start
// is its EARLIEST recorded event — and that is not the ban's own trigger
// fixture (`suspensions.fixture_id`). A match already under way when the ban
// was confirmed never serves it, however late it is decided or finalized; so a
// red confirmed mid-match is not served by that match being played out, nor a
// red confirmed after full time by a `core.finalize` on it (2026-10-27 fix: the
// rule used to read the LATEST event, which both of those moved past the
// confirm). A forfeit BY the suspended entrant counts, and so does a double
// walkover (owner ruling 126, 2026-10-13: `by: "both"` includes her — read off
// the stored outcome, so the legacy chess `boardgame.result{double_forfeit}`,
// which carries no core.forfeit, counts too); abandoned/cancelled and forfeits
// by anyone else never do. A fixture with no recorded event has not started
// and serves nothing.
//
// The rule lives ONCE, in `servingVerdict` below: this counter takes its
// "served" answers, and the "which matches does this ban cover" projection
// (`coveredMatches`) takes its "upcoming" ones — so the line a person reads
// ("Misses: Round 4 vs Rovers") and the counter that ends the ban cannot
// disagree about which match is which.

/** The two facts the serving rule reads off a fixture's ledger. */
export interface LedgerFacts {
  /** A fixture's START: its EARLIEST recorded event. Absent = never started. */
  startedAt: Map<string, Date>;
  /** Who a `core.forfeit` was recorded against (the last one, in ledger order). */
  forfeitBy: Map<string, string>;
}

/** `events` in ledger order (fixture, seq) — the serving pass's own read, or the projection's narrower one. */
export function ledgerFacts(
  events: readonly Pick<EventRow, "fixture_id" | "recorded_at" | "type" | "payload">[],
): LedgerFacts {
  const startedAt = new Map<string, Date>();
  const forfeitBy = new Map<string, string>();
  for (const e of events) {
    const cur = startedAt.get(e.fixture_id);
    if (!cur || e.recorded_at < cur) startedAt.set(e.fixture_id, e.recorded_at);
    if (e.type === "core.forfeit") {
      const by = (e.payload as { by?: string } | null)?.by;
      if (typeof by === "string") forfeitBy.set(e.fixture_id, by);
    }
  }
  return { startedAt, forfeitBy };
}

/** The fixture fields the serving rule reads. */
export interface ServingFixture {
  id: string;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: { kind?: string } | null;
}

/** A fixture that can still be played to a result: not yet started, under way, or held for the organiser's settle.
 *  Every other status (`decided`, `finalized`, `forfeited`, `abandoned`, `cancelled`) is terminal. */
const OPEN_FIXTURE_STATUSES: ReadonlySet<string> = new Set(["scheduled", "in_play", "needs_decision"]);

/**
 * One fixture's standing against one ban — the serving rule, the ONE copy of it.
 *
 *  - `served`: it counts toward the ban (`updateServing`).
 *  - `upcoming`: it will count once it is played — the ban covers it (`coveredMatches`). A match not yet started, or
 *    one that started AFTER the ban did and is still under way.
 *  - `never`: it can never count: another entrant's match, the ban's own trigger fixture, a match already under way
 *    when the ban began, or one that ended without serving (abandoned, cancelled, a forfeit by the other side, a bye).
 *
 * `ban.since` is the ban's `decided_at`; a PENDING ban is projected as if confirmed at `since` = now.
 */
export function servingVerdict(
  f: ServingFixture,
  ban: { entrantId: string; fixtureId: string | null; since: Date },
  facts: LedgerFacts,
): "served" | "upcoming" | "never" {
  if (f.home_entrant_id !== ban.entrantId && f.away_entrant_id !== ban.entrantId) return "never";
  if (f.id === ban.fixtureId) return "never";
  const began = facts.startedAt.get(f.id);
  if (began !== undefined && began <= ban.since) return "never";
  if (OPEN_FIXTURE_STATUSES.has(f.status)) return "upcoming";
  if (began === undefined) return "never";
  if (f.status === "decided" || f.status === "finalized") return "served";
  if (f.status === "forfeited" && (facts.forfeitBy.get(f.id) === ban.entrantId || f.outcome?.kind === "double_walkover")) {
    return "served";
  }
  return "never";
}

async function updateServing(tx: Tx, divisionId: string, events: EventRow[]): Promise<string[]> {
  const active = await tx<
    { id: string; entrant_id: string | null; decided_at: Date | null; matches_total: number; fixture_id: string | null }[]
  >`
    select id, entrant_id, decided_at, matches_total, fixture_id from suspensions
    where division_id = ${divisionId} and status = 'active'`;
  if (active.length === 0) return [];

  const fixtures = await tx<ServingFixture[]>`
    select id, status, home_entrant_id, away_entrant_id, outcome from fixtures where division_id = ${divisionId}`;
  const facts = ledgerFacts(events);

  const flipped: string[] = [];
  for (const s of active) {
    if (!s.entrant_id || !s.decided_at) continue;
    const ban = { entrantId: s.entrant_id, fixtureId: s.fixture_id, since: s.decided_at };
    const served = fixtures.filter((f) => servingVerdict(f, ban, facts) === "served").length;
    const capped = Math.min(served, s.matches_total);
    const status = capped >= s.matches_total ? "served" : "active";
    // `and status = 'active'`: the read above takes no lock, so two passes
    // (a decided score write and a division page read, or two decided writes)
    // can both see this ban active and both compute "served". The second
    // UPDATE waits on the first's row lock, then re-checks the WHERE against
    // the committed row — no longer active — and matches nothing. So only the
    // statement that actually flipped the row reports it, and queues its notice.
    const updated = await tx<{ id: string }[]>`
      update suspensions set matches_served = ${capped}, status = ${status}, updated_at = now()
      where id = ${s.id} and status = 'active'
      returning id`;
    if (status === "served" && updated.length > 0) {
      // The player's notice, queued with the flip: it exists exactly when the flip committed (R1), which is what the
      // after-commit `xmin` check used to stand in for (spec §8). The once-key backs it.
      await queueSuspensionServed(tx, s.id);
      flipped.push(s.id);
    }
  }
  return flipped;
}

/**
 * Queue the "suspension served" notice for the ban `suspensionId` on the email outbox, on `tx` (the serving pass's tenant
 * transaction, which may be a read's): to the claimed player's ACCOUNT, in their language (D4: the account's, then the org's
 * default, then `en`), at most once per ban (once-key `<id>:served`). The retry worker makes the first attempt: a serving
 * pass has no request of its own to send from. Returns the row's id, or `null` when there is nobody to address (the person
 * is not linked to a live account) or the ban's notice is already queued. Every read is on `tx` (#996).
 */
export async function queueSuspensionServed(tx: Tx, suspensionId: string): Promise<string | null> {
  const [r] = await tx<
    {
      org_id: string;
      user_id: string;
      email: string | null;
      org_name: string;
      default_locale: string | null;
      division_name: string;
      reason: string;
    }[]
  >`
    select s.org_id, u.id as user_id, u.email, o.name as org_name, o.default_locale, d.name as division_name, s.reason
    from suspensions s
    join persons p on p.id = s.person_id
    join users u on u.id = p.user_id and u.deleted_at is null
    join divisions d on d.id = s.division_id
    join organizations o on o.id = s.org_id
    where s.id = ${suspensionId}`;
  if (!r?.email) return null;
  const locale = await recipientLocale(tx, { pick: null, userId: r.user_id, orgDefault: r.default_locale });
  const content = await suspensionServedEmail({ orgName: r.org_name, divisionName: r.division_name, reason: r.reason }, locale);
  return enqueueEmailOnce(tx, {
    kind: "suspension_served",
    refType: "suspension",
    refId: suspensionId,
    dedupeKey: onceKey("suspension_served", "suspension", suspensionId, "served"),
    orgId: r.org_id,
    to: r.email,
    recipientUserId: r.user_id,
    ...content,
    transactional: true,
    expiresAt: expiryWithin(null),
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface SuspensionRow {
  id: string;
  division_id: string;
  person_id: string;
  person_name: string;
  entrant_id: string | null;
  entrant_name: string | null;
  status: SuspensionStatus;
  source: SuspensionSource;
  reason: string;
  matches_total: number;
  matches_served: number;
  fixture_id: string | null;
  trigger_event_ids: string[] | null;
  created_at: Date;
  decided_at: Date | null;
}

function mapRow(row: SuspensionRow, voided: Set<string>, covered: Map<string, CoveredMatch[]>): Suspension {
  return {
    id: row.id,
    divisionId: row.division_id,
    personId: row.person_id,
    personName: row.person_name,
    entrantId: row.entrant_id,
    entrantName: row.entrant_name,
    status: row.status,
    source: row.source,
    reason: row.reason,
    matchesTotal: row.matches_total,
    matchesServed: row.matches_served,
    fixtureId: row.fixture_id,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    triggerVoided: (row.trigger_event_ids ?? []).some((id) => voided.has(id)),
    coveredMatches: covered.get(row.id) ?? [],
  };
}

/** The serving entrant for a ban: the one stamped on it, else the person's entrant in this division — how a CONFIRM
 *  resolves it (`decideSuspension`), so a pending ban's projection names the team the confirm would stamp. */
async function resolveBanEntrant(tx: Tx, personId: string, divisionId: string): Promise<string | null> {
  const [em] = await tx<{ id: string }[]>`
    select e.id from entrant_members em join entrants e on e.id = em.entrant_id
    where em.person_id = ${personId} and e.division_id = ${divisionId} limit 1`;
  return em?.id ?? null;
}

/** What the projection needs of a ban. */
interface CoverableBan {
  id: string;
  person_id: string;
  entrant_id: string | null;
  status: SuspensionStatus;
  decided_at: Date | null;
  fixture_id: string | null;
  matches_total: number;
  matches_served: number;
}

interface ProjectionFixture extends ServingFixture {
  stage_id: string;
  stage_kind: string;
  stage_seq: number;
  round_no: number;
  seq_in_round: number;
  lane: "WB" | "LB" | "GF" | null;
  is_final: boolean;
  third_place: boolean;
  conditional: boolean;
  ext_key: string | null;
  scheduled_at: Date | null;
  home_name: string | null;
  away_name: string | null;
}

/**
 * Which matches each pending or active ban still covers (owner-approved 4A, 2026-10-27).
 *
 * The ban's entrant's next `matchesTotal - matchesServed` fixtures whose `servingVerdict` is `upcoming` — the SAME
 * predicate the counter serves with, so the matches named here are exactly the ones that will end the ban, in order: a
 * match under way since the ban began first, then by kick-off (undated last), stage, round and place in the round —
 * card-stats' "next fixture" order. A pending ban is projected as if confirmed now, through the entrant a confirm would
 * stamp; one with no entrant covers nothing (confirm refuses it). When the team has fewer fixtures left than the ban has
 * matches, the rest are placeholders (`fixtureId` null). Served and waived bans cover nothing.
 *
 * Two reads for the whole division, whatever the number of bans: its fixtures, and the ledger facts — never payloads
 * beyond a forfeit's.
 */
async function coveredMatches(
  tx: Tx,
  divisionId: string,
  bans: readonly CoverableBan[],
  now: Date = new Date(),
): Promise<Map<string, CoveredMatch[]>> {
  const out = new Map<string, CoveredMatch[]>();
  const open = bans.filter((b) => b.status === "pending" || b.status === "active");
  if (open.length === 0) return out;

  const fixtures = await tx<ProjectionFixture[]>`
    select f.id, f.status, f.home_entrant_id, f.away_entrant_id, f.outcome,
           f.stage_id, s.kind as stage_kind, s.seq as stage_seq, f.round_no, f.seq_in_round,
           f.lane, f.is_final, f.third_place, f.conditional, f.ext_key, f.scheduled_at,
           he.display_name as home_name, ae.display_name as away_name
    from fixtures f
    join stages s on s.id = f.stage_id
    left join entrants he on he.id = f.home_entrant_id
    left join entrants ae on ae.id = f.away_entrant_id
    where f.division_id = ${divisionId}`;
  // The serving pass's ledger read, narrowed: only a forfeit's payload is ever read.
  const facts = ledgerFacts(
    await tx<Pick<EventRow, "fixture_id" | "recorded_at" | "type" | "payload">[]>`
      select se.fixture_id, se.recorded_at, se.type,
             case when se.type = 'core.forfeit' then se.payload end as payload
      from score_events se join fixtures f on f.id = se.fixture_id
      where f.division_id = ${divisionId}
      order by se.fixture_id, se.seq`,
  );
  const laneRowsByStage = new Map<string, { round_no: number; lane: "WB" | "LB" | "GF" | null }[]>();
  for (const f of fixtures) {
    (laneRowsByStage.get(f.stage_id) ?? laneRowsByStage.set(f.stage_id, []).get(f.stage_id)!).push({
      round_no: f.round_no,
      lane: f.lane,
    });
  }
  const startedFirst = (f: ProjectionFixture) => (facts.startedAt.has(f.id) ? 0 : 1);
  const at = (f: ProjectionFixture) => (f.scheduled_at === null ? Infinity : f.scheduled_at.getTime());
  const order = (a: ProjectionFixture, b: ProjectionFixture) =>
    startedFirst(a) - startedFirst(b) ||
    at(a) - at(b) ||
    a.stage_seq - b.stage_seq ||
    a.round_no - b.round_no ||
    a.seq_in_round - b.seq_in_round ||
    a.id.localeCompare(b.id);

  for (const b of open) {
    const entrantId = b.entrant_id ?? (await resolveBanEntrant(tx, b.person_id, divisionId));
    if (entrantId === null) {
      out.set(b.id, []);
      continue;
    }
    // A pending ban has served nothing and is projected from now; an active one from its decision.
    const since = b.status === "active" && b.decided_at !== null ? b.decided_at : now;
    const remaining = Math.max(0, b.matches_total - (b.status === "active" ? b.matches_served : 0));
    const ban = { entrantId, fixtureId: b.fixture_id, since };
    const next = fixtures
      .filter((f) => servingVerdict(f, ban, facts) === "upcoming")
      .sort(order)
      .slice(0, remaining);
    const covered: CoveredMatch[] = next.map((f) => {
      const home = f.home_entrant_id === entrantId;
      const role = roundRoleFor(
        laneRowsByStage.get(f.stage_id) ?? [],
        { round_no: f.round_no, lane: f.lane, is_final: f.is_final, third_place: f.third_place, conditional: f.conditional },
        f.stage_kind,
        f.ext_key,
      );
      return {
        fixtureId: f.id,
        roundRole: roundRoleKey(role),
        opponentName: home ? f.away_name : f.home_name,
        scheduledAt: f.scheduled_at === null ? null : f.scheduled_at.toISOString(),
      };
    });
    for (let i = covered.length; i < remaining; i++) {
      covered.push({ fixtureId: null, roundRole: null, opponentName: null, scheduledAt: null });
    }
    out.set(b.id, covered);
  }
  return out;
}

const SELECT_SUSPENSION = (tx: Tx) => tx`
  s.id, s.division_id, s.person_id, p.full_name as person_name,
  s.entrant_id, e.display_name as entrant_name, s.status, s.source, s.reason,
  s.matches_total, s.matches_served, s.fixture_id, s.trigger_event_ids,
  s.created_at, s.decided_at`;

async function voidedSet(tx: Tx, divisionId: string): Promise<Set<string>> {
  const rows = await tx<{ voids_event_id: string }[]>`
    select se.voids_event_id from score_events se join fixtures f on f.id = se.fixture_id
    where f.division_id = ${divisionId} and se.voids_event_id is not null`;
  return new Set(rows.map((r) => r.voids_event_id));
}

async function loadSuspension(tx: Tx, divisionId: string, id: string): Promise<Suspension> {
  const [row] = await tx<SuspensionRow[]>`
    select ${SELECT_SUSPENSION(tx)}
    from suspensions s
    join persons p on p.id = s.person_id
    left join entrants e on e.id = s.entrant_id
    where s.id = ${id} and s.division_id = ${divisionId}`;
  if (!row) throw new HttpError(404, "suspension not found");
  return mapRow(row, await voidedSet(tx, divisionId), await coveredMatches(tx, divisionId, [row]));
}

/** Rules doc + enabled flag + the sport's offerable colours. null when the
 *  division's sport module has no discipline model (tab hidden). An org the
 *  matrix does not entitle FOR THIS COMPETITION hits the requireFeature 402
 *  (PlusReveal) before any rules are returned — a Community org holding an
 *  Event Pass on this competition is entitled and does not. */
export async function getDisciplineRules(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ enabled: boolean; rules: DisciplineRules; sportColors: { key: string; label: string }[] } | null> {
  // TWO PHASES. `requireFeature` queries the pooled `sql` proxy, and it used to
  // run between the two reads below — from inside `withTenant`, which pins a
  // pooled connection for its whole callback. That is the pool self-deadlock
  // (lib/db.ts). The rules row is now read under the transaction and the gate
  // applied after it closes; the org still learns nothing it did not before,
  // because the 402 is thrown before anything is returned.
  const loaded = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<
      { sport_key: string; module_version: string; competition_id: string }[]
    >`
      select sport_key, module_version, competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const model = resolveModule(division.sport_key, division.module_version).discipline;
    if (!model) return null; // no model → hide the tab (ungated, so free orgs learn nothing extra)
    const [row] = await tx<{ enabled: boolean; rules: DisciplineRules }[]>`
      select enabled, rules from discipline_rules where division_id = ${divisionId}`;
    return {
      sportKey: division.sport_key,
      competitionId: division.competition_id,
      colors: model.colors,
      row,
    };
  });
  if (loaded === null) return null;
  // The competition rides out of the transaction rather than costing a second
  // read — this is the one gate that already had the divisions row in hand.
  await requireFeature(auth.orgId, "discipline.enforced", loaded.competitionId);
  return {
    enabled: loaded.row?.enabled ?? false,
    rules: loaded.row?.rules ?? defaultRules(loaded.sportKey),
    sportColors: loaded.colors,
  };
}

export async function putDisciplineRules(
  auth: AuthCtx,
  divisionId: string,
  body: { enabled: boolean; rules: DisciplineRules },
): Promise<void> {
  await requireFeature(auth.orgId, "discipline.enforced", await competitionForDivision(divisionId));
  await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ sport_key: string; module_version: string }[]>`
      select sport_key, module_version from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const model = resolveModule(division.sport_key, division.module_version).discipline;
    if (!model) throw new HttpError(422, "this sport does not track discipline");
    // Validate colours against the module's declared keys (not in zod, SPEC-1).
    const allowed = new Set(model.colors.map((c) => c.key));
    for (const r of [...body.rules.accumulation, ...body.rules.dismissal]) {
      if (!allowed.has(r.color)) throw new HttpError(422, `unknown card colour "${r.color}"`);
    }
    await tx`
      insert into discipline_rules (org_id, division_id, enabled, rules)
      values (${auth.orgId}, ${divisionId}, ${body.enabled}, ${tx.json(body.rules as never)})
      on conflict (division_id)
        do update set enabled = excluded.enabled, rules = excluded.rules, updated_at = now()`;
    await detectSuspensions(tx, divisionId);
  });
}

export async function listSuspensions(
  auth: AuthCtx,
  divisionId: string,
  status?: SuspensionStatus,
): Promise<Suspension[]> {
  // Division-scoped, so exactly ONE competition — the filtering question the
  // org-wide readers in usecases/player-stats.ts had to answer does not arise.
  await requireFeature(auth.orgId, "discipline.enforced", await competitionForDivision(divisionId));
  return withTenant(auth.orgId, async (tx) => {
    await detectSuspensions(tx, divisionId);
    const rows = await tx<SuspensionRow[]>`
      select ${SELECT_SUSPENSION(tx)}
      from suspensions s
      join persons p on p.id = s.person_id
      left join entrants e on e.id = s.entrant_id
      where s.division_id = ${divisionId}
      ${status ? tx`and s.status = ${status}` : tx``}
      order by s.created_at desc, s.id`;
    const voided = await voidedSet(tx, divisionId);
    // After the fold above, so an active ban's `matches_served` is the counter's current answer.
    const covered = await coveredMatches(tx, divisionId, rows);
    return rows.map((r) => mapRow(r, voided, covered));
  });
}

/**
 * The bans awaiting the organiser's review in this division: `pending` rows, counted only where the organiser has
 * switched discipline ON (`discipline_rules.enabled`). A stored-row count — no fold — so the division page can ask it
 * on every tab at the cost of one indexed read. The rows are kept current by the write path (`refreshDiscipline` folds
 * on every decided/void score write) and by every read of the Discipline tab itself.
 *
 * Not gated here: the caller holds the entitlement answer. The division page asks only when `getDisciplineRules`
 * (whose `requireFeature("discipline.enforced", competition)` is the pass-scoped gate) let it in; the desk reads the
 * same count per division from card-stats and gates it with its own `hasFeature`.
 */
export async function countBansToReview(auth: AuthCtx, divisionId: string): Promise<number> {
  return withTenant(auth.orgId, async (tx) => {
    const [r] = await tx<{ n: number }[]>`
      select count(*)::int as n
      from suspensions s
      join discipline_rules dr on dr.division_id = s.division_id and dr.enabled
      where s.division_id = ${divisionId} and s.status = 'pending'`;
    return r?.n ?? 0;
  });
}

export async function createManualSuspension(
  auth: AuthCtx,
  divisionId: string,
  input: { personId: string; matchesTotal: number; reason: string },
): Promise<Suspension> {
  await requireFeature(auth.orgId, "discipline.enforced", await competitionForDivision(divisionId));
  return withTenant(auth.orgId, async (tx) => {
    // Defense-in-depth: the division must belong to the auth org (the tenant
    // rail scopes it; the route also wraps this in requireResourceAuth).
    const [division] = await tx`
      select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [person] = await tx`
      select 1 from persons
       where id = ${input.personId} and org_id = ${auth.orgId} and merged_into is null`;
    if (!person) throw new HttpError(404, "person not found");
    const [{ id }] = await tx<{ id: string }[]>`
      insert into suspensions
        (org_id, division_id, person_id, status, source, reason, matches_total, created_by)
      values (${auth.orgId}, ${divisionId}, ${input.personId}, 'pending', 'manual',
              ${input.reason}, ${input.matchesTotal}, ${auth.userId})
      returning id`;
    return loadSuspension(tx, divisionId, id);
  });
}

export async function decideSuspension(
  auth: AuthCtx,
  id: string,
  action:
    | { kind: "confirm" }
    | { kind: "waive" }
    | { kind: "adjust"; matchesTotal?: number; reason?: string },
): Promise<Suspension> {
  await requireFeature(auth.orgId, "discipline.enforced", await competitionForSuspension(id));
  let confirmedNotice: string | null = null;
  const result = await withTenant(auth.orgId, async (tx) => {
    // `for update`: two confirms of one pending ban serialise here, so exactly one of them reads `pending` and owes the
    // confirmed notice (R6); the other reads `active` and asks for nothing.
    const [s] = await tx<
      { division_id: string; person_id: string; entrant_id: string | null; status: SuspensionStatus }[]
    >`
      select division_id, person_id, entrant_id, status from suspensions where id = ${id} for update`;
    if (!s) throw new HttpError(404, "suspension not found");

    if (action.kind === "confirm") {
      // Resolve the serving entrant now and stamp it (SPEC-1): the person's
      // entrant in this division, when not already known.
      // `resolveBanEntrant` — shared with the "would miss" projection of a pending ban, so it names the team this stamps.
      const entrantId = s.entrant_id ?? (await resolveBanEntrant(tx, s.person_id, s.division_id));
      // No entrant, no serving: `updateServing` counts only an entrant's
      // fixtures, so a ban confirmed with none would stay active for ever and
      // block the player's lineups. Refuse it, before anything is written; the
      // organiser rosters the player first, or waives the ban.
      if (!entrantId) {
        throw new HttpError(
          422,
          "this player is on no entrant in this division, so the ban could never be served — add them to an entrant first, or waive it",
          SUSPENSION_NO_ENTRANT_CODE,
        );
      }
      await tx`
        update suspensions set status = 'active', entrant_id = ${entrantId},
          decided_by = ${auth.userId}, decided_at = now(), updated_at = now()
        where id = ${id}`;
      // The ban just went live (SPEC-1): the claimed player's notice, queued with the decision. A re-confirm of a live
      // ban is not a new fact and owes nothing.
      if (s.status === "pending") confirmedNotice = await queueSuspensionConfirmed(tx, id);
    } else if (action.kind === "waive") {
      await tx`
        update suspensions set status = 'waived', decided_by = ${auth.userId},
          decided_at = now(), updated_at = now()
        where id = ${id}`;
    } else {
      await tx`
        update suspensions set
          matches_total = coalesce(${action.matchesTotal ?? null}, matches_total),
          reason = coalesce(${action.reason ?? null}, reason), updated_at = now()
        where id = ${id}`;
    }
    await detectSuspensions(tx, s.division_id);
    return loadSuspension(tx, s.division_id, id);
  });
  // R5: the first attempt after the decision committed (the request's, as tail work); the worker retries it.
  const queued = confirmedNotice;
  if (queued !== null) deferred(() => dispatchNow([queued]));
  return result;
}

/**
 * Queue the "suspension confirmed" notice for the ban `suspensionId` on the email outbox, on `tx` (the decision's tenant
 * transaction): to the claimed player's ACCOUNT, in their language (D4: the account's, then the org's default, then `en`),
 * at most once per ban (once-key `<id>:confirmed`). Returns the row's id, or `null` when there is nobody to address (the
 * person is not linked to a live account) or the ban's notice is already queued. Every read is on `tx` (#996).
 */
export async function queueSuspensionConfirmed(tx: Tx, suspensionId: string): Promise<string | null> {
  const [r] = await tx<
    ({
      org_id: string;
      user_id: string;
      email: string | null;
      org_name: string;
      default_locale: string | null;
      division_name: string;
      reason: string;
      venue_tz: string;
      division_id: string;
    } & CoverableBan)[]
  >`
    select s.org_id, u.id as user_id, u.email, o.name as org_name, o.default_locale, d.name as division_name,
           s.reason, s.matches_total,
           -- the venue lane (V305), as the officials' notice reads it: division override → org timezone → UTC
           coalesce(ss.tz, o.timezone, 'UTC') as venue_tz,
           s.id, s.person_id, s.entrant_id, s.status, s.decided_at, s.fixture_id, s.matches_served, s.division_id
    from suspensions s
    join persons p on p.id = s.person_id
    join users u on u.id = p.user_id and u.deleted_at is null
    join divisions d on d.id = s.division_id
    join organizations o on o.id = s.org_id
    left join schedule_settings ss on ss.division_id = s.division_id
    where s.id = ${suspensionId}`;
  if (!r?.email) return null;
  const locale = await recipientLocale(tx, { pick: null, userId: r.user_id, orgDefault: r.default_locale });
  // The matches the ban covers, by the SAME projection the Discipline tab shows (`coveredMatches`); the round names in
  // the player's language, from the ui catalogue every bracket surface names rounds with.
  const covered = (await coveredMatches(tx, r.division_id, [r])).get(r.id) ?? [];
  const content = await suspensionConfirmedEmail(
    {
      orgName: r.org_name,
      divisionName: r.division_name,
      reason: r.reason,
      matchesTotal: r.matches_total,
      misses: covered.map((m) => {
        const role = m.roundRole === null ? null : parseRoundRoleKey(m.roundRole);
        return {
          round: role === null ? null : roundRoleLabel((k, v) => msgFor(locale, k, v), role),
          opponent: m.opponentName,
          scheduledAt: m.scheduledAt,
          tz: r.venue_tz,
        };
      }),
    },
    locale,
  );
  return enqueueEmailOnce(tx, {
    kind: "suspension_confirmed",
    refType: "suspension",
    refId: suspensionId,
    dedupeKey: onceKey("suspension_confirmed", "suspension", suspensionId, "confirmed"),
    orgId: r.org_id,
    to: r.email,
    recipientUserId: r.user_id,
    ...content,
    transactional: true,
    expiresAt: expiryWithin(null),
  });
}

// ---------------------------------------------------------------------------
// Cross-surface helpers (PROMPT-79/80)
// ---------------------------------------------------------------------------

/** entrant_id → active suspensions among its members, for the entrant chip. */
export async function activeSuspensionsByEntrant(
  tx: Tx,
  divisionId: string,
): Promise<Map<string, { personId: string; personName: string; remaining: number }[]>> {
  // The transaction is the CALLER's (the organiser division page): a flip here
  // queues its notice in that same transaction, so it stands or falls with the
  // caller's commit.
  await detectSuspensions(tx, divisionId);
  const rows = await tx<
    { entrant_id: string; person_id: string; person_name: string; remaining: number }[]
  >`
    select s.entrant_id, s.person_id, p.full_name as person_name,
           (s.matches_total - s.matches_served) as remaining
    from suspensions s join persons p on p.id = s.person_id
    where s.division_id = ${divisionId} and s.status = 'active' and s.entrant_id is not null`;
  const map = new Map<string, { personId: string; personName: string; remaining: number }[]>();
  for (const r of rows) {
    const entry = { personId: r.person_id, personName: r.person_name, remaining: r.remaining };
    (map.get(r.entrant_id) ?? map.set(r.entrant_id, []).get(r.entrant_id)!).push(entry);
  }
  return map;
}

/** Distinct division squad (rostered persons) for the manual-ban person picker.
 *  Ungated read — the panel only renders when the org is entitled. */
export async function divisionSquad(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ person_id: string; full_name: string }[]> {
  return withTenant(auth.orgId, (tx) =>
    tx<{ person_id: string; full_name: string }[]>`
      select distinct p.id as person_id, p.full_name
      from entrant_members em
      join entrants e on e.id = em.entrant_id
      join persons p on p.id = em.person_id
      where e.division_id = ${divisionId}
      order by p.full_name`,
  );
}

/** Active suspensions among a fixture's entrants, keyed for the pad banner
 *  bootstrap (served/total, not remaining). Returns [] when the org isn't
 *  entitled to discipline ON THIS COMPETITION — the fixture page renders for
 *  every tier, so this never throws a 402 that would break the pad. A silent
 *  [] is also how an over-refusing gate hides, which is why pass-scope-w2's
 *  banner case proves the row it declines to return actually exists. */
export async function suspensionsForFixture(
  auth: AuthCtx,
  divisionId: string,
  entrantIds: (string | null)[],
): Promise<{ personId: string; personName: string; served: number; total: number }[]> {
  const ids = entrantIds.filter((x): x is string => !!x);
  if (ids.length === 0) return [];
  const competitionId = await competitionForDivision(divisionId);
  if (!(await hasFeature(auth.orgId, "discipline.enforced", competitionId))) return [];
  return withTenant(auth.orgId, async (tx) => {
    await detectSuspensions(tx, divisionId);
    const rows = await tx<
      { person_id: string; person_name: string; served: number; total: number }[]
    >`
      select s.person_id, p.full_name as person_name,
             s.matches_served as served, s.matches_total as total
      from suspensions s join persons p on p.id = s.person_id
      where s.division_id = ${divisionId} and s.status = 'active'
        and s.entrant_id = any(${ids})`;
    return rows.map((r) => ({
      personId: r.person_id,
      personName: r.person_name,
      served: r.served,
      total: r.total,
    }));
  });
}

/** Public "Suspensions" strip: active bans, names via public_person_name
 *  consent (exactly the publicDivisionStats pattern), then the division's
 *  youth/name-display policy. Ungated read. */
export async function publicSuspensions(
  orgSlug: string,
  competitionSlug: string,
  divisionSlug: string,
): Promise<{ name: string; remaining: number }[]> {
  const [division] = await sql<
    { id: string; org_id: string; youth: boolean; player_name_display: string | null }[]
  >`
    select d.id, d.org_id, d.youth, d.player_name_display
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${competitionSlug} and d.slug = ${divisionSlug}
      and c.visibility in ('public','unlisted')`;
  if (!division) throw new HttpError(404, "division not found");
  await withTenant(division.org_id, (tx) => detectSuspensions(tx, division.id));
  const rows = await sql<{ name: string; consent: { public_name?: boolean } | null; remaining: number }[]>`
    select public_person_name(p.full_name, p.consent) as name, p.consent,
           (s.matches_total - s.matches_served) as remaining
    from suspensions s join persons p on p.id = s.person_id
    where s.division_id = ${division.id} and s.status = 'active'
    order by name`;
  // Privacy hotfix (2026-09-16): `public_person_name` is consent-only (V229),
  // so a consented youth player's full name was printed here while the rest
  // of the division page masked it. The shared resolver is applied ON TOP of
  // the SQL name, never instead of it: the two disagree on an ABSENT consent
  // (SQL initials it, the resolver does not mask it), and the strip must stay
  // the stricter of the two. Masking an initials-only name is a no-op.
  return rows.map((r) => ({
    name: resolvePersonDisplayName(r.name, r.consent, division.player_name_display, division.youth),
    remaining: r.remaining,
  }));
}

/**
 * Every active ban in the given divisions, for the competition hub — ONE
 * query, and READ-ONLY.
 *
 * Unlike `publicSuspensions` above (the division page's strip), this runs no
 * detection and no serving pass. The hub rebuilds on a cache miss with no
 * single-flight, and a rebuild must not open a write transaction, scan the
 * score ledger or send a "served" email. Serving belongs to the write path:
 * `refreshDiscipline` (scoring.ts) folds on every decided/void write in a
 * division with enabled rules OR an active ban, so a ban a result has served
 * already reads `served` here.
 *
 * Carries WHO — the person and the entrant — so the hub marks the suspended
 * member on a Teams card by identity, never by matching a masked name: two
 * "Xavier S." on two teams are two people. `personId` is the INTERNAL
 * `persons.id`, a join key for the builder only; the hub publishes a person's
 * id on no wider terms than `public_entrants_v` does.
 *
 * `name` follows the division strip's ONE rule for a ban, from the same
 * columns: `public_person_name(full_name, consent)` first (so a consent never
 * answered reads as initials), then the division's own youth/name policy ON
 * TOP through `resolvePersonDisplayName` (so a consented youth is masked
 * too). The stricter of the two always wins, and masking an initials-only
 * name is a no-op. The full name never leaves the database.
 *
 * Only divisions of a public or unlisted competition answer, whatever ids the
 * caller passes.
 */
export async function activePublicSuspensionEntries(
  divisionIds: readonly string[],
): Promise<{ divisionId: string; personId: string; entrantId: string | null; name: string; remaining: number }[]> {
  if (divisionIds.length === 0) return [];
  const rows = await sql<
    {
      division_id: string;
      person_id: string;
      entrant_id: string | null;
      name: string;
      consent: { public_name?: boolean } | null;
      youth: boolean;
      player_name_display: string | null;
      remaining: number;
    }[]
  >`
    select s.division_id, s.person_id, s.entrant_id,
           public_person_name(p.full_name, p.consent) as name, p.consent,
           d.youth, d.player_name_display,
           (s.matches_total - s.matches_served) as remaining
    from suspensions s
    join persons p on p.id = s.person_id
    join divisions d on d.id = s.division_id
    join competitions c on c.id = d.competition_id
    where s.division_id in ${sql([...divisionIds])} and s.status = 'active'
      and c.visibility in ('public','unlisted')
    order by s.division_id, s.id`;
  return rows.map((r) => ({
    divisionId: r.division_id,
    personId: r.person_id,
    entrantId: r.entrant_id,
    name: resolvePersonDisplayName(r.name, r.consent, r.player_name_display, r.youth),
    remaining: r.remaining,
  }));
}

// ---------------------------------------------------------------------------
// B05 — the discipline gate at the team sheet.
//
// Everything above this line is READ-side: the fold, the organiser console,
// the pad banner, the public strip. Until now that was the whole of discipline
// in this product — an organiser could record a suspension, confirm it, and
// the banned player was still accepted onto a lineup, because nothing on the
// write path read this table at all. `discipline.enforced` is sold on the
// pricing matrix, so the feature stopped exactly short of the one moment it
// matters: a manager naming a player.
//
// A ban names no fixtures. `suspensions` carries no fixture list and no date
// range, so "is P banned for fixture F" is answerable ONLY as "P holds an
// `active` row in F's division" — which is why the gate is division-scoped and
// why `updateServing`'s counting (untouched here) stays the thing that ends a
// ban.
// ---------------------------------------------------------------------------

/**
 * Is this org entitled to discipline enforcement on the competition this
 * fixture belongs to?
 *
 * MUST be awaited BEFORE the caller opens its `withTenant` transaction, never
 * inside it: `hasFeature` queries the pooled `sql` proxy, and a second pool
 * checkout while a transaction pins the first is the self-deadlock `lib/db.ts`'s
 * nesting guard exists to catch (same reason `getDisciplineRules` above splits
 * into two phases, and same "resolve it outside, pass the boolean in" shape as
 * `draftPostsForDecidedFixture`).
 *
 * `hasFeature`, NOT `requireFeature`: an org that never bought discipline must
 * see NO behaviour change on the lineup path. A 402 there would break a team
 * sheet that works today for every Community org in the product.
 */
export async function disciplineEnforcedForFixture(
  orgId: string,
  fixtureId: string,
): Promise<boolean> {
  const [row] = await sql<{ competition_id: string }[]>`
    select d.competition_id
    from fixtures f join divisions d on d.id = f.division_id
    where f.id = ${fixtureId}`;
  // No fixture (or none this org can see): the caller's own transaction raises
  // the 404. Answering "not enforced" here leaks nothing and gates nothing.
  if (!row) return false;
  return hasFeature(orgId, "discipline.enforced", row.competition_id);
}

export interface GateLineupSuspensionsArgs {
  /** The fixture's division — the only scope a suspension has. */
  divisionId: string;
  competitionId: string;
  orgId: string;
  fixtureId: string;
  /** person ids on the sheet being written. Empty is a no-op. */
  personIds: readonly string[];
  /** `disciplineEnforcedForFixture`, resolved OUTSIDE the transaction. */
  enforced: boolean;
  /** Reuses `PutLineup.eligibility_override` rather than adding a second
   *  override field — one dialog, one reason box, two gates behind it. */
  override?: { reason: string } | null;
  actorId: string | null;
}

/**
 * Refuses a team sheet that names anyone serving an ACTIVE suspension in this
 * division, unless the organiser supplies an override reason — in which case
 * exactly one `suspension.overridden` ledger row is written and the sheet is
 * accepted.
 *
 * `suspension.overridden`, deliberately NOT `eligibility.overridden`: the two
 * gates share the override FIELD, but a person reading the ledger has to be
 * able to tell "organiser waved through an age/category violation" from
 * "organiser named a banned player". They are different conversations with
 * different people.
 *
 * ONLY `status = 'active'` blocks, and the other three statuses the V293 CHECK
 * allows are each a deliberate non-block:
 *  - `pending` — raised by the auto-fold, the report bridge or a manual POST,
 *    and NOBODY HAS CONFIRMED IT. `decideSuspension` is the only thing that
 *    makes a row a ban (it is also the only thing that stamps `decided_at`),
 *    so blocking on `pending` would ban a player off an unreviewed accusation.
 *  - `served` — the ban is spent (`updateServing`).
 *  - `waived` — an organiser explicitly cancelled it.
 *
 * No `detectSuspensions` fold here on purpose: the fold only ever raises
 * `pending` rows, which do not block, so it could not change this answer — it
 * would just put the whole discipline projection on the write path of every
 * lineup PUT.
 */
export async function gateLineupSuspensions(
  tx: Tx,
  {
    divisionId,
    competitionId,
    orgId,
    fixtureId,
    personIds,
    enforced,
    override,
    actorId,
  }: GateLineupSuspensionsArgs,
): Promise<void> {
  if (!enforced) return;
  const ids = [...new Set(personIds)];
  if (ids.length === 0) return;
  // `distinct` because one person can hold more than one active row (two
  // accumulation buckets, or an accumulation plus a manual): the sentence and
  // the ledger payload name a PERSON once, not once per row.
  const banned = await tx<{ person_id: string; full_name: string }[]>`
    select distinct s.person_id, p.full_name
    from suspensions s join persons p on p.id = s.person_id
    where s.division_id = ${divisionId}
      and s.status = 'active'
      and s.person_id in ${tx(ids)}
    order by p.full_name`;
  if (banned.length === 0) return;
  if (!override?.reason) {
    throw new HttpError(
      422,
      suspendedPlayersMessage(banned.map((b) => b.full_name)),
      "SUSPENDED_PLAYER",
      { suspended: banned.map((b) => ({ person_id: b.person_id, full_name: b.full_name })) },
    );
  }
  await audit(
    tx,
    competitionId,
    orgId,
    "suspension.overridden",
    {
      context: "put_lineup",
      division_id: divisionId,
      fixture_id: fixtureId,
      person_ids: banned.map((b) => b.person_id),
      reason: override.reason,
    },
    actorId,
  );
}
