import "server-only";
// Who holds a destination: holder guard, prior Machine / output teardown, target_in_use, holder expiry (see ./index.ts).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { TERMINAL_STATES, isTerminal } from "@/server/relay/domain/session";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";
import { holderHref, holderRows, wireHolder, type TargetHolder } from "../stream-target-holders";
import { type Row, cols, toSession, readRow } from "./session-row";
import type { SessionDeps } from "./deps";
import { recordEffect, releaseOutput } from "./port-effects";
import { applyExpiry } from "./expiry";

/** The DESTINATION guard (gap 4; owner-directed 2026-09-27 from `_SCENARIO-2026-09-27-court-bound-device.md`, gap item 2).
 *  `target_id` is org-scoped with no court or fixture binding, so two DIFFERENT fixtures may name one `org_stream_targets`
 *  row and push the same RTMPS key: YouTube accepts one broadcast per key, so the second is refused or fights the first and
 *  the organiser reads "the stream did not start" with nothing in our data explaining it.
 *
 *  V421's `fixture_stream_sessions_one_active_target` is the REAL guard — the only one that survives a second writer, the
 *  same reason `fixture_stream_sessions_one_active` and `org_stream_credits_idempotency_key` are indexes and not code (Task
 *  7's m22 measured it: one key racing on two orgs holds two different money locks, both writers miss the lookup, and the
 *  INDEX refuses the loser). This read is the refusal ON TOP of it, so the organiser gets a sentence instead of a 23505 and
 *  a refused start makes no provider call at all.
 *
 *  It is deliberately NOT a new `admit` refusal: `admit` is Task 2A's committed pure function, and knowing WHO holds a
 *  destination is a database read, which `admit` by contract cannot do. So the refusal is thrown here and `refuse`'s switch
 *  over `admit`'s verdicts is untouched.
 *
 *  LAZY FIRST, then refuse (recommendation B; AGENTS.md failure class 13 — an idempotency guard that also swallowed a
 *  legitimate arrival). Every non-terminal holder is run through `applyExpiry` BEFORE anything is refused, because a holder
 *  the expiry policy already expires is not holding the destination — it is a crashed session nobody has read yet, and
 *  refusing on it would brick a paid destination until Task 12's daily sweep. On a holder `evaluate` answers `none` for,
 *  `applyExpiry` is the T5-a null command: nothing is written and no effect runs, which is why G-T1 still sees zero
 *  provider calls.
 *
 *  This fixture's OWN active session is excluded — `is distinct from`, so a holder whose fixture was DELETED
 *  (`fixture_id` is `on delete set null`, G2) still counts and simply cannot name a court. A second session on THIS
 *  fixture is `active_session`, which `admit` already answers and whose refusal the API, the Phone tab and the four
 *  dictionaries already carry; answering `target_in_use` there would send the organiser to the wrong screen.
 *
 *  The `org_stream_targets` join is also the tenancy floor: a target belonging to another org yields no holder, and the
 *  later `admit` answers 404 `target_not_found` from `targetBelongsToOrg`. This function never leaks another org's state. */
export async function targetHolderFor(targetId: string, orgId: string, fixtureId: string, deps: SessionDeps): Promise<TargetHolder | null> {
  // T3 (M2, B1 review): the ONE holder query (stream-target-holders.ts `holderRows`) — Go live, the Directory list and
  // Replace key / Remove share one source for "held by a live or waiting match", so they cannot diverge.
  const first = await holderRows(sql, { orgId, targetId, notFixtureId: fixtureId });
  if (first.length === 0) return null;
  for (const h of first) await applyExpiry(h.sessionId, deps);      // B: this start attempt IS the tick for the holder too
  const [still] = await holderRows(sql, { orgId, targetId, notFixtureId: fixtureId });
  return still ?? null;
}

