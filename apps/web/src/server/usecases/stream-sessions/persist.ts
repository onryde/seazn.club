import "server-only";
// Persisting a transition: the aggregate, the facts it made true, the cost estimate (see ./index.ts).
import type { Tx } from "@/lib/db";
import {
  CLOUDFLARE_STORED_MICROS_PER_MINUTE,
  EST_COST_CURRENCY,
  FLY_BILLING_SECONDS_PER_MONTH,
  FLY_PERFORMANCE_CPU_MICROS_PER_MONTH,
  FLY_PERFORMANCE_INCLUDED_GB_PER_CPU,
  FLY_RAM_MICROS_PER_GB_MONTH,
  RUNNER_DEFAULT_GUEST,
  RUNNER_DEFAULT_REGION,
} from "@/server/relay/config";
import { isTerminal, type Command, type Session } from "@/server/relay/domain/session";
import { closeOpenAirings } from "@/server/sponsors/airings";
import { log } from "@/server/logger";
import { captureError } from "@/lib/sentry";

/** Persists the aggregate INCLUDING the runner sub-state — invariant 4: the
 *  intended name/attempt land here, in the same transaction as `creating`,
 *  BEFORE the create call runs (runEffects runs after commit). `lastExit` is
 *  written to V410's three runner_exit_* columns (A5) — the beat route writes
 *  last_heartbeat, so an exit kept there did not survive the next beat.
 *
 *  `state`, `end_reason` and `ending_at` move in ONE statement, and that is a
 *  correctness requirement, not tidiness: the DDL carries
 *  `fixture_stream_sessions_end_reason_state` (end_reason is null or state in
 *  ('ending','completed')), so splitting them into two UPDATEs makes the
 *  intermediate row violate the CHECK and the write fails 23514. Writing
 *  `ending_at` here is also what makes it the SAME instant as the transition —
 *  a later `update … set ending_at = now()` would anchor the backstop a few
 *  milliseconds late and, on a retried effect, move it. */
export async function persist(tx: Tx, s: Session): Promise<void> {
  await tx`
    update fixture_stream_sessions
       set state = ${s.state}, desired_state = ${s.desiredState}, fail_reason = ${s.failReason}, end_reason = ${s.endReason},
           ending_at = ${s.endingAt},
           machine_id = ${s.runner.machineId}, runner_retries = ${s.runnerRetries},
           runner_state = ${s.runner.state}, runner_name = ${s.runner.name}, runner_stop_requested_at = ${s.runner.stopRequestedAt},
           runner_exit_code = ${s.runner.lastExit?.exitCode ?? null}, runner_oom_killed = ${s.runner.lastExit?.oomKilled ?? null},
           runner_requested_stop = ${s.runner.lastExit?.requestedStop ?? null},
           runner_crash_count = ${s.runner.crashes.count}, runner_crash_beats = ${s.runner.crashes.beats},
           runner_crash_exits = ${s.runner.crashes.exits}, runner_crash_exit_at = ${s.runner.crashes.exitAt},
           runner_crash_restart_seen = ${s.runner.crashes.restartSeen},
           runner_restart_count = ${s.runner.crashes.restarts.count}, runner_restart_beats = ${s.runner.crashes.restarts.beats},
           runner_restart_exits = ${s.runner.crashes.restarts.exits}, runner_restart_exit_at = ${s.runner.crashes.restarts.exitAt},
           started_at = ${s.startedAt}, ended_at = ${s.endedAt}, beat_window_at = ${s.beatWindowAt}
     where id = ${s.id}`;
  // G1: beat_window_at IS written — the stale-beat arm and the retry arm move it, and nothing else can persist it.
  // G2 (Task 2C re-review 1): heartbeat_at is NOT written here. The domain never changes heartbeatAt (only a beat
  // does), so this statement could only ECHO the value it loaded; the beat route (`heartbeat`, its bare UPDATE) is
  // the SINGLE writer of the last beat received. `lockRow` holds FOR UPDATE from load to this write, so the echo was
  // harmless today — the single-writer rule is what keeps it harmless if that lock ever narrows.
}

