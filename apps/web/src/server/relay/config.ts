// server/relay/config.ts — the ONE authority for every relay number (§9a "one
// authority per fact"). Nothing under server/relay, server/usecases/stream-*,
// or the panel types a relay POLICY number of its own; a change here moves every
// test with it. Each value names what measured it.
//
// Lane-A minors (Task 4 re-review 1, ruled once here for both): "policy number"
// is the boundary, and it is narrower than "constant". A number that expresses
// what the PRODUCT promises — a timeout, a retention, a guest size, a window —
// belongs here, because two spellings of it are two promises. A number that is
// one adapter's own protocol or harness detail, meaningful only inside that file
// and never compared against anything here, stays with its adapter:
//   * `ingest-cf.ts`'s `LIST_VIDEOS_PAGE_LIMIT` — a page size for ONE Cloudflare
//     endpoint, whose real ceiling is still an open Task 17 live-watch item;
//   * `fakes.ts`'s `FAKE_CONNECT_AFTER_MS_DEFAULT` — a test-double's own default,
//     which no production path reads.
// Neither is a promise this file could be the authority for, so moving them here
// would buy nothing and widen this file's blast radius. Recorded rather than
// changed; the header's claim is narrowed to match what it actually governs.

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
 *  1,123 ms and create→`started` was 2,846 ms — three orders below the budget this bounds.
 *  WHICH CLOCK (lane-A minors, Task 5 review M9 — say it, because a future tightening would otherwise be
 *  reasoned from the wrong 180): `expiry.ts` measures `provision_timeout` from `session.createdAt`, NOT
 *  from the instant provisioning began. `REQUESTED_TIMEOUT_SECONDS` runs off that SAME instant, so a
 *  session admitted late starts its create with up to that many seconds already spent — the window really
 *  available to create + wait is `180 − (time spent in requested)`, i.e. as little as 120 s, which the
 *  164.5 s worst case above does NOT fit. It cannot bite today: the measured composed cost is ~4 s and the
 *  worst ever observed is 87 s, both far inside 120. Whoever narrows either constant, or re-anchors
 *  `provision_timeout` to a provisioning-start timestamp, owes this arithmetic again — this is a recorded
 *  premise, not a closed one. */
export const PROVISION_TIMEOUT_SECONDS = 180;
/** F18, the same rule at the other end: a session that was inserted and never admitted. Nothing has been
 *  asked of any provider yet, so the exit is a plain failure and the window only has to outlast the
 *  admission transaction. CHECKED 2026-09-20 (Task 5A, brief step 5b(c)): no part of the create budget above
 *  sits inside the admission path — admission makes no provider call at all, and `fly-client.ts` is reached
 *  only from the runner adapter, which Task 5 calls AFTER admission has committed. Unchanged at 60.
 *  RE-CHECKED 2026-09-20 (Task 5) when the composed create + wait budget raised PROVISION_TIMEOUT_SECONDS:
 *  that path is entirely downstream of admission, so nothing moved here. Unchanged at 60. */
export const REQUESTED_TIMEOUT_SECONDS = 60;
/** The worst legal gap between a session's `created_at` and its `started_at`: the whole
 *  admission → provisioning → warming ladder, every leg of it a constant above. Derived, never typed:
 *  raising any of the three moves this with it.
 *
 *  It lives HERE rather than in `tokens.ts` (where it was defined until the whole-branch review's I1) because
 *  it is now read by TWO derivations that anchor on different instants, and the second of them is in the pure
 *  domain, which may import `../config` and nothing else:
 *    * `relayTokenExpiry` (tokens.ts) — `TOKEN_GRACE_MINUTES` must stay at or above this, or a token minted
 *      at `requested` (when `startedAt` is null) dies before the session it was minted for;
 *    * `runnerDeadlineOf` (domain/expiry.ts) — the Machine's own hard stop, computed at CREATE time for the
 *      same reason, must stay at or above this, or it fires BEFORE the session's own wall clock.
 *  `tokens.ts` re-exports it so there is still exactly one spelling and one importable name. */
