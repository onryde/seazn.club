/**
 * The ONE place a scheduled job is declared. Each row names the Worker trigger
 * that fires it (`trigger`, mirrored in wrangler.json and pinned by
 * test/drift.test.ts) and when, among that trigger's firings, it is due.
 * `dueJobs` picks the rows for one firing. Times are UTC.
 *
 * Adding a job is one row here. If it brings a new trigger, add that cron to
 * both envs in wrangler.json; the drift test forces it. No other Worker code
 * changes (R4).
 * Spec: docs/superpowers/specs/2026-09-28-cloudflare-cron-triggers-design.md §4, §13.
 */
export type Due =
  | { kind: "every" } // every firing of the row's own trigger
  | { kind: "minuteMod"; every: number } // firings whose SCHEDULED minute is a multiple of `every` (a slower job on a faster trigger)
  | { kind: "daily"; hourUtc: number } // hourly trigger only
  | { kind: "weekly"; weekdayUtc: number; hourUtc: number }; // hourly trigger only

/** The environments the Worker is deployed to: wrangler.json's `env` keys, and the Worker's `ENV_NAME` var. */
export type EnvName = "stg" | "prod";

export interface Job {
  id: string;
  /** Route on the Next app, POSTed with `x-cron-secret`. */
  path: string;
  /** The cron expression of the Worker trigger that fires this row (R4): one string for a row that is the same in every
   *  env, or one per env for a row that rides an env's fast trigger (`FAST_TRIGGER`). Read it through `triggerFor`. */
  trigger: string | Readonly<Record<EnvName, string>>;
  due: Due;
  /** Safe to re-send after a 502/503/504 or a network error (the route is idempotent). */
  retry: boolean;
  /** May be run on demand through the Worker's `POST /run?job=`. */
  manual: boolean;
  /**
   * R3 (owner 2026-10-01): dotted paths into the route's 200 JSON body that
   * count failures. One above 0, or one that cannot be read, makes the run
   * `degraded`: never ok, and one Sentry error event.
   */
  failureCounts?: readonly string[];
}

/** The hourly trigger. Daily and weekly rows hang off it, and it alone runs the inactive probe. */
export const TRIGGER_CRON = "17 * * * *";

/** Capture QR v2 §6.11 (W22): stream-tick's own trigger. With the hourly one, 2 per env, 4 of the Free plan's 5.
 *  The external-play sweep (chess in-page design §4) shares it: same cadence, no new trigger. Since the email outbox
 *  (owner ruling 2026-10-20) it is STG's fast trigger; prod's is `MINUTE_CRON`. The stream tick runs on EVERY firing of
 *  its env's fast trigger (YouTube Connect T15), so on stg it is still every 5 minutes. */
export const STREAM_TICK_CRON = "*/5 * * * *";

/** Every minute. Prod's one fast trigger: it REPLACES `*\/5` there (still 2 triggers per env, 4 of the Free plan's 5),
 *  so the stream tick and the email outbox's worker run every minute on prod, and the one 5-minute job left (the
 *  external-play sweep) rides it on its `minuteMod` firings. */
export const MINUTE_CRON = "* * * * *";

/** The 5-minute job's period, in minutes: the external-play sweep's `minuteMod` on a faster trigger, and the cadence stg's
 *  `*\/5` fires at. */
export const FIVE_MINUTES = 5;

/** The ONE fast trigger per env. Prod's replaces `*\/5`; stg keeps it (stg is `min_machines_running = 0`, and a minute
 *  trigger would keep it awake all day), so the outbox and the stream tick run there on the existing 5-minute tick and add
 *  no wake-up. A broadcast's end on stg can therefore land up to 5 minutes late (owner, YouTube Connect Q1 = b, 2026-10-27). */
export const FAST_TRIGGER: Readonly<Record<EnvName, string>> = { prod: MINUTE_CRON, stg: STREAM_TICK_CRON };

