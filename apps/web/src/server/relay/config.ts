// server/relay/config.ts — the ONE authority for every relay number (§9a "one
// authority per fact"). Nothing under server/relay, server/usecases/stream-*,
// or the panel types a relay constant of its own; a change here moves every
// test with it. Each value names what measured it.

/** Cloudflare `recording.timeoutSeconds` — a RECORDING setting: it governs when
 *  a disconnect starts a NEW recorded video, and R0 §4a measured that it ALSO
 *  governs the playback hold (hold = timeoutSeconds + ~3 s on RTMPS). 180 is
 *  the value R0's two cells ran; at 180 no EXT-X-ENDLIST is ever emitted, so
 *  nothing in this wave treats ENDLIST as end-of-stream (C8). */
export const INGEST_TIMEOUT_SECONDS = 180;
/** R0 §4a: 182.8 s and 183.5 s against a configured 180; 12.2 s at 10; 63.1 s at 60. */
export const HOLD_SLACK_SECONDS = 3;

/** C1: Cloudflare rejects 1 and 7 with HTTP 400 code 10060; the valid range is
 *  30–1096 days. The product's 3-day promise is OUR sweep (RECORDING_RETENTION_DAYS). */
export const DELETE_RECORDING_AFTER_DAYS = 30;
export const CLOUDFLARE_RETENTION_RANGE = { min: 30, max: 1096 } as const;
/** Owner ruling 2026-09-12: the 3-day promise is enforced by our own scheduled
 *  DELETE of VIDEOS (never inputs — `deleteInput` leaks recordings, C2). */
export const RECORDING_RETENTION_DAYS = 3;

/** C7 / owner ruling 2026-09-13: performance-4x / 8 GB. `cpuClass` is the
 *  port's vocabulary; runner-fly.ts maps "dedicated" → cpu_kind "performance". */
export const RUNNER_DEFAULT_GUEST = { cpus: 4, memoryMb: 8192, cpuClass: "dedicated" } as const;
export const RUNNER_DEFAULT_REGION = "lhr";