export const MAX_ANCHOR_DRIFT_SECONDS =
  REQUESTED_TIMEOUT_SECONDS + PROVISION_TIMEOUT_SECONDS + WARMING_TIMEOUT_MINUTES * 60;
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
/** m-c (B5 re-review 3; controller ruling 2026-10-01): how many CONSECUTIVE failed outputs reads (`outputState` → null,
 *  "not read") the Cloudflare adapter waits before reporting, once per session. 6 = D3's 30 s hold over the organiser's
 *  5 s poll (lib/stream-session-view.ts OUTPUT_WARNING_AFTER_MS / STREAM_POLL_MS): a failure that outlasts the hold is
 *  the one that has blinded D3 — before round 2 it would have put the key box up by then, now it shows nothing — while
 *  one or two failures are a 429 or a 5xx blip the next poll reads through, and reporting those would drown the signal.
 *  A literal, not an import: this module is the relay's product numbers, and the test derives it from the two
 *  declarations, so moving either moves the test. */
export const OUTPUT_READ_FAILURES_BEFORE_REPORT = 6;
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
/** Same page: the RAM a performance preset's price already includes, per CPU (performance-1x = 1 CPU + 2 GB,
 *  performance-4x = 4 + 8 GB). FLY_RAM_MICROS_PER_GB_MONTH prices only the GB above cpus × this; fewer GB is no discount. */
export const FLY_PERFORMANCE_INCLUDED_GB_PER_CPU = 2;
/** Same page, read 2026-09-16: prices are "per 30 days", and $31.00/month ↔
 *  $0.00001196/second reproduces only with a 30-day month (2,592,000 s). The plan
 *  snapshot used a 730-hour month (R0-memo.md's $0.0000317/s for
 *  performance-2x/4 GB); the page now lists performance-2x/4GB at $0.00002392/s
 *  (iad) and wins. */
export const FLY_BILLING_SECONDS_PER_MONTH = 30 * 24 * 3600;

/** `RELAY_DRIVERS=fake|live`, resolved to the mode this process runs (R5, Task 14b, owner ruling 2026-09-29):
 *   * `live` — the real Cloudflare and Fly adapters, whatever else is set.
 *   * unset or empty — `fake` outside production (dev, test: a process that has not been told it may spend money does
 *     not), and `disabled` under NODE_ENV=production: NO drivers, and createSession refuses with `ingest_unavailable`.
 *     Once every plan streams (V426), a production deploy missing its relay secrets would otherwise hand every club a
 *     FAKE "live" stream and consume a real credit for it.
 *   * explicit `fake` — only on a `local` or `ci` environment (ENV_NAME, read by `envNameOf`); on stg, prod or any other
 *     named deployment it THROWS. An UNSET ENV_NAME is allowed outside production only (m2, lane-close fix, ruled
 *     2026-09-29): an unnamed production server is exactly what a deployment missing its ENV_NAME secret looks like, so
 *     it THROWS too. instrumentation.ts calls this at boot; on Fly that does not stop the process — it stays up and
 *     answers 500 to every request until the misconfiguration is fixed (lane-close re-review M-1). A server started
 *     without the compiled instrumentation (a hand-staged standalone tree) never runs that call; there every caller of
 *     this function throws instead, so each relay-touching request 500s.
 *   * anything else — throws rather than guess. `disabled` is a resolved mode, never a value to set. */
