import "server-only";
// server/video/replay-driver.ts — which replay host a process talks to (Task 21). REPLAY_DRIVER=fake|bunny picks it, once per
// process (a registry, like youtube/driver.ts). The choice and the Bunny settings are config.ts's (`replayDriverMode`,
// `bunnyConfig`): unset is the fake only where the relay driver is fake, so a deployment cannot move recordings into a fake host
// by omission.
//
// The fake is ONE instance per process, kept on globalThis: Next can bundle this module more than once (a route, the cron worker's
// entry), and two fakes would be two hosts — a fetch through one, a webhook read through the other.
import { bunnyConfig, replayDriverMode } from "@/server/relay/config";
import { FakeReplayHost } from "./replay-fake";
import type { ReplayHost } from "./replay-ports";

const FAKE_SLOT = Symbol.for("seazn.replay.fake");
const slots = globalThis as unknown as Record<symbol, FakeReplayHost | undefined>;

let override: ReplayHost | null = null;

/** The Bunny adapter. Its settings are checked HERE, so a process whose Bunny variables are missing refuses with their names
 *  instead of serving a fake. Task 22 builds `BunnyReplayHost` and returns it from here; until then this refuses, loudly. */
function buildBunnyDriver(): ReplayHost {
  bunnyConfig();
  throw new Error("REPLAY_DRIVER=bunny: the Bunny adapter is not built yet (Task 22)");
}

export function replayDriver(): ReplayHost {
  if (override) return override;
  if (replayDriverMode() === "fake") return (slots[FAKE_SLOT] ??= new FakeReplayHost());
  return buildBunnyDriver();
}

/** Tests only. A host installs itself as the driver; `null` clears the override AND the shared fake, so the next test starts
 *  with an empty host. */
export function setReplayDriverForTest(host: ReplayHost | null): void {
  override = host;
  if (host === null) delete slots[FAKE_SLOT];
}