/** Design §6.1 default and ruling E: 5 h. */
export const MAX_DURATION_MINUTES = 300;
/** §6.6: job/page tokens expire at max_duration + 30 min. */
export const TOKEN_GRACE_MINUTES = 30;
/** §6.4: warming > 10 min → failed(no_inbound_timeout). */
export const WARMING_TIMEOUT_MINUTES = 10;
/** Every non-terminal state owes a timed exit (F16): a session stranded in `provisioning` — a process that
 *  died between the create call returning and `provisioned` being applied — has no other way out, and its
 *  Machine retries the internal heartbeat route forever. Sized ABOVE Task 5A's create budget (client
 *  timeout + jittered retries), so a slow-but-working create is never failed, and far below the warming
 *  timeout it hands over to.
 *
 *  DERIVED against the COMPOSED provisioning path, Task 5, 2026-09-20 — RAISED from 120 to 180. Task 5A
 *  checked 120 against `createMachine` ALONE and it held with 10.5 s to spare; provisioning does not end
 *  at the create, it ends when the Machine is up, so the budget owes create + `waitMachine(started)`. Two
 *  gates recompute the arithmetic from `fly-client.ts`'s exported `FLY_CLIENT_DEFAULTS` rather than trusting
 *  this comment (review I5; failure class 20 — a flat budget beside a derived cost is a latent red):
 *  fly-client.test.ts's "the provisioning budget HOLDS…" for the create term, and runner-fly.test.ts's
 *  "create + waitMachine(started) fits inside PROVISION_TIMEOUT_SECONDS…" for the composed one. By
 *  `fly-client.ts`'s own option names at their defaults:
 *    one attempt              = `requestTimeoutMs`                     = 10 s
 *    the jittered ladder      = Σ min(`maxBackoffMs`, `baseBackoffMs` × 2^(n−1)), n = 1…`maxAttempts`−1
 *                             ≤ 0.5 + 1 + 2                            = 3.5 s
 *    all attempts             = `maxAttempts` × `requestTimeoutMs` + ladder = 43.5 s   ← also `listMachines`
 *    `deadlineMs` gates only the decision to SLEEP, so an operation overruns it by whatever is still in
 *    flight; `createMachine` pays a NESTED `listMachines` (the T5-a/T5-b lookup) after every ambiguous
 *    attempt, and on the LAST attempt an empty lookup costs `lookupSettleMs` plus ONE single-attempt
 *    confirming re-list (review I6):
 *      create worst = `deadlineMs` + `requestTimeoutMs` + 43.5 s + `lookupSettleMs` + `requestTimeoutMs`
 *                   = 45 + 10 + 43.5 + 1 + 10                          = 109.5 s
 *    The wait is a SECOND operation with its own deadline and no nested lookup, so it overruns by one
 *    in-flight attempt only:
 *      wait worst   = `deadlineMs` + `requestTimeoutMs` = 45 + 10       = 55 s
 *      composed     = 109.5 + 55                                       = 164.5 s   (> the old 120)
 *      + one whole `requestTimeoutMs` of slack (brief 5b(b))           = 174.5 s
 *    rounded up to the next round ten                                  = 180 s, leaving 15.5 s of headroom.
 *    SIZING THE WAIT (carry T5-e, owed by this task): `/wait` is a LONG POLL and `requestTimeoutMs` bounds
 *    each attempt independently, so the `timeoutSeconds` a caller asks Fly to hold the connection for must
 *    be STRICTLY LESS than `requestTimeoutMs`, or our own AbortSignal fires first and a healthy wait reads
 *    as a timeout. `waitMachine`'s parameter default is 60 s and Fly caps it there (90 → HTTP 400,
 *    measured 2026-09-20) — 60 s does NOT fit a 10 s request budget, so no caller may use the two defaults
 *    together; a caller needing longer loops shorter waits. runner-fly.test.ts drives both halves of that.
 *    Task 5 lands no wait — `RunnerProvider` has no wait method — so this budget is PROTECTIVE: it is
 *    already right for the task (10) that composes them.
 *  The 429 `Retry-After` path cannot extend that: the wait is honoured verbatim, but the same pre-sleep gate
 *  refuses any wait ending past `deadlineMs` and raises `code: "deadline"` instead of sleeping.
 *  MEASURED live 2026-09-20, against the real Fly API in lhr on a shared-cpu-1x: create returned in
 *  1,123 ms and create→`started` was 2,846 ms — three orders below the budget this bounds. */
export const PROVISION_TIMEOUT_SECONDS = 180;
/** F18, the same rule at the other end: a session that was inserted and never admitted. Nothing has been
 *  asked of any provider yet, so the exit is a plain failure and the window only has to outlast the
 *  admission transaction. CHECKED 2026-09-20 (Task 5A, brief step 5b(c)): no part of the create budget above
 *  sits inside the admission path — admission makes no provider call at all, and `fly-client.ts` is reached
 *  only from the runner adapter, which Task 5 calls AFTER admission has committed. Unchanged at 60.
 *  RE-CHECKED 2026-09-20 (Task 5) when the composed create + wait budget raised PROVISION_TIMEOUT_SECONDS:
 *  that path is entirely downstream of admission, so nothing moved here. Unchanged at 60. */