export type RelayDriverMode = "fake" | "live" | "disabled";
export function relayDriverMode(env: Record<string, string | undefined> = process.env): RelayDriverMode {
  const v = env.RELAY_DRIVERS;
  if (v === "live") return "live";
  if (v === undefined || v === "") return env.NODE_ENV === "production" ? "disabled" : "fake";
  if (v === "fake") {
    const name = envNameOf(env);
    if (name === null && env.NODE_ENV === "production") {
      throw new Error(
        `RELAY_DRIVERS=fake under NODE_ENV=production needs ENV_NAME ${FAKE_DRIVER_ENV_NAMES.map((n) => JSON.stringify(n)).join(" or ")} (it is unset): an unnamed production server is what a deployment missing its ENV_NAME looks like — name a developer's machine or CI, set RELAY_DRIVERS=live, or leave it unset to disable streaming`,
      );
    }
    if (name !== null && !FAKE_DRIVER_ENV_NAMES.includes(name)) {
      throw new Error(
        `RELAY_DRIVERS=fake is refused on ENV_NAME=${JSON.stringify(name)}: a named deployment would hand every club a fake "live" stream and spend a real credit on it — set RELAY_DRIVERS=live, or leave it unset to disable streaming`,
      );
    }
    return "fake";
  }
  throw new Error(`RELAY_DRIVERS must be "fake" or "live", got ${JSON.stringify(v)}`);
}

/** I1 (Task 12 fix round 1, owner decision 2026-09-28): the deploy environment's IDENTITY — `ENV_NAME`, "stg" or
 *  "prod", set as a Fly secret on each deployment. No house variable carried it: Sentry's `environment` is NODE_ENV,
 *  which reads "production" on both. Every runner this process creates is stamped with it (RunnerSpec.environment), and
 *  it is the daily sweep's ONLY licence to destroy a listed runner — staging and production can list one provider
 *  account, so "no row in my database" is never ownership. Read HERE and nowhere else (`envNameOf`).
 *
 *  A live process that cannot name its environment REFUSES rather than guess; a fake process needs neither variable and
 *  answers LOCAL_ENV_NAME — its FakeRunner holds only what it created itself. */
export const LOCAL_ENV_NAME = "local";
/** R5: the ENV_NAMEs an explicit RELAY_DRIVERS=fake may run under — a developer's machine and CI. An unset ENV_NAME too,
 *  but outside production only (m2). */
export const FAKE_DRIVER_ENV_NAMES: readonly string[] = [LOCAL_ENV_NAME, "ci"];
function envNameOf(env: Record<string, string | undefined>): string | null {
  const v = env.ENV_NAME?.trim();
  return v ? v : null;
}
const ENV_NAME_MISSING = "ENV_NAME is not set (RELAY_DRIVERS=live needs it — \"stg\" or \"prod\", a Fly secret per deployment: every Machine this deployment creates carries it, and the daily sweep destroys only Machines that do)";
export function relayEnvironment(env: Record<string, string | undefined> = process.env): string {
  // The mode FIRST (R5): an explicit fake on a named deployment is refused before this answers that deployment's name.
  const mode = relayDriverMode(env);
  const name = envNameOf(env);
  if (name) return name;
  if (mode === "live") throw new Error(ENV_NAME_MISSING);
  return LOCAL_ENV_NAME;
}

/** The ONE Fly app every deployment used to default to (runner-fly.ts, before I1) — so staging's sweep listed
 *  production's Machines. Refused by name: each deployment names its own app (e.g. seazn-relay-stg / seazn-relay-prod). */
export const FLY_RELAY_APP_RETIRED_DEFAULT = "seazn-relay";
/** I1(b): what a runner that builds its OWN Fly client must know — its deployment's app and environment. A runner that
 *  talks to the real account is live by definition, whatever RELAY_DRIVERS says, so this refuses instead of defaulting. */
export function liveRunnerIdentity(env: Record<string, string | undefined> = process.env): { app: string; environment: string } {
  const app = env.FLY_RELAY_APP?.trim();
  if (!app) throw new Error("FLY_RELAY_APP is not set (RELAY_DRIVERS=live needs it — one Fly app PER deployment, e.g. seazn-relay-stg / seazn-relay-prod)");
  if (app === FLY_RELAY_APP_RETIRED_DEFAULT) {
    throw new Error(`FLY_RELAY_APP is the retired shared default "${FLY_RELAY_APP_RETIRED_DEFAULT}" — one app shared by two deployments lets each one's sweep see the other's Machines; name this deployment's own app`);
  }
  const environment = envNameOf(env);
  if (!environment) throw new Error(ENV_NAME_MISSING);
  return { app, environment };
}

