// server/relay/drivers.ts — RELAY_DRIVERS=fake|live picks the adapters once
// per process (a registry, §9a). Unset is fake outside production: a process
// that was not told it may spend money does not. Unset IN production is
// "disabled" (R5, Task 14b): a pair that refuses every call — nothing faked,
// nothing sent. Tests inject their own pair.
import { sql } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import { log } from "@/server/logger";
import { liveRunnerIdentity, relayDriverMode } from "./config";
import { FakeIngest, FakeRunner } from "./fakes";
import { CloudflareIngest } from "./ingest-cf";
import {
  createRefusedBeforeCall, type IngestCapabilities, type IngestProvider, type ProviderCallRecorder, type RunnerProvider,
} from "./ports";
import { FLY_LIST_SETTLE_MS, FlyRunner } from "./runner-fly";
import { recordProviderCall } from "./telemetry";

export interface RelayDrivers {
  ingest: IngestProvider;
  runner: RunnerProvider;
  /** R5: set only on the pair `disabledRelayDrivers()` builds — the process has no relay at all. createSession refuses
   *  on it with `ingest_unavailable` before any row or provider call, and the relay-sweep cron skips. */
  disabled?: true;
}

/** R5 (Task 14b): what every port of the disabled pair answers. Named, so a caller that reaches a provider anyway (a
 *  session left from before the switch) fails loudly and says why, rather than reading a fake answer. */
export class RelayDriversDisabled extends Error {
  constructor() {
    super("streaming is disabled on this deployment: NODE_ENV=production with RELAY_DRIVERS unset — set RELAY_DRIVERS=live (with its secrets) to enable it");
    this.name = "RelayDriversDisabled";
  }
}

/** R5: the pair a production process with no RELAY_DRIVERS runs. Typed as the two ports, so tsc proves it complete;
 *  every method rejects and both data members throw on read — a capability or settle window read off a provider
 *  that does not exist would be a made-up number. */
export function disabledRelayDrivers(): RelayDrivers {
  const refuse = async (): Promise<never> => {
    throw new RelayDriversDisabled();
  };
  const ingest: IngestProvider = {
    get capabilities(): IngestCapabilities {
      throw new RelayDriversDisabled();
    },
    createLiveInput: refuse, inputStatus: refuse, addOutput: refuse, outputState: refuse, removeOutput: refuse,
    deleteInput: refuse, storageUsage: refuse, listVideos: refuse, listInputVideos: refuse, deleteVideo: refuse,
  };
  const runner: RunnerProvider = {
    get listSettleMs(): number {
      throw new RelayDriversDisabled();
    },
    create: refuse, stop: refuse, observe: refuse, destroy: refuse, list: refuse,
  };
  return { ingest, runner, disabled: true };
}

let instance: RelayDrivers | null = null;
let override: RelayDrivers | null = null;

/** Ruling 13: the production recorder — every adapter call (fake OR live)
 *  becomes a stream_provider_calls row through telemetry.ts. Best-effort: a
 *  failing insert is logged once per process and never fails the call.
 *  `Promise.resolve(...)` wraps the call because the port allows a recorder to
 *  be synchronous and a test double often is; `.catch` straight off the result
 *  would throw on an undefined return and lose the row silently. */
let warned = false;
export const dbRecorder: ProviderCallRecorder = {
  record: (c) =>
    Promise.resolve(recordProviderCall(sql, c)).catch((e: unknown) => {
      if (!warned) {
        warned = true;
        // The table's NAME cannot appear in this string: enc-boundary.test.ts's
        // claim 4 strips comments and then refuses any file outside the three
        // declared writers that names a capture table, and a log message is not
        // a comment. The brief's draft of this line named it and reddened that guard.
        log.warn({ err: e }, "relay provider-call telemetry insert failed; capture is degraded");
      }
    }),
};

/** The Fly runner is constructed on FIRST USE: a live server without
 *  FLY_API_TOKEN (owed by the owner, 2026-09-14) still serves passthrough
 *  sessions on real Cloudflare. A composed start on a deployment the runner
 *  could not be built on (no RELAY_IMAGE, no FLY_API_TOKEN, no usable
 *  FLY_RELAY_APP or ENV_NAME) is refused at its entry (R2001,
 *  `composedUnavailable()` below): no session row, input, credit or runner is
 *  created. When the runner is called anyway (the configuration changed after
 *  admission), a refused construction fails THAT call, not the boot. */