export const REQUESTED_TIMEOUT_SECONDS = 60;
/** F19: an `ending` session whose completion was lost — a passthrough whose `complete_now` effect never ran,
 *  or a composed one whose runner carries no stop mark (the stop grace only times a MARKED runner). Measured
 *  from `ending_at` (F22 — the instant ending BEGAN), falling back to `deadlineOf` when that write was lost,
 *  so an early stop is timed from the stop and not from its original booking. Well above RUNNER_STOP_GRACE_SECONDS +
 *  RUNNER_OBSERVE_SLACK_SECONDS so it never pre-empts the ordinary teardown.
 *  CHECKED 2026-09-20 (Task 5A) against the same client constants — 300 HOLDS, unchanged. Neither
 *  `stopMachine` nor `destroyMachine` performs the nested lookup `createMachine` does, so each is bounded by
 *  `deadlineMs` + `requestTimeoutMs` = 55 s; the worst ordinary teardown is
 *  RUNNER_STOP_GRACE_SECONDS + RUNNER_OBSERVE_SLACK_SECONDS + stop 55 s + destroy 55 s = 140 s < 300 s.
 *  RE-CHECKED 2026-09-20 (Task 5) against the SAME composed reasoning that raised PROVISION_TIMEOUT_SECONDS:
 *  a teardown that also waits (`waitMachine(destroyed)` — C1 measured that a destroyed Machine still GETs
 *  200 `destroyed` and that `destroying` can follow the wait, so a task may well want one) adds one more
 *  55 s operation: 30 + 55 + 55 + 55 = 195 s < 300 s. Unchanged at 300, and runner-fly.test.ts asserts that
 *  composed teardown term from `FLY_CLIENT_DEFAULTS` so it moves when a client constant does. */
export const ENDING_TIMEOUT_SECONDS = 300;
/** §6.4: a live COMPOSED session whose heartbeat is older than this gets ONE retry. */
export const STALE_HEARTBEAT_SECONDS = 90;
/** §7.2 + R0-memo.md:279: SIGINT → ffmpeg exit 0 in 114 ms; the supervisor's
 *  flush budget is ≤ 10 s. Sent as the Fly stop `timeout` (seconds before SIGKILL). */
export const RUNNER_STOP_GRACE_SECONDS = 10;
/** How long after the grace we wait to OBSERVE auto_destroy before forcing it. */
export const RUNNER_OBSERVE_SLACK_SECONDS = 20;
/** Design §6.4: ONE retry — two attempts, ever. Invariant 3's bound derives from this. */
export const RUNNER_MAX_ATTEMPTS = 2;
/** R0-memo.md:346–354: `q` on stdin is discarded under -nostdin; the stop is a SIGNAL. */
export const RUNNER_STOP_SIGNAL = "SIGINT" as const;
/** §5.2: a consume row for the same fixture within 24 h → no second consume. */
export const CREDIT_REUSE_HOURS = 24;
/** §9.1: SRT buffer 1.5–2.5 s, pinned; carried in the QR payload as latencyMs. */
export const SRT_LATENCY_MS = 2000;
/** Ruling R-A / C14: a discriminator the phone obeys; asserts NOTHING about
 *  which leg is production primary — R3 rules that, and this is the config line. */
export const QR_PREFERRED_DEFAULT: "srt" | "rtmps" = "srt";
/** C9: simulcast outputs bill as delivery; Cloudflare caps 5 per input. */
export const MAX_OUTPUTS_PER_INPUT = 5;

/** Ruling 13 (capture everything) has one cost line: fixture_stream_samples.
 *  5 h (MAX_DURATION_MINUTES) at one heartbeat AND one poll every 5 s is 7,200
 *  rows; the cap sits above that so a legitimate session never hits it, and a
 *  runaway client (a poll loop at 100 ms) cannot write 180,000. The writer
 *  returns "capped" and the usecase records ONE `samples_capped` event. */
export const SAMPLES_PER_SESSION_CAP = 8000;
/** RULED by the owner at Task 0 ("2 is ok"; plan §"Data captured"): the daily
 *  sweep (Task 12) deletes raw samples older than this, and ONLY for sessions
 *  whose `sample_summary` is already written — an unsummarised session keeps
 *  every sample (C15). The aggregate on the session row is kept regardless. */
export const SAMPLE_RETENTION_DAYS = 90;
/** Longest string a sanitised payload keeps; longer values are cut, so a
 *  pasted body or a stack trace cannot become a row. */
export const EVENT_PAYLOAD_MAX_STRING = 200;

/** Da (Task 0 data ruling): the build that wrote a capture row. Fly sets
 *  FLY_IMAGE_REF on every Machine (its runtime-environment docs list it), and
 *  prod.yml / stg.yml deploy `--image registry.fly.io/<app>:${{ github.sha }}`,
 *  so the tag IS the commit. Any other tag (a `deployment-01H…` build id) or an
 *  unset var (local, CI) is null — never a guess. */
