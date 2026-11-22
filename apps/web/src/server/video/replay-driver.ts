import "server-only";
// server/video/replay-driver.ts — which replay host a process talks to (Task 21). REPLAY_DRIVER=fake|bunny picks it, once per
// process (a registry, like youtube/driver.ts). The choice and the Bunny settings are config.ts's (`replayDriverMode`,
// `bunnyConfig`): unset is the fake only where the relay driver is fake, so a deployment cannot move recordings into a fake host
// by omission.
//
// The fake is ONE instance per process, kept on globalThis: Next can bundle this module more than once (a route, the cron worker's
// entry), and two fakes would be two hosts — a fetch through one, a webhook read through the other.
import { bunnyConfig, replayDriverMode } from "@/server/relay/config";
import { dbRecorder } from "@/server/relay/drivers";
import { log } from "@/server/logger";
import { BunnyReplayHost } from "./replay-bunny";
import { FakeReplayHost } from "./replay-fake";
import type { ReplayHost } from "./replay-ports";

const FAKE_SLOT = Symbol.for("seazn.replay.fake");
const slots = globalThis as unknown as Record<symbol, FakeReplayHost | undefined>;

let override: ReplayHost | null = null;
let bunny: BunnyReplayHost | null = null;

/** The Bunny adapter, built once per process on first use. Its settings are checked HERE (`bunnyConfig`), so a process whose
 *  Bunny variables are missing refuses with their names instead of serving a fake, and a refusal caches nothing.
 *  Every call it makes is a provider-call row through `dbRecorder`, as the Cloudflare and Fly adapters' are (V541 admits
 *  `bunny` in that table's provider CHECK). */
function buildBunnyDriver(): ReplayHost {
  return (bunny ??= new BunnyReplayHost(bunnyConfig(), { recorder: dbRecorder, warn: (fields, msg) => log.warn(fields, msg) }));
}

export function replayDriver(): ReplayHost {
  if (override) return override;
  if (replayDriverMode() === "fake") return (slots[FAKE_SLOT] ??= new FakeReplayHost());
  return buildBunnyDriver();
}

/** Tests only. A host installs itself as the driver; `null` clears the override, the shared fake AND the built Bunny adapter,
 *  so the next test starts with an empty host built from its own settings. */
export function setReplayDriverForTest(host: ReplayHost | null): void {
  override = host;
  if (host === null) {
    delete slots[FAKE_SLOT];
    bunny = null;
  }
}