/** YouTube Connect T3 (spec §5.2): the cross-fixture arm of both prior-teardown queries below — "any terminal session on THIS
 *  destination, whichever fixture it was made for" — holds only for a PASTED destination, where a Machine or an output on
 *  the key fights the next publisher. An API-backed destination (a connection) streams several matches at once, each on its
 *  own pooled key, and its exclusivity is the key's (§5.4); another fixture's leftover there is neither destroyed nor
 *  retried from this admission, and refuses nothing. The fixture's OWN sessions stay in scope either way (the other arm).
 *  Decided by the TARGET's source (`youtube_connection_id`), in the caller's org. A target that is not this org's, or is
 *  gone, is not API-backed as far as this fragment can tell, so it keeps today's behaviour (`admit` answers it 404). */
const pastedTarget = (orgId: string, targetId: string) => sql`not exists (
  select 1 from org_stream_targets x where x.id = ${targetId} and x.org_id = ${orgId} and x.youtube_connection_id is not null)`;

/** 2C-post m5 (Task 2C-post review m5; post-2C-post plan sync). The fixture's one-active index releases the moment a session
 *  goes terminal — since F-A a stop whose Machine never auto-destroyed completes at grace + slack — whether or not that
 *  Machine's destroy was ever CONFIRMED: a force_destroy whose DELETE threw leaves the row completed + destroyed, and nothing
 *  lazy re-issues it. Invariant 1 is untouched, because the Machine NAME is per session (`relay-<sid>-r<n>`). The DESTINATION
 *  is not per session: a new session on the same fixture normally pushes to the same `org_stream_targets` row — the same RTMP
 *  stream key — and two publishers on one key fight on the platform's side. So admission applies Task 12's ORPHAN rule (a
 *  Machine the provider still lists whose session is terminal is destroyed) to THIS fixture's sessions, lazily, before
 *  `admit`: each such Machine is destroyed now, recorded as a `force_destroy` effect row on its own session. It answers the
 *  id of a session whose destroy FAILED — `admit` then refuses `active_session` naming it, which is the truth (that session's
 *  broadcast may still be running) and reuses the refusal the API, the Phone tab and its four dictionaries already carry —
 *  or null. The provider is asked ONLY when the fixture — or the destination, below — has a terminal composed session that
 *  ever held a runner, so a start while composed is off (and FLY_API_TOKEN may be absent) never calls it. It destroys
 *  directly and feeds nothing to `decide` (T12-a's rule): a terminal row's runner converges on its next reconcile or the backstop.
 *
 *  I1 (Task 10 fix round 1 + addendum). The DESTINATION is the unit of exclusivity (V421), and a Machine pushes to the
 *  destination's key whichever fixture it was made for — so the query also covers every terminal composed session on THIS
 *  target (`fixture_id = $f OR target_id = $t`, inside the caller's org; the target arm is for a PASTED destination only — `pastedTarget`). A TERMINAL session's still-listed Machine is an
 *  orphan by Task 12's rule whichever fixture it belongs to, so admission destroys it now rather than waiting for the daily
 *  sweep — refusing without trying would brick the destination for the next match on that court until then (failure class
 *  13; orchestrator ruling reversed 2026-09-28 on that reasoning). Each attempt is the SAME force_destroy effect row on the
 *  ended session either way, carrying `reason: "admission"` and the ADMITTING fixture, so its ledger says who destroyed it
 *  and why. Only a destroy that FAILS decides the refusal: this fixture's → `active_session` naming it (2C-post m5), another
 *  fixture's → `target_in_use` naming its court (`otherFixture`; a fixture-less session, its fixture deleted, is another
 *  fixture's). An ACTIVE session is never in this query: an active holder on another fixture was already refused, untouched,
 *  by `targetHolderFor`, and this fixture's own active session is refused `active_session` by `admit` — a live Machine is
 *  never destroyed from an admission.
 *
 *  A22(c) (Task 10 minor n1, V422): a row the daily sweep CONFIRMED gone — runner `destroyed` AND
 *  `runner_gone_confirmed_at` set, both — is left out, so a start whose every prior Machine is confirmed gone never asks
 *  the provider: a Fly outage no longer 500s a PASSTHROUGH start on a fixture whose old Machine died days ago. Both halves
 *  are read, never the mark alone: a late create_ok moves a marked row's runner `destroyed → lost`, which puts it back
 *  here whatever the column holds, and a forced destroy that fails clears the mark (forceDestroy). */