/** Df: the PROVISIONING-cost estimate, in minor units of EST_COST_CURRENCY.
 *
 *  **R1 estimates only what R1 MEASURES.** Two terms, both from columns this
 *  wave actually fills:
 *    • Cloudflare STORAGE, from `recording_seconds`, and
 *    • Fly COMPUTE, from `machine_seconds` × the guest actually booked.
 *
 *  DELIVERY / egress is deliberately NOT estimated. Viewer-minutes have no
 *  source anywhere in R1 — there is no player, no analytics pull, nothing that
 *  counts a watcher — so any multiplier would be a GUESS sitting in a money
 *  column. That is worse than leaving it out: a null reads as "unknown", while a
 *  fabricated integer reads as "measured", and this number will eventually be
 *  compared against a real invoice. `CLOUDFLARE_DELIVERED_MICROS_PER_MINUTE`
 *  therefore has NO consumer in R1; it stays in config.ts for the wave that
 *  ships a player. The test pins this: a session WITH viewers still estimates
 *  storage + compute only.
 *
 *  So: this is a PROVISIONING cost, not total spend, and the column comment,
 *  the `_INDEX.md` row and the organiser-facing wording must all say so.
 *
 *  Rates are integer MICRO-units (1e-6 of the currency) so the arithmetic stays
 *  exact until one final round to minor units (1e6 micros = 1 unit = 100 minor).
 *  A guest class the rates do not cover returns null — never a borrowed rate. */
export function estimateCostMinor(f: {
  recordingSeconds: number; machineSeconds: number;
  guestCpus: number | null; guestMemoryMb: number | null; guestCpuClass: string | null;
}): number | null {
  const storedMicros = (f.recordingSeconds / 60) * CLOUDFLARE_STORED_MICROS_PER_MINUTE;
  let computeMicros = 0;
  if (f.machineSeconds > 0) {
    // A passthrough session books no Machine, so it never reaches here and is storage-only —
    // which is the differential the test uses: passthrough and composed MUST differ.
    if (f.guestCpuClass !== "dedicated" || f.guestCpus === null || f.guestMemoryMb === null) return null;
    const cpu = (f.guestCpus * FLY_PERFORMANCE_CPU_MICROS_PER_MONTH * f.machineSeconds) / FLY_BILLING_SECONDS_PER_MONTH;
    // The preset price includes FLY_PERFORMANCE_INCLUDED_GB_PER_CPU per CPU; only the GB ABOVE it is billed (config.ts).
    const extraGb = Math.max(0, f.guestMemoryMb / 1024 - f.guestCpus * FLY_PERFORMANCE_INCLUDED_GB_PER_CPU);
    const ram = (extraGb * FLY_RAM_MICROS_PER_GB_MONTH * f.machineSeconds) / FLY_BILLING_SECONDS_PER_MONTH;
    computeMicros = cpu + ram;
  }
  return Math.round((storedMicros + computeMicros) / 10_000);
}

/** Ruling 13 item 4: the facts a transition just made true, written beside
 *  the state in the same transaction. Each is `coalesce`d so a repeat never
 *  moves a timestamp. machine_seconds is computed from the events table —
 *  the FIRST `booting` runner_transition AFTER the last `destroyed` one (the
 *  attempt's boot entry), its occurred_at to NOW on entering `destroyed` (each
 *  boot billed once, M2). */