/** Every method is `async` on purpose. `get()` THROWS when the token is missing,
 *  and a plain `() => get().list()` throws SYNCHRONOUSLY — out of a method the
 *  port declares as returning a Promise, so a caller's `.catch()` never sees it
 *  and the usecase blows up where it thought it had a rejection to handle. */
function lazyRunner(): RunnerProvider {
  let real: FlyRunner | null = null;
  const get = () => (real ??= new FlyRunner({ recorder: dbRecorder }));
  return {
    // Task 12 n1: a construction refusal (no token or image, no FLY_RELAY_APP / ENV_NAME, the retired shared app) is a
    // configuration fact read before any request exists — it provably made nothing, and says so through the PORT's own
    // failure. A plain Error here read as outcome UNKNOWN: lost → force_destroy → retry → the same refusal, alarming on
    // every attempt. Only construction is caught; the adapter's own `create` maps its failures itself (A23).
    create: async (spec) => {
      let runner: FlyRunner;
      try {
        runner = get();
      } catch (e) {
        throw createRefusedBeforeCall(e);
      }
      return runner.create(spec);
    },
    stop: async (id, opts) => get().stop(id, opts),
    observe: async (id) => get().observe(id),
    destroy: async (id) => get().destroy(id),
    list: async () => get().list(),
    listSettleMs: FLY_LIST_SETTLE_MS,   // m1: a constant, so reading it never constructs (and never refuses) the runner
  };
}

export function relayDrivers(): RelayDrivers {
  if (override) return override;
  if (instance) return instance;
  const mode = relayDriverMode();
  instance =
    mode === "live"
      ? { ingest: new CloudflareIngest({ recorder: dbRecorder, reportError: captureError }), runner: lazyRunner() }   // m-2: unseen output words reach Sentry
      : mode === "disabled"
        ? disabledRelayDrivers()
        : { ingest: new FakeIngest({ recorder: dbRecorder }), runner: new FakeRunner({ recorder: dbRecorder }) };
  return instance;
}

/** Can this process stream at all? UNAVAILABLE when the relay is DISABLED (R5 — production with RELAY_DRIVERS unset), and
 *  (m1, lane-close review) when it is LIVE but missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_STREAM_TOKEN — the pair the
 *  live drivers cannot be built without, so every start there fails. Answered from the mode, the two env reads
 *  (`CloudflareIngest.configured`) or the test override, WITHOUT constructing anything (N1, Task 14b fix round 2): the
 *  division page asks on every fixtures render and the relay-checkout route on every request, and a constructing
 *  answer took the fixtures tab down for every org on a live deploy short one secret. The page shows "unavailable"
 *  and the checkout refuses 503 on it. Ask this for the question; take `relayDrivers()` only to call a provider. */
export function relayUnavailable(): boolean {
  if (override) return override.disabled === true;
  const mode = relayDriverMode();
  return mode === "disabled" || (mode === "live" && !CloudflareIngest.configured());
}

/** R2001: can this deployment run a COMPOSED session? Unavailable when the relay itself is (`relayUnavailable()`), when
 *  RELAY_IMAGE is unset or empty (the compositor image FlyRunner's constructor refuses to start without), and (I1, review
 *  of PR #965) on a LIVE deployment whose runner could not be built: FLY_API_TOKEN unset or empty, or
 *  `liveRunnerIdentity()` refusing (FLY_RELAY_APP unset or the retired shared default, ENV_NAME unset), the constructor's
 *  other two refusals. Before this a composed start was admitted on such a deployment, wrote its session row, opened its
 *  Cloudflare input and only then failed at the constructor. The ONE authority for the question: startBroadcast refuses
 *  `composed_unavailable` (503) on it at its entry, so no session row, input, credit or runner is created, and the
 *  organiser UI reads it to decide whether to offer composed at all, so the page never offers what the API refuses. Like
 *  `relayUnavailable()` it answers from the env WITHOUT constructing anything or calling anyone. The test override answers
 *  the relay half and brings its own runner, so the live-runner half is not asked under it; it never excuses a missing
 *  image. A fake deployment's runner needs none of the Fly configuration. */
export function composedUnavailable(): boolean {
  if (relayUnavailable() || !process.env.RELAY_IMAGE) return true;
  if (override || relayDriverMode() !== "live") return false;
  if (!process.env.FLY_API_TOKEN) return true;
  try {
    liveRunnerIdentity();
  } catch {
    return true;
  }
  return false;
}

/** Tests only. `null` clears the override AND the cached instance. */
export function setRelayDriversForTest(d: RelayDrivers | null): void {
  override = d;
  if (d === null) instance = null;
}