export async function tearDownPriorMachines(
  fixtureId: string, targetId: string, orgId: string, deps: SessionDeps,
): Promise<{ sameFixture: string | null; otherFixture: Holder | null }> {
  // ONE read carries each row's destination label and court (the target FK is `not null` and restricts deletes, so the
  // inner join drops nothing): a refusal never needs a second read that could find the row gone.
  const prior = await sql<(Row & TerminalHolderRow)[]>`
    select p.*, t.label as holder_label, c.name as holder_court, ${terminalHolderCols()}
      from (select ${cols()} from fixture_stream_sessions
             where org_id = ${orgId} and (fixture_id = ${fixtureId} or (target_id = ${targetId} and ${pastedTarget(orgId, targetId)}))
               and mode = 'composed' and runner_state <> 'none' and state in ${sql([...TERMINAL_STATES])}
               and not (runner_state = 'destroyed' and runner_gone_confirmed_at is not null)) p
      join org_stream_targets t on t.id = p.target_id
      left join fixtures f on f.id = p.fixture_id
      left join courts c on c.id = f.court_id
      ${terminalHolderJoins()}`;
  if (prior.length === 0) return { sameFixture: null, otherFixture: null };
  const bySession = new Map(prior.map((r) => [r.id, { s: toSession(r), holder: terminalHolder(r) }] as const));
  const listed = (await deps.drivers.runner.list()).flatMap((m) => {
    const hit = m.sessionId ? bySession.get(m.sessionId) : undefined;
    return hit ? [{ m, ...hit }] : [];
  });
  for (const { m, s, holder } of listed) {
    try {
      await recordEffect(s, "force_destroy", "runner", () => deps.drivers.runner.destroy(m.runnerId), { machineId: m.runnerId, machineName: m.name, reason: "admission", fixtureId });
    } catch (err) {
      // r2-m3 (Task 11 re-review): a Machine that survived this DELETE may still be pushing to the destination — the same
      // alarm as forceDestroy's (route, extra shape), site `admission`, beside the 409 the organiser sees.
      captureError(err, { orgId, route: "relay.force_destroy", extra: { sessionId: s.id, machineId: m.runnerId, machineName: m.name, attempt: s.runner.attempt, site: "admission" } });
      if (s.fixtureId !== fixtureId) {
        log.warn({ sid: s.id, fixtureId, holderFixtureId: s.fixtureId, targetId, machineId: m.runnerId, err: String(err) }, "stream session: another fixture's ended session still has a Machine on this destination and its destroy failed — start refused");
        return { sameFixture: null, otherFixture: holder };
      }
      log.warn({ sid: s.id, fixtureId, machineId: m.runnerId, err: String(err) }, "stream session: a previous session's Machine is still listed and its destroy failed — start refused");
      return { sameFixture: s.id, otherFixture: null };
    }
  }
  return { sameFixture: null, otherFixture: null };
}

/** C1 (lane C final review; orchestrator ruling — mirror tearDownPriorMachines). A session that ended with
 *  its output release FAILED may still be simulcasting to its destination, and V421's one-active index covers active
 *  states only — so a new session on the same destination would add a SECOND output to the same key while the first
 *  phone still publishes. Admission therefore retries the release first, for every terminal session of THIS
 *  fixture or on THIS pasted destination (inside the caller's org; an API-backed one is exempt, `pastedTarget`) whose output is recorded and not released — either mode since
 *  R2004 (a composed session's output is on its programme input) — and refuses only
 *  when the retry fails: this fixture's → `active_session` naming it, another fixture's → `target_in_use` naming its
 *  court — the same two refusals, for the same reason, as a Machine that survived its destroy. The provider is asked
 *  only when such a row exists, so an ordinary start makes no extra call. */