export async function persistFacts(tx: Tx, before: Session, next: Session, cmd: Command, now: Date): Promise<void> {
  if (before.state !== "live" && next.state === "live") {
    await tx`update fixture_stream_sessions set live_at = coalesce(live_at, ${now}) where id = ${next.id}`;
  }
  // A8 (capture QR v2 §5.3): the instant the session ENTERED warming — the warming timeout's anchor (domain/expiry.ts),
  // so provisioning time never eats the phone's pre-flight window. Coalesced like live_at: a repeat never moves it.
  if (before.state !== "warming" && next.state === "warming") {
    await tx`update fixture_stream_sessions set warming_at = coalesce(warming_at, ${now}) where id = ${next.id}`;
  }
  if (cmd.type === "stop") {
    await tx`update fixture_stream_sessions set stop_requested_at = coalesce(stop_requested_at, ${now}) where id = ${next.id}`;
  }
  if (before.runner.state !== "creating" && next.runner.state === "creating") {
    await tx`update fixture_stream_sessions
                set runner_attempts = runner_attempts + 1, machine_region = ${RUNNER_DEFAULT_REGION},
                    guest_cpus = ${RUNNER_DEFAULT_GUEST.cpus}, guest_memory_mb = ${RUNNER_DEFAULT_GUEST.memoryMb}, guest_cpu_class = ${RUNNER_DEFAULT_GUEST.cpuClass}
              where id = ${next.id}`;
    // T10-c (Task 2C review, concern 8): an exit belongs to the attempt that was OBSERVED making it. `createStarted` keeps
    // `lastExit`, so without this a replacement that is lost WITHOUT an exit of its own (a stale beat, never a beat) fails
    // with the PREVIOUS attempt's reason — machine_oom where the plan's failure paths say machine_crash. `persist` above
    // wrote the carried value; the new attempt's intent clears the three exit columns (A5) in the same transaction, so the
    // next load reads null. Witness: "T10-c: a replacement lost by a stale beat fails machine_crash …".
    await tx`update fixture_stream_sessions set runner_exit_code = null, runner_oom_killed = null, runner_requested_stop = null where id = ${next.id}`;
  }
  if (before.runner.state !== "destroyed" && next.runner.state === "destroyed") {
    // M2 (Task 2C re-review 2): a runner can RE-ENTER destroyed with no new boot — fix round 4 takes a destroyed runner
    // through lost on a late create_ok and back on its destroy_ok. Anchoring on "the last booting row" alone added that
    // whole span a second time (and already over-counted an attempt-2 create_failed after attempt 1 booted). Only a boot
    // AFTER the last recorded entry into destroyed is still unbilled. This decision's own rows are written after
    // persistFacts, so the max(seq) below is the PREVIOUS destroyed. Witness: "machine_seconds counts each boot ONCE …".
    // The FIRST booting row past it, never the newest: `decide` writes a runner_transition for every step, same-state ones
    // included, so each look at a booting Machine is a booting→booting row (the ledger keeps them — an observation's
    // payload, R2003b's crashCount). Anchoring on the newest restarted the bill at every look (14591fb90). The window holds
    // ONE attempt (a create starts only from none or destroyed, invariant 1), so its first booting row is that attempt's
    // boot entry — and a ledger written before this fix, self rows and all, reads the same. Witness: "billing: a Machine
    // LOOKED AT N times while booting …".
    const [boot] = await tx<{ occurred_at: string }[]>`
      select b.occurred_at from fixture_stream_events b
       where b.session_id = ${next.id} and b.kind = 'runner_transition' and b.to_state = 'booting'
         and b.seq > coalesce((select max(d.seq) from fixture_stream_events d
                                where d.session_id = ${next.id} and d.kind = 'runner_transition' and d.to_state = 'destroyed'), 0)
       order by b.seq asc limit 1`;
    if (boot) {
      const seconds = Math.max(0, Math.round((now.getTime() - new Date(boot.occurred_at).getTime()) / 1000));
      await tx`update fixture_stream_sessions set machine_seconds = machine_seconds + ${seconds} where id = ${next.id}`;
    }
  }
  // Df: the cost estimate of an ENDED session, recomputed from the row whenever its Machine time can have moved: at the
  // TERMINAL transition, and again when its runner enters destroyed AFTER the end (PR #976 review I1). A session that
  // fails before its Machine is confirmed gone — the crash cap, a refusal, a warming/provision timeout, a credit refusal,
  // relay_disabled — is terminal while its runner is still lost/stopping/exited; the attempt's seconds land on the later
  // destroyed (the C27 cleanup), and an estimate frozen at the terminal transition read 0 Machine time for good (the sweep
  // re-estimates only a session with a recording). So it is an OVERWRITE — never `is null` — from the row read back inside
  // this transaction (the machine_seconds just written above included), through the one formula the sweep also overwrites
  // with: a repeat (a destroyed re-entry with no boot, a sweep before or after) lands on the same value. The STORAGE term
  // is still the sweep's to learn (`recording_seconds`, Task 12 step 5); this reads whatever it has learnt so far.
  const endedNow = !isTerminal(before.state) && isTerminal(next.state);
  // R4 S8 (spec §3.6.4): an airing with no end by session end closes at the last beat received, `ended_estimated`. Once,
  // at the transition that ends the session (every terminal path passes here); in a savepoint, so it never stops an end.
  if (endedNow) {
    try {
      await tx.savepoint((sp) => closeOpenAirings(sp, next.id, before.heartbeatAt ?? now));
    } catch (err) {
      log.error({ sid: next.id, code: (err as { code?: string }).code ?? null, err: String(err) }, "stream session: open sponsor airings were not closed at session end — the session ends anyway");
      captureError(err, { route: "relay.sponsor_airings.close", extra: { sessionId: next.id } });
    }
  }
  const destroyedAfterEnd = isTerminal(before.state) && before.runner.state !== "destroyed" && next.runner.state === "destroyed";
  if (endedNow || destroyedAfterEnd) {
    const [f] = await tx<{ recording_seconds: number; machine_seconds: number; guest_cpus: number | null; guest_memory_mb: number | null; guest_cpu_class: string | null }[]>`
      select recording_seconds, machine_seconds, guest_cpus, guest_memory_mb, guest_cpu_class
        from fixture_stream_sessions where id = ${next.id}`;
    if (f) {
      const minor = estimateCostMinor({
        recordingSeconds: f.recording_seconds, machineSeconds: f.machine_seconds,
        guestCpus: f.guest_cpus, guestMemoryMb: f.guest_memory_mb, guestCpuClass: f.guest_cpu_class,
      });
      if (minor !== null) {
        await tx`update fixture_stream_sessions
                    set est_cost_minor = ${minor}, est_cost_currency = ${EST_COST_CURRENCY}
                  where id = ${next.id}`;
      }
    }
  }
}
