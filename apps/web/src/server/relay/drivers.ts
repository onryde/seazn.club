// server/relay/drivers.ts — RELAY_DRIVERS=fake|live picks the adapters once
// per process (a two-entry registry, §9a). Unset is fake: a process that was
// not told it may spend money does not. Tests inject their own pair.
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { relayDriverMode } from "./config";
import { FakeIngest, FakeRunner } from "./fakes";
import { CloudflareIngest } from "./ingest-cf";
import type { IngestProvider, ProviderCallRecorder, RunnerProvider } from "./ports";
import { FlyRunner } from "./runner-fly";
import { recordProviderCall } from "./telemetry";

export interface RelayDrivers {
  ingest: IngestProvider;
  runner: RunnerProvider;
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
    create: async (spec) => get().create(spec),
    stop: async (id, opts) => get().stop(id, opts),
    observe: async (id) => get().observe(id),
    destroy: async (id) => get().destroy(id),
    list: async () => get().list(),
  };
}

export function relayDrivers(): RelayDrivers {
  if (override) return override;
  if (instance) return instance;
  instance =
    relayDriverMode() === "live"
      ? { ingest: new CloudflareIngest({ recorder: dbRecorder }), runner: lazyRunner() }
      : { ingest: new FakeIngest({ recorder: dbRecorder }), runner: new FakeRunner({ recorder: dbRecorder }) };
  return instance;
}

/** Tests only. `null` clears the override AND the cached instance. */
export function setRelayDriversForTest(d: RelayDrivers | null): void {
  override = d;
  if (d === null) instance = null;
}