export async function releasePriorOutputs(
  fixtureId: string, targetId: string, orgId: string, deps: SessionDeps,
): Promise<{ sameFixture: string | null; otherFixture: Holder | null }> {
  const prior = await sql<({ id: string; fixture_id: string | null } & TerminalHolderRow)[]>`
    select s.id, s.fixture_id, t.label as holder_label, c.name as holder_court, ${terminalHolderCols()}
      from fixture_stream_sessions s
      join org_stream_targets t on t.id = s.target_id
      left join fixtures f on f.id = s.fixture_id
      left join courts c on c.id = f.court_id
      ${terminalHolderJoins()}
     where s.org_id = ${orgId} and (s.fixture_id = ${fixtureId} or (s.target_id = ${targetId} and ${pastedTarget(orgId, targetId)}))
       and s.state in ${sql([...TERMINAL_STATES])}   -- R2004: either mode holds an output (composed's on its programme input)
       and s.output_uid is not null and s.output_released_at is null
     order by s.created_at`;
  for (const p of prior) {
    if (await releaseOutput(p.id, "admission", deps)) continue;
    if (p.fixture_id !== fixtureId) {
      log.warn({ sid: p.id, fixtureId, holderFixtureId: p.fixture_id, targetId }, "stream session: another fixture's ended session may still be broadcasting on this destination and its output release failed — start refused");
      return { sameFixture: null, otherFixture: terminalHolder(p) };
    }
    log.warn({ sid: p.id, fixtureId }, "stream session: this fixture's previous session may still be broadcasting and its output release failed — start refused");
    return { sameFixture: p.id, otherFixture: null };
  }
  return { sameFixture: null, otherFixture: null };
}

/** The `target_in_use` refusal, ONE shape for every holder — an active session (`targetHolderFor`) and another fixture's
 *  ENDED session whose still-listed Machine (I1) or unreleased output (C1) admission could not take down. `code` is what
 *  the client acts on (Task 13's `CreateErrorCode`). The MESSAGE names the holder because "in use" alone sends an
 *  organiser hunting; it is the operator's line in the log and in Sentry. The client never renders `err.message`: it
 *  renders the dictionary copy from the machine-readable `extra` `{ holder }` (Task 11's controller ruling, widened by
 *  T3 to the match). SAME-ORG BY CONSTRUCTION: every producer reads only the caller's org (`holderRows`:
 *  `t.org_id = $org`; `tearDownPriorMachines` / `releasePriorOutputs`: `org_id = $org`), and a session can only
 *  reference a target `admit` proved is the org's — so the extra never names another organisation's fixture. The
 *  holder's SESSION id is deliberately not in it (`wireHolder`): nothing a client does with it.
 *  An ACTIVE holder comes from `holderRows`; a TERMINAL one is built by `terminalHolder` below. */
type Holder = Pick<TargetHolder, "sessionId" | "label" | "courtName" | "fixtureId" | "href" | "matchNo" | "state">;

/** T3 (spec §5.5): the extra is `wireHolder`'s — the SAME shape the Directory's `TARGET_IN_USE` sends — so the client
 *  names the match (`matchNo`, rendered through the locale's own breadcrumb.match), links its page (`href`) and says
 *  whether a phone is live or awaited (`state`). The message is the operator's line: the match when it has a number,
 *  else the court, else the fixture id. */
export function targetInUse(h: Holder): HttpError {
  const where = h.matchNo !== null ? `match ${h.matchNo}` : h.courtName ? `court ${h.courtName}` : `fixture ${h.fixtureId ?? "(deleted)"}`;
  return new HttpError(
    409,
    `the destination "${h.label}" is already streaming for ${where}${h.matchNo !== null && h.courtName ? ` (court ${h.courtName})` : ""}`,
    "target_in_use",
    { holder: wireHolder(h) },
  );
}

