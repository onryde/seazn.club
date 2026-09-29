// server/relay/drivers.ts — RELAY_DRIVERS=fake|live picks the adapters once
// per process (a registry, §9a). Unset is fake outside production: a process
// that was not told it may spend money does not. Unset IN production is
// "disabled" (R5, Task 14b): a pair that refuses every call — nothing faked,
// nothing sent. Tests inject their own pair.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { relayDriverMode } from "./config";
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
    deleteInput: refuse, storageUsage: refuse, listVideos: refuse, deleteVideo: refuse,
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
 *  sessions on real Cloudflare — composed is disabled this wave, so the runner
 *  is never called; when it is, a missing token fails THAT call, not the boot. */
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
      ? { ingest: new CloudflareIngest({ recorder: dbRecorder }), runner: lazyRunner() }
      : mode === "disabled"
        ? disabledRelayDrivers()
        : { ingest: new FakeIngest({ recorder: dbRecorder }), runner: new FakeRunner({ recorder: dbRecorder }) };
  return instance;
}

/** N1 (Task 14b fix round 2): is this process's relay DISABLED (R5 — production with RELAY_DRIVERS unset)? Answered from
 *  the mode, or from the test override, WITHOUT constructing anything. The division page asks on every fixtures render
 *  and the relay-checkout route on every request; `relayDrivers().disabled` built the live pair to answer, and
 *  `new CloudflareIngest()` throws when a Cloudflare secret is missing — so a live deploy short one secret took the
 *  fixtures tab down for every org. Ask this for the question; take `relayDrivers()` only to call a provider. */
export function relayIsDisabled(): boolean {
  return override ? override.disabled === true : relayDriverMode() === "disabled";
}

/** Tests only. `null` clears the override AND the cached instance. */
export function setRelayDriversForTest(d: RelayDrivers | null): void {
  override = d;
  if (d === null) instance = null;
}
