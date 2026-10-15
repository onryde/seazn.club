// The ONE gate both live Fly legs (fly-client.live.test.ts, runner-fly.live.test.ts) pass before they may create a
// Machine. PR #971 review I1: both legs used to default the app to `seazn-relay`, the RETIRED shared app config.ts
// refuses by name (FLY_RELAY_APP_RETIRED_DEFAULT). No deployment's orphan sweep lists that app, so a probe a dead worker
// leaked there would bill until someone noticed. A live leg now names its app explicitly, or does not run.
//
// Order is the point, each step behind the one before:
//   1. the flag (RELAY_LIVE_FLY=1) — nothing else is read without it, so ordinary unit runs touch no credential;
//   2. the app (FLY_RELAY_APP, trimmed) — unset or blank SKIPS, naming the variable and an app to use;
//      the retired name THROWS, so the file fails to collect loudly instead of skipping quietly past a misconfiguration;
//   3. the token — read only once there is an app it may be spent on (the leg's own reader: env, then .env.local).
// Tested by live-fly-gate.test.ts.
import { FLY_RELAY_APP_RETIRED_DEFAULT } from "../config";

export type LiveFlyGate = { enabled: true; app: string; token: string } | { enabled: false; reason: string };

export function liveFlyGate(env: Record<string, string | undefined>, readToken: () => string | undefined): LiveFlyGate {
  if (env.RELAY_LIVE_FLY !== "1") return { enabled: false, reason: "RELAY_LIVE_FLY=1 is not set" };
  const app = env.FLY_RELAY_APP?.trim();
  if (!app) {
    return { enabled: false, reason: "FLY_RELAY_APP is not set — a live leg names its app explicitly and has no default (e.g. FLY_RELAY_APP=seazn-relay-spike)" };
  }
  if (app === FLY_RELAY_APP_RETIRED_DEFAULT) {
    throw new Error(
      `FLY_RELAY_APP=${app} is the RETIRED shared relay app: no deployment's orphan sweep lists it, so a Machine a live leg leaked there would bill until noticed. Name an app you own (e.g. seazn-relay-spike).`,
    );
  }
  const token = readToken();
  if (!token) return { enabled: false, reason: "FLY_API_TOKEN is in neither the environment nor apps/web/.env.local" };
  return { enabled: true, app, token };
}