export const JOBS: readonly Job[] = [
  { id: "registrations", path: "/api/cron/registrations", trigger: TRIGGER_CRON, due: { kind: "every" }, retry: true, manual: true },
  {
    id: "billing-events",
    path: "/api/cron/billing-events",
    trigger: TRIGGER_CRON,
    due: { kind: "every" },
    retry: true,
    manual: true,
    failureCounts: ["data.failed", "data.alerted"],
  },
  { id: "funnel-remind", path: "/api/funnel/remind", trigger: TRIGGER_CRON, due: { kind: "every" }, retry: true, manual: true },
  { id: "ai-previews", path: "/api/cron/ai-previews", trigger: TRIGGER_CRON, due: { kind: "daily", hourUtc: 3 }, retry: true, manual: true },
  // R1 (owner 2026-10-01): daily 04:17. Never retried: a re-send after a 5xx can
  // overlap a pass still alive server-side, and the sweep's overlap safety
  // (per-session advisory locks) is unproven. A missed day costs nothing,
  // because the sweep owns nothing time-critical (relay-sweep.ts:2-3).
  // YouTube Connect T17 (spec §6.6): the same daily firing runs the daily YouTube pass (channel health, the 25-day video
  // refresh, the 30-day dead-grant purge) before the sweep, on a relay-disabled deployment too. `youtube.failed` counts what
  // did not work this pass (a connection or leg that threw, a refresh batch YouTube could not answer) plus every broadcast
  // the end step can never settle - all retried the next day, or needing a person. A dead grant (`reconnectNeeded`) is the pass
  // WORKING, not failing, so it is not a failure counter. The sweep reports no counter of its own.
  {
    id: "relay-sweep",
    path: "/api/cron/relay-sweep",
    trigger: TRIGGER_CRON,
    due: { kind: "daily", hourUtc: 4 },
    retry: false,
    manual: true,
    failureCounts: ["data.youtube.failed"],
  },
  {
    id: "billing-quantity",
    path: "/api/cron/billing-quantity",
    trigger: TRIGGER_CRON,
    due: { kind: "daily", hourUtc: 6 },
    retry: true,
    manual: true,
    // addonPrices.mismatched, NOT .alerted (I-4): `alerted` only increments inside
    // `if (staffAlertsOn())` (billing-events.ts, sweepStaleOrgAddonPrices: STAFF_ALERT_EMAIL set and
    // not blank), so it stays 0 on an environment without that address while a stale rider price persists.
    failureCounts: ["data.failed", "data.orphanGroups.failed", "data.addonPrices.mismatched"],
  },
  {
    id: "billing-grant",
    path: "/api/cron/billing-grant",
    trigger: TRIGGER_CRON,
    due: { kind: "daily", hourUtc: 7 },
    retry: true,
    manual: true,
    failureCounts: ["data.failed"],
  },
  // NOT idempotent by design (P3/D7): never retried. A manual run IS allowed
  // (R2): the cron_week guard (org-posts.ts, V429) lets it fill only the orgs
  // still missing this ISO week's cron digest.
  {
    id: "news-digest",
    path: "/api/cron/news-digest",
    trigger: TRIGGER_CRON,
    due: { kind: "weekly", weekdayUtc: 1, hourUtc: 8 },
    retry: false,
    manual: true,
  },
  // Capture QR v2 T7b (§6.11, W22): ticks every open stream session so a phone that dies with no panel open is
  // still ended (ask 10, W19). YouTube Connect T15 (spec §6.7): the same firing first ENDS the YouTube broadcasts that
  // are due (the route runs the end step before the session pass), so this row is due on EVERY firing of the env's fast
  // trigger: every minute on prod, every 5 minutes on stg (owner Q1 = b: a minute trigger would keep stg awake all day,
  // so there a broadcast's end can land up to 5 minutes late). Never retried: its next firing, a minute (stg: 5) later,
  // IS the retry, and a re-send could overlap a pass still running server-side. `failed` counts sessions whose tick
  // threw; `youtube.failed` counts broadcasts whose end failed this pass (they back off and are retried). `deferred`
  // (a budget ran out) is not a failure in either, because the next firing reaches them.
  {
    id: "stream-tick",
    path: "/api/cron/stream-tick",
    trigger: FAST_TRIGGER,
    due: { kind: "every" },
    retry: false,
    manual: true,
    failureCounts: ["data.failed", "data.youtube.failed"],
  },
  // Chess in-page board design §4: "The 5-minute cron … is NOT optional". One pass of the external-play sweep: the
  // deadline no-show, the mint retry after a 429, meeting teardown, the reconcile of every game on file, camera evidence
  // and ending arbiter watches. Every one of them happens when no page is open, so without this row none of them runs.
  // Never retried: the next firing, 5 minutes later, IS the retry, and the sweep's pass lock answers an overlapping
  // re-send with `skipped`. Final review I-1: SweepReport.failed (fixtures whose action threw) and .skipped (1 when
  // another pass held the lock — a pass that overlaps the next firing ran for five minutes) are both failures.
  // `deferred` is not: a budget ran out (the pass's, or reconcile's own slice of it) or the per-pass cap on settling
  // reads was reached (D20), and the next firing reaches the rest — one counter for all three causes.
  {
    id: "external-play",
    path: "/api/cron/external-play",
    trigger: FAST_TRIGGER,
    due: { kind: "minuteMod", every: FIVE_MINUTES },
    retry: false,
    manual: true,
    failureCounts: ["data.failed", "data.skipped"],
  },
  // Email outbox, phase 1 (spec 2026-10-19-email-outbox-design.md, "The retry worker"): one tick of the retry worker, on
  // EVERY firing of the env's fast trigger: every minute on prod, every 5 minutes on stg (owner ruling 2026-10-20). Never
  // retried: the next firing IS the retry, and skip-locked claims plus the lease make an overlapping re-send safe.
  // `failed` counts rows whose attempt threw in our own code, and a tick that could not run at all (the database role
  // cannot write the outbox); `deferred` (rows still due when the batch or the budget ran out) is not a failure, because
  // the next firing reaches them.
  {
    id: "email-outbox",
    path: "/api/cron/email-outbox",
    trigger: FAST_TRIGGER,
    due: { kind: "every" },
    retry: false,
    manual: true,
    failureCounts: ["data.failed"],
  },
];

