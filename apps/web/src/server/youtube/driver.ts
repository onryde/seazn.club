import "server-only";
// server/youtube/driver.ts — which YouTube a process talks to (plan P12). YOUTUBE_DRIVER=fake|live picks it, once per process
// (a registry, like relay/drivers.ts). UNSET is the fake outside production and LIVE in production: a production process that
// was not told to fake must never serve a fake channel, so the default flips with NODE_ENV and the production branch is the one
// the regression test pins. The e2e and smoke servers run NODE_ENV=production and say `YOUTUBE_DRIVER=fake` explicitly.
//
// The fake's routes (the e2e control route here, the fake authorize hop in T7) add a second lock: they answer only when the
// mode is fake AND ENV_NAME is one a fake is honoured under (relay/config.ts FAKE_DRIVER_ENV_NAMES, the list the fake-ingest
// control route uses), so a deployment that names itself stg or prod cannot serve them even if its mode were set wrong.
import { FAKE_DRIVER_ENV_NAMES } from "@/server/relay/config";
import { FakeYouTube } from "./fake";
import type { YouTubePort } from "./port";

export type YoutubeDriverMode = "fake" | "live";
type Env = Record<string, string | undefined>;

/** YOUTUBE_DRIVER, or its default: fake outside production, live in production. Anything but `fake` / `live` is an error naming
 *  the variable — a typo must not pick a driver. */
export function youtubeDriverMode(env: Env = process.env): YoutubeDriverMode {
  const v = env.YOUTUBE_DRIVER?.trim();
  if (v === "fake") return "fake";
  if (v === "live") return "live";
  if (v === undefined || v === "") return env.NODE_ENV === "production" ? "live" : "fake";
  throw new Error(`YOUTUBE_DRIVER must be "fake" or "live", got ${JSON.stringify(v)}`);
}

/** May the fake's own routes answer in this process? Fake mode AND an honoured ENV_NAME (trimmed, required — an unnamed process
 *  is what a deployment missing its ENV_NAME looks like). A misspelt YOUTUBE_DRIVER answers no, it does not throw: a route that
 *  must be unreachable is not made reachable-as-a-500 by a typo. The one authority for both the control and the authorize route. */
export function youtubeFakeRoutesEnabled(env: Env = process.env): boolean {
  try {
    if (youtubeDriverMode(env) !== "fake") return false;
  } catch {
    return false;
  }
  const name = env.ENV_NAME?.trim();
  return !!name && FAKE_DRIVER_ENV_NAMES.includes(name);
}

/** The fake is ONE instance per process, kept on globalThis: Next can bundle this module more than once (a route, an
 *  instrumentation hook), and two fakes would be two YouTubes — a connect on one, a Go live on the other, a control route
 *  driving a third. */
const FAKE_SLOT = Symbol.for("seazn.youtube.fake");
const slots = globalThis as unknown as Record<symbol, FakeYouTube | undefined>;

let override: YouTubePort | null = null;
let liveDriver: YouTubePort | null = null;

/** The Google driver. T6 builds `GoogleYouTube` (google.ts) and replaces this body with `new GoogleYouTube()`. Until then the
 *  live branch REFUSES BY NAME instead of falling back to the fake: serving a fake where Google was asked for is the failure
 *  this file exists to prevent. */
function buildLiveDriver(): YouTubePort {
  throw new Error("YOUTUBE_DRIVER=live: the Google driver (server/youtube/google.ts, plan T6) is not wired into driver.ts yet");
}

export function youtubeDriver(): YouTubePort {
  if (override) return override;
  if (youtubeDriverMode() === "fake") return (slots[FAKE_SLOT] ??= new FakeYouTube());
  return (liveDriver ??= buildLiveDriver());
}

/** Tests only. A port installs itself as the driver; `null` clears the override AND the cached drivers (the fake included),
 *  so the next test starts with a fresh channel. */
export function setYoutubeDriverForTest(p: YouTubePort | null): void {
  override = p;
  if (p === null) {
    liveDriver = null;
    delete slots[FAKE_SLOT];
  }
}