export function buildShaOf(imageRef: string | undefined): string | null {
  if (!imageRef) return null;
  const tag = imageRef.slice(imageRef.lastIndexOf(":") + 1);
  return /^[0-9a-f]{40}$/.test(tag) ? tag : null;
}
/** Read ONCE at module load; telemetry.ts stamps it on every event and sample row. */
export const APP_BUILD_SHA: string | null = buildShaOf(process.env.FLY_IMAGE_REF);

/** Df (Task 0 data ruling): list-price rates for the provider cost ESTIMATE
 *  Task 10 writes once at a session's terminal transition (`est_cost_minor`, in
 *  minor units of EST_COST_CURRENCY) from the session's own `recording_seconds`,
 *  `machine_seconds` and guest. An estimate, never an invoice. Rates are integer
 *  MICRO-units (1e-6 of the currency) so the arithmetic stays exact until the
 *  one final round to cents. Each pricing page below was OPENED on 2026-09-16
 *  before its number was written; where the plan's snapshot disagreed, the page
 *  won, and the comment says so. */
export const EST_COST_CURRENCY = "usd";
/** https://developers.cloudflare.com/stream/pricing/ — read 2026-09-16: "Storage
 *  is a prepaid pricing dimension purchased in increments of $5 per month for
 *  each 1,000 minutes of video storage capacity." Agrees with the plan snapshot. */
export const CLOUDFLARE_STORED_MICROS_PER_MINUTE = 5_000;
/** https://developers.cloudflare.com/stream/pricing/ — read 2026-09-16: "billed at
 *  $1 per 1,000 minutes delivered." Agrees with the plan snapshot. */
export const CLOUDFLARE_DELIVERED_MICROS_PER_MINUTE = 1_000;
/** https://fly.io/docs/about/pricing/ — read 2026-09-16, "Started Fly Machines",
 *  the markup-1.0 region (iad/ewr): performance-1x (1 performance CPU, 2GB)
 *  $31.00/month, $0.00001196/second; performance-4x (4, 8GB) $124.00/month. The
 *  preset price INCLUDES 2 GB per performance CPU, and the page prices every
 *  region as this base times a markup (its `regionMarkups`: "lhr": 1.134615385,
 *  so lhr performance-4x/8GB is $140.69/month, $0.00005428/second).
 *  These rates exist for RUNNER_DEFAULT_GUEST's class ("dedicated" → performance)
 *  ONLY: a guest of any other class gets est_cost_minor null, never a borrowed rate. */
export const FLY_PERFORMANCE_CPU_MICROS_PER_MONTH = 31_000_000;
/** Same page, read 2026-09-16: "plus about $5 per 30 days per GB of additional
 *  RAM" (iad performance-1x at 4GB is $41.01 against $31.00 at 2GB). ADDITIONAL
 *  RAM only — above the preset's 2 GB per CPU. The plan snapshot said $5.34; the
 *  page wins. */
export const FLY_RAM_MICROS_PER_GB_MONTH = 5_000_000;
/** Same page, read 2026-09-16: prices are "per 30 days", and $31.00/month ↔
 *  $0.00001196/second reproduces only with a 30-day month (2,592,000 s). The plan
 *  snapshot used a 730-hour month (R0-memo.md's $0.0000317/s for
 *  performance-2x/4 GB); the page now lists performance-2x/4GB at $0.00002392/s
 *  (iad) and wins. */
export const FLY_BILLING_SECONDS_PER_MONTH = 30 * 24 * 3600;

/** `RELAY_DRIVERS=fake|live`. Unset is `fake`: a process that has not been
 *  told it may spend money does not. A production deploy sets `live`. */
export function relayDriverMode(): "fake" | "live" {
  const v = process.env.RELAY_DRIVERS;
  if (v === "live") return "live";
  if (v === "fake" || v === undefined || v === "") return "fake";
  throw new Error(`RELAY_DRIVERS must be "fake" or "live", got ${JSON.stringify(v)}`);
}