/** The cron expression that fires `job` in `env`. A per-env row names every deployed env; an env it does not name is a
 *  table or config error and is refused BY NAME, never guessed (an `Object.prototype` member is not an env either). */
export function triggerFor(job: Job, env: string): string {
  if (typeof job.trigger === "string") return job.trigger;
  if (!Object.hasOwn(job.trigger, env)) throw new Error(`triggerFor: no trigger for env ${JSON.stringify(env)} on job ${job.id}`);
  return job.trigger[env as EnvName];
}

/** Every distinct trigger the table uses in `env`: what that env's wrangler.json entry must register. */
export function triggersOf(env: string, jobs: readonly Job[] = JOBS): string[] {
  return [...new Set(jobs.map((j) => triggerFor(j, env)))];
}

function isDue(due: Due, t: Date): boolean {
  switch (due.kind) {
    case "every":
      return true;
    case "minuteMod":
      // A period that is not a whole number of minutes would make the row silently never due (`x % 0` is NaN): refuse it.
      if (!Number.isInteger(due.every) || due.every < 1 || due.every > 59) {
        throw new Error(`dueJobs: minuteMod every must be a whole number of minutes from 1 to 59, got ${due.every}`);
      }
      return t.getUTCMinutes() % due.every === 0;
    case "daily":
      return t.getUTCHours() === due.hourUtc;
    case "weekly":
      return t.getUTCDay() === due.weekdayUtc && t.getUTCHours() === due.hourUtc;
  }
}

/**
 * R2 (option S, controller 2026-10-01): is `t` the FIRST firing of `trigger` in its UTC hour? A job that keeps
 * failing on a fast trigger raises one Sentry event per hour, from this slot only; the others log
 * `sentryThrottled`. Keyed on the SCHEDULED time, like `dueJobs`, so a late invocation is judged by its own slot.
 * Only the shapes the table uses are understood: the hourly trigger (every firing is its hour's first), the minute
 * trigger (`* * * * *`: only the :00 slot is) and `*\/N * * * *` with N in 1..59. Any other shape is refused by name,
 * never guessed: a wrong answer here is either an alert storm or a silent hour.
 */
export function firstSlotOfHour(trigger: string, t: Date): boolean {
  if (trigger === TRIGGER_CRON) return true;
  if (trigger === MINUTE_CRON) return t.getUTCMinutes() === 0;
  const m = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(trigger);
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= 1 && n <= 59)) throw new Error(`firstSlotOfHour: cannot judge trigger ${JSON.stringify(trigger)}`);
  return t.getUTCMinutes() < n;
}

/** The rows one firing runs, in table order. The firing TRIGGER, read in the Worker's `env`, picks the candidate rows
 *  (R4); the SCHEDULED time picks the slot, so a late invocation still runs its own slot's jobs. */
export function dueJobs(scheduledTime: Date, cron: string, env: string, jobs: readonly Job[] = JOBS): Job[] {
  return jobs.filter((j) => triggerFor(j, env) === cron && isDue(j.due, scheduledTime));
}