// ---- Capture QR v2 (spec docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md) -----------------------------
// config.test.ts reads each figure back out of the spec, so a change here that the spec does not make reds.

/** C2 (§5.1): a finished fixture's code expires this long after `finished_at`, unless a session is open. */
export const CODE_GRACE_AFTER_FINISH_MINUTES = 120;
/** A14, T4 (§6.5): a live phone may be taken over after this long with no beat AND no video. */
export const DEAD_PHONE_TAKEOVER_SECONDS = 60;
/** §6.9: silent = no beat for max(this floor, the answered cadence + the slack). */
export const PHONE_SILENT_FLOOR_SECONDS = 60;
/** §6.9: the margin a real phone needs past its cadence. Deliberately NOT tunable (plan R10): only the floor shortens. */
export const PHONE_SILENT_SLACK_SECONDS = 30;
/** §6.9 (W8): a held phone is not responding after this many answered cadences with no beat. */
export const NOT_RESPONDING_BEATS = 3;
/** §6.6 (W17): the cadences the beat answer tells the phone. */
export const POLL_STARTING_SECONDS = 5;
export const POLL_NEAR_SECONDS = 10;
export const POLL_FAR_SECONDS = 60;
/** §6.6: with no session, the near cadence starts this long before `scheduled_at`. */
export const POLL_NEAR_WINDOW_MINUTES = 30;
/** W19 (§6.8.5): a live phone stream whose phone is gone ends after this long with no beat and no video. */
export const PHONE_LOST_LIVE_MINUTES = 15;
/** W10 (§6.10): how long the phone-beat history is kept. */
export const PHONE_BEAT_RETENTION_HOURS = 24;
/** W9 (§7.4): the phone-health line's thresholds. */
export const LOW_BATTERY_PERCENT = 20;
export const HOT_THERMAL_STATUS = 3;

/** §6.15 / AGENTS.md #20: the timings a walkthrough may shorten, so A14, ask 10 and W19 run in seconds. */
export const TUNABLE_NAMES = [
  "DEAD_PHONE_TAKEOVER_SECONDS", "PHONE_LOST_LIVE_MINUTES", "PHONE_SILENT_FLOOR_SECONDS", "CODE_GRACE_AFTER_FINISH_MINUTES",
] as const;
export type TunableName = (typeof TUNABLE_NAMES)[number];
/** The ENV_NAMEs an override is honoured under: a developer's machine and CI. Never a deployment, never unset. */
export const TUNABLE_ENV_NAMES: readonly string[] = [LOCAL_ENV_NAME, "ci"];

/** §6.15 / AGENTS.md #20: an override is honoured ONLY when ENV_NAME ∈ {local, ci}; every guard pins the DEFAULT.
 *  An unset or blank variable is the fallback (never `Number("")` = 0). Under local/ci a value that is not a positive
 *  whole number THROWS, naming the variable: a typo that silently ran the default would surface as a walkthrough
 *  blowing its budget, which reports itself as a data defect (AGENTS.md #20). */
// `env` is typed as relayDriverMode's is: Next augments NodeJS.ProcessEnv with a required NODE_ENV, which a test's
// literal environment does not carry. process.env is assignable either way.
export function tunable(name: TunableName, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const where = envNameOf(env);
  if (where === null || !TUNABLE_ENV_NAMES.includes(where)) return fallback;
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${name}=${JSON.stringify(raw)} is not a positive whole number (ENV_NAME=${where} honours the override; unset it to run the default ${fallback})`);
  }
  return Number(raw);
}
