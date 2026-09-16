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
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasFeature, requireFeature } from "@/lib/entitlements";
import type { Locale } from "@/lib/i18n-constants";
import { sendSuspensionConfirmedEmail, sendSuspensionServedEmail } from "@/lib/email";
import type { AuthCtx } from "@/server/api-v1/auth";
import { resolveModule } from "@/server/engine-db";
import { suspendedPlayersMessage } from "@/lib/registration-rules";
import { resolvePersonDisplayName } from "@/lib/name-display";
import { deferred } from "@/lib/deferred";
import { log } from "@/server/logger";
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
 *  Returns the bans THIS pass flipped active→served, and sends
 *  nothing: the "served" notice belongs after the transaction commits, which
 *  only the caller sees. Every caller that owns its transaction passes these
 *  to `notifyServedSuspensions` once `withTenant` has resolved. */
export async function detectSuspensions(tx: Tx, divisionId: string): Promise<ServedFlip[]> {
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
// suspended entrant that elapsed after the ban's decided_at. A forfeit BY the
// suspended entrant counts; abandoned/cancelled and forfeits by anyone else
// never do. A fixture's elapsed time = its latest recorded event.
async function updateServing(tx: Tx, divisionId: string, events: EventRow[]): Promise<ServedFlip[]> {
  const active = await tx<
    { id: string; entrant_id: string | null; decided_at: Date | null; matches_total: number }[]
  >`
    select id, entrant_id, decided_at, matches_total from suspensions
    where division_id = ${divisionId} and status = 'active'`;
  if (active.length === 0) return [];

  const fixtures = await tx<
    { id: string; status: string; home_entrant_id: string | null; away_entrant_id: string | null }[]
  >`
    select id, status, home_entrant_id, away_entrant_id from fixtures where division_id = ${divisionId}`;

  const elapsedAt = new Map<string, Date>();
  const forfeitBy = new Map<string, string>();
  for (const e of events) {
    const cur = elapsedAt.get(e.fixture_id);
    if (!cur || e.recorded_at > cur) elapsedAt.set(e.fixture_id, e.recorded_at);
    if (e.type === "core.forfeit") {
      const by = (e.payload as { by?: string } | null)?.by;
      if (typeof by === "string") forfeitBy.set(e.fixture_id, by);
    }
  }

  const flipped: ServedFlip[] = [];
  for (const s of active) {
    if (!s.entrant_id || !s.decided_at) continue;
    let served = 0;
    for (const f of fixtures) {
      if (f.home_entrant_id !== s.entrant_id && f.away_entrant_id !== s.entrant_id) continue;
      const when = elapsedAt.get(f.id);
      if (!when || when <= s.decided_at) continue;
      if (f.status === "decided" || f.status === "finalized") served++;
      else if (f.status === "forfeited" && forfeitBy.get(f.id) === s.entrant_id) served++;
    }
    const capped = Math.min(served, s.matches_total);
    const status = capped >= s.matches_total ? "served" : "active";
    // `and status = 'active'`: the read above takes no lock, so two passes
    // (a decided score write and a division page read, or two decided writes)
    // can both see this ban active and both compute "served". The second
    // UPDATE waits on the first's row lock, then re-checks the WHERE against
    // the committed row — no longer active — and matches nothing. So only the
    // statement that actually flipped the row reports it.
    // `xmin` names THIS transaction as the writer of the flip, so the notice
    // can tell its own flip from someone else's (see `notifyServedSuspensions`).
    const updated = await tx<{ id: string; xmin: string }[]>`
      update suspensions set matches_served = ${capped}, status = ${status}, updated_at = now()
      where id = ${s.id} and status = 'active'
      returning id, xmin::text as xmin`;
    if (status === "served" && updated.length > 0) flipped.push({ id: s.id, xmin: updated[0]!.xmin });
  }
  return flipped;
}

/** One ban a serving pass flipped active→served: the row, and the id of the
 *  transaction that wrote that flip (`xmin` of the row version it produced). */
export interface ServedFlip {
  id: string;
  xmin: string;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Notify claimed players whose suspensions a serving pass flipped to served —
 * called with `detectSuspensions`' return value AFTER the transaction that
 * flipped them has ended. Superuser read (users is a global table); unclaimed
 * persons (no users row) drop out of the join and get no mail. The sends are
 * fire-and-forget, and a send that rejects is logged.
 *
 * The first read takes `for share` on the rows WITHOUT filtering on status:
 * a row lock is only taken — and so only waited for — on rows the snapshot
 * already matches, and a flip still uncommitted reads as `active` in it. So it
 * waits out a flipping transaction that is still open (the one caller that
 * serves inside a transaction it does not own hands its flips here without
 * being able to wait for that commit) and sees the row as that transaction
 * left it.
 *
 * A row is mailed only if it is served AND its current version is still the
 * one THIS pass wrote (`xmin`). "Is served" alone is not enough: a pass that
 * rolled back, whose notice runs after another pass flipped the ban and
 * committed, would otherwise mail a flip that other pass already mailed. A row
 * rewritten again since the flip (an organiser edit) is not mailed either —
 * delivery is at most once, never twice.
 *
 * NEVER throws: it runs after a commit, and a notice that fails must not make
 * a write that already stands look failed. A failure is logged instead.
 */
export async function notifyServedSuspensions(flips: readonly ServedFlip[]): Promise<void> {
  if (flips.length === 0) return;
  try {
    const wrote = new Map(flips.map((f) => [f.id, f.xmin]));
    const settled = await sql<{ id: string; status: string; xmin: string }[]>`
      select id, status, xmin::text as xmin from suspensions where id = any(${[...wrote.keys()]}) for share`;
    const served = settled.filter((r) => r.status === "served" && r.xmin === wrote.get(r.id)).map((r) => r.id);
    if (served.length === 0) return;
    const rows = await sql<
      {
        id: string;
        email: string | null;
        locale: string | null;
        org_name: string;
        division_name: string;
        reason: string;
      }[]
    >`
      select s.id, u.email, u.locale, o.name as org_name, d.name as division_name, s.reason
      from suspensions s
      join persons p on p.id = s.person_id
      join users u on u.id = p.user_id
      join divisions d on d.id = s.division_id
      join organizations o on o.id = s.org_id
      where s.id = any(${served})`;
    for (const r of rows) {
      if (!r.email) continue;
      void sendSuspensionServedEmail(
        r.email,
        { orgName: r.org_name, divisionName: r.division_name, reason: r.reason },
        (r.locale as Locale) ?? "en",
      ).catch((err: unknown) => {
        log.warn({ suspensionId: r.id, err: errorText(err) }, "discipline: a served email failed to send");
      });
    }
  } catch (err) {
    log.warn(
      { suspensionIds: flips.map((f) => f.id), err: errorText(err) },
      "discipline: the served notice failed after commit; the ban stands served",
    );
  }
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

function mapRow(row: SuspensionRow, voided: Set<string>): Suspension {
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
  };
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
  return mapRow(row, await voidedSet(tx, divisionId));
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
  const served = await withTenant(auth.orgId, async (tx) => {
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
    return detectSuspensions(tx, divisionId);
  });
  await notifyServedSuspensions(served);
}

export async function listSuspensions(
  auth: AuthCtx,
  divisionId: string,
  status?: SuspensionStatus,
): Promise<Suspension[]> {
  // Division-scoped, so exactly ONE competition — the filtering question the
  // org-wide readers in usecases/player-stats.ts had to answer does not arise.
  await requireFeature(auth.orgId, "discipline.enforced", await competitionForDivision(divisionId));
  let served: ServedFlip[] = [];
  const result = await withTenant(auth.orgId, async (tx) => {
    served = await detectSuspensions(tx, divisionId);
    const rows = await tx<SuspensionRow[]>`
      select ${SELECT_SUSPENSION(tx)}
      from suspensions s
      join persons p on p.id = s.person_id
      left join entrants e on e.id = s.entrant_id
      where s.division_id = ${divisionId}
      ${status ? tx`and s.status = ${status}` : tx``}
      order by s.created_at desc, s.id`;
    const voided = await voidedSet(tx, divisionId);
    return rows.map((r) => mapRow(r, voided));
  });
  await notifyServedSuspensions(served);
  return result;
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
  let served: ServedFlip[] = [];
  const result = await withTenant(auth.orgId, async (tx) => {
    const [s] = await tx<
      { division_id: string; person_id: string; entrant_id: string | null; status: SuspensionStatus }[]
    >`
      select division_id, person_id, entrant_id, status from suspensions where id = ${id}`;
    if (!s) throw new HttpError(404, "suspension not found");

    if (action.kind === "confirm") {
      // Resolve the serving entrant now and stamp it (SPEC-1): the person's
      // entrant in this division, when not already known.
      let entrantId = s.entrant_id;
      if (!entrantId) {
        const [em] = await tx<{ id: string }[]>`
          select e.id from entrant_members em join entrants e on e.id = em.entrant_id
          where em.person_id = ${s.person_id} and e.division_id = ${s.division_id} limit 1`;
        entrantId = em?.id ?? null;
      }
      await tx`
        update suspensions set status = 'active', entrant_id = ${entrantId},
          decided_by = ${auth.userId}, decided_at = now(), updated_at = now()
        where id = ${id}`;
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
    served = await detectSuspensions(tx, s.division_id);
    return loadSuspension(tx, s.division_id, id);
  });
  // Confirm-only: notify the claimed player once the ban is live (SPEC-1).
  if (action.kind === "confirm") await emailConfirmed(id, result);
  await notifyServedSuspensions(served);
  return result;
}

/** Notify the claimed player that an organiser confirmed their suspension.
 *  Superuser resolve; unclaimed persons drop out of the join. Fire-and-forget. */
async function emailConfirmed(id: string, sus: Suspension): Promise<void> {
  // After the decision committed: a failure here is logged, never thrown, so
  // the decision does not read as failed and the served notice after it runs.
  try {
    const [r] = await sql<
      { email: string | null; locale: string | null; org_name: string; division_name: string }[]
    >`
      select u.email, u.locale, o.name as org_name, d.name as division_name
      from suspensions s
      join persons p on p.id = s.person_id
      join users u on u.id = p.user_id
      join divisions d on d.id = s.division_id
      join organizations o on o.id = s.org_id
      where s.id = ${id}`;
    if (!r?.email) return;
    void sendSuspensionConfirmedEmail(
      r.email,
      { orgName: r.org_name, divisionName: r.division_name, reason: sus.reason, matchesTotal: sus.matchesTotal },
      (r.locale as Locale) ?? "en",
    ).catch((err: unknown) => {
      log.warn({ suspensionId: id, err: errorText(err) }, "discipline: a confirmed email failed to send");
    });
  } catch (err) {
    log.warn(
      { suspensionId: id, err: errorText(err) },
      "discipline: the confirmed notice failed after commit; the decision stands",
    );
  }
}

// ---------------------------------------------------------------------------
// Cross-surface helpers (PROMPT-79/80)
// ---------------------------------------------------------------------------

/** entrant_id → active suspensions among its members, for the entrant chip. */
export async function activeSuspensionsByEntrant(
  tx: Tx,
  divisionId: string,
): Promise<Map<string, { personId: string; personName: string; remaining: number }[]>> {
  // The transaction is the CALLER's (the organiser division page), so its
  // commit is out of sight here: hand any flip to the notice as tail work. It
  // waits for this transaction to end and mails only a flip that committed.
  const served = await detectSuspensions(tx, divisionId);
  if (served.length > 0) deferred(() => notifyServedSuspensions(served));
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
  let served: ServedFlip[] = [];
  const result = await withTenant(auth.orgId, async (tx) => {
    served = await detectSuspensions(tx, divisionId);
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
  await notifyServedSuspensions(served);
  return result;
}

/** Public "Suspensions" strip: active bans, names via public_person_name
 *  consent (exactly the publicDivisionStats pattern). Ungated read. */
export async function publicSuspensions(
  orgSlug: string,
  competitionSlug: string,
  divisionSlug: string,
): Promise<{ name: string; remaining: number }[]> {
  const [division] = await sql<{ id: string; org_id: string }[]>`
    select d.id, d.org_id
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${competitionSlug} and d.slug = ${divisionSlug}
      and c.visibility in ('public','unlisted')`;
  if (!division) throw new HttpError(404, "division not found");
  await notifyServedSuspensions(await withTenant(division.org_id, (tx) => detectSuspensions(tx, division.id)));
  return sql<{ name: string; remaining: number }[]>`
    select public_person_name(p.full_name, p.consent) as name,
           (s.matches_total - s.matches_served) as remaining
    from suspensions s join persons p on p.id = s.person_id
    where s.division_id = ${division.id} and s.status = 'active'
    order by name`;
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