/** The terminal holder's extra columns — the holder fixture's number and the slugs of its organiser page — read through
 *  the same left joins `holderRows` uses (a deleted fixture leaves them all null). */
interface TerminalHolderRow {
  holder_label: string; holder_court: string | null;
  fixture_no: number | null; org_slug: string | null; comp_slug: string | null; div_slug: string | null;
}
const terminalHolderCols = () => sql`f.fixture_no, o.slug as org_slug, comp.slug as comp_slug, d.slug as div_slug`;
const terminalHolderJoins = () => sql`
      left join divisions d on d.id = f.division_id
      left join competitions comp on comp.id = d.competition_id
      left join organizations o on o.id = comp.org_id`;

/** An ENDED session whose Machine (`tearDownPriorMachines`) or output (`releasePriorOutputs`) may still be on air. It
 *  reads `live`: to a person, the destination is still receiving from that match, whatever the row's state says. */
function terminalHolder(r: TerminalHolderRow & { id: string; fixture_id: string | null }): Holder {
  return {
    sessionId: r.id, label: r.holder_label, courtName: r.holder_court, fixtureId: r.fixture_id, matchNo: r.fixture_no,
    href: holderHref(r), state: "live",
  };
}

/** D2 — before Replace key or Remove reads "held", each current holder of the target gets its lazy expiry, the tick
 *  Go live's `targetHolderFor` already gives it: a session stuck past its deadline must not refuse a Remove forever.
 *  Outside any transaction (expiry may call the provider). Called by the stream-targets [targetId] route.
 *
 *  M-3 (final review): `targetId: null` ticks every holder of the ORG's destinations — the Directory's Streaming tab,
 *  before it lists them. Its "In use" lock disables exactly the Replace and Remove buttons whose routes tick a single
 *  target, so an abandoned Go live otherwise kept the lock up until someone opened that match or the daily sweep ran.
 *  A holder that is not due is untouched (applyExpiry reads it and finds nothing to do).
 *
 *  B0 (R-3's routed item, 2026-10-01): EACH holder is best-effort. A tick that throws — a provider failure recordEffect
 *  rethrows, or the apply's own write — is reported (captureError, route relay.expire_target_holders) and the loop goes
 *  on; it used to end the loop, so every LATER holder kept its lock until the next load. The answer names what the
 *  tick did: `expired` — the holders it left no longer holding the destination (a terminal state); `failed` — the holders
 *  whose tick threw and that STILL hold it. A holder that was not due is in neither.
 *
 *  B0 fix round 1 (m-2): a throw is classified by what COMMITTED, not by the throw. `apply` commits the decision before
 *  `runEffects`, so an effect that throws after commit (a post-completion `fill_replay` recordEffect rethrows) leaves the
 *  holder terminal — `expired`, and still reported. The row is re-read to tell; a re-read that itself fails says nothing
 *  about what committed, so the holder stays `failed`. */
export async function expireTargetHolders(orgId: string, targetId: string | null, deps: SessionDeps): Promise<{ expired: string[]; failed: string[] }> {
  const expired: string[] = [];
  const failed: string[] = [];
  for (const h of await holderRows(sql, targetId === null ? { orgId } : { orgId, targetId })) {
    try {
      const after = await applyExpiry(h.sessionId, deps);
      if (after && isTerminal(after.state)) expired.push(h.sessionId);
    } catch (err) {
      captureError(err, { orgId, route: "relay.expire_target_holders", extra: { sessionId: h.sessionId, targetId } });
      const now = await readRow(h.sessionId).catch(() => null);
      (now && isTerminal(now.state) ? expired : failed).push(h.sessionId);
    }
  }
  return { expired, failed };
}
