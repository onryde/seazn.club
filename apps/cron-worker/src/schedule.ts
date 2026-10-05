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
  | { kind: "daily"; hourUtc: number } // hourly trigger only
  | { kind: "weekly"; weekdayUtc: number; hourUtc: number }; // hourly trigger only

export interface Job {
  id: string;
  /** Route on the Next app, POSTed with `x-cron-secret`. */
  path: string;
  /** The cron expression of the Worker trigger that fires this row (R4). */
  trigger: string;
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

/** Capture QR v2 §6.11 (W22): stream-tick's own trigger. With the hourly one, 2 per env, 4 of the Free plan's 5. */
export const STREAM_TICK_CRON = "*/5 * * * *";

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
  { id: "relay-sweep", path: "/api/cron/relay-sweep", trigger: TRIGGER_CRON, due: { kind: "daily", hourUtc: 4 }, retry: false, manual: true },
  {
    id: "billing-quantity",
    path: "/api/cron/billing-quantity",
    trigger: TRIGGER_CRON,
    due: { kind: "daily", hourUtc: 6 },
    retry: true,
    manual: true,
    // addonPrices.mismatched, NOT .alerted (I-4): `alerted` only increments inside
    // `if (process.env.STAFF_ALERT_EMAIL)` (billing-events.ts, sweepStaleOrgAddonPrices), so it
    // stays 0 on an environment without that variable while a stale rider price persists.
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
  // still ended (ask 10, W19). Never retried: its next firing, 5 minutes later, IS the retry, and a re-send could
  // overlap a pass still running server-side. `failed` counts sessions whose tick threw; `deferred` (the budget ran
  // out) is not a failure, because the next firing reaches them.
  {
    id: "stream-tick",
    path: "/api/cron/stream-tick",
    trigger: STREAM_TICK_CRON,
    due: { kind: "every" },
    retry: false,
    manual: true,
    failureCounts: ["data.failed"],
  },
];

/** Every distinct trigger the table uses: what wrangler.json must register. */
export function triggersOf(jobs: readonly Job[] = JOBS): string[] {
  return [...new Set(jobs.map((j) => j.trigger))];
}

function isDue(due: Due, t: Date): boolean {
  switch (due.kind) {
    case "every":
      return true;
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
 * Only the two shapes the table uses are understood: the hourly trigger (every firing is its hour's first) and
 * `*\/N * * * *` with N in 1..59. Any other shape is refused by name, never guessed: a wrong answer here is either
 * an alert storm or a silent hour.
 */
export function firstSlotOfHour(trigger: string, t: Date): boolean {
  if (trigger === TRIGGER_CRON) return true;
  const m = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(trigger);
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= 1 && n <= 59)) throw new Error(`firstSlotOfHour: cannot judge trigger ${JSON.stringify(trigger)}`);
  return t.getUTCMinutes() < n;
}

/** The rows one firing runs, in table order. The firing TRIGGER picks the
 *  candidate rows (R4); the SCHEDULED time picks the slot, so a late
 *  invocation still runs its own slot's jobs. */
export function dueJobs(scheduledTime: Date, cron: string, jobs: readonly Job[] = JOBS): Job[] {
  return jobs.filter((j) => j.trigger === cron && isDue(j.due, scheduledTime));
}
