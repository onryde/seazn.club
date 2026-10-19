import "server-only";
// Online chess behind a PostHog flag (T20, owner 2026-10-11: "add the feature flag behind the chess online like
// streaming"). The ONE answer to "is online chess offered to this club?" — every start gate calls
// `onlineChessOffered` / `assertOnlineChessOffered` here, so there is one cache, not one per gate.
//
// Mirrors capture-qr-v2 (server/stream-panel-context.ts `phoneCaptureOffered`): org-targeted (the `organization`
// group, keyed by the org id), `fallback: false` — PostHog unconfigured, down or throwing hides it — and
// `ONLINE_CHESS_ALWAYS=1` forces it on for local, CI and e2e (staging and production leave it unset). Deliberately
// not NODE_ENV.
//
// It gates what STARTS online play only: turning online play on for a division, opening a round, creating a game,
// sending an invite, linking a Lichess account, and demanding one at sign-up. It never gates what FINISHES play —
// moves, offers and resigns on a live game (play.ts), reconcile, result writing, the sweeps, or the match room of a
// board that already has a game, or the crash recovery that adopts a game an earlier create already sent (fix round 1,
// m3: create-game.ts gates only a NEW send) — so a club whose flag goes off mid-round never strands a live game.
// (Owner 2026-10-11: the flag is never switched off mid-round, and there is no kill switch.)
import { HttpError } from "@/lib/errors";
import { ONLINE_CHESS_DISABLED_CODE } from "@/lib/online-chess";
import { isServerFeatureEnabled } from "@/lib/posthog-server";
import type { AuthCtx } from "@/server/api-v1/auth";

export const ONLINE_CHESS_FLAG = "online-chess";
/** The refusal every server-side start gate answers with the flag off (403) — declared client-safe in lib/online-chess.ts
 *  so division Settings can localise it (fix round 1, m6), re-exported here for the gates. */
export { ONLINE_CHESS_DISABLED_CODE };

/** Who is asking: the club, and the person when there is one (an API key or a system path has none). */
export type OnlineChessAsker = Pick<AuthCtx, "orgId" | "userId">;

/** The flag is a REMOTE call (no local evaluation) and the gates sit on organiser pages and request paths, so one
 *  answer per (org, distinct id) PAIR — exactly what PostHog is asked with — is kept for this long, in-process, and
 *  shared by every caller inside it (the first caller's own ask included, so concurrent asks make one call). Keyed on
 *  the pair, never the org alone: a flag re-targeted by person must not serve one user's answer to their whole club. */
export const ONLINE_CHESS_FLAG_TTL_MS = 60_000;
const flagByAsk = new Map<string, { until: number; on: Promise<boolean> }>();

/** Test seam: forget every kept answer (each test starts from a cold process). */
export function forgetOnlineChessFlagCache(): void {
  flagByAsk.clear();
}

export async function onlineChessOffered(asker: OnlineChessAsker): Promise<boolean> {
  if (process.env.ONLINE_CHESS_ALWAYS === "1") return true;
  const now = Date.now();
  const distinctId = asker.userId ?? asker.orgId;
  // JSON, so no id can run into the other: ["a|b","c"] and ["a","b|c"] are different keys.
  const key = JSON.stringify([asker.orgId, distinctId]);
  const hit = flagByAsk.get(key);
  if (hit && now < hit.until) return hit.on;
  // `isServerFeatureEnabled` answers its fallback rather than rejecting today; the catch makes that a guard, not an
  // assumption — a rejected promise kept in this cache would turn every start gate into a 500 for a minute.
  const on = isServerFeatureEnabled(ONLINE_CHESS_FLAG, distinctId, { orgId: asker.orgId, fallback: false }).catch(
    () => false,
  );
  // Bounded: an expired answer is dropped whenever the map grows past a thousand pairs.
  if (flagByAsk.size >= 1000) for (const [k, v] of flagByAsk) if (now >= v.until) flagByAsk.delete(k);
  flagByAsk.set(key, { until: now + ONLINE_CHESS_FLAG_TTL_MS, on });
  return on;
}

/** The one refusal every server-side start gate throws with the flag off — for a gate that asked the flag earlier
 *  (outside its transaction) and decides inside it. */
export function onlineChessDisabled(): HttpError {
  return new HttpError(403, "Online chess is not available for this organisation", ONLINE_CHESS_DISABLED_CODE);
}

/** The server-side refusal: 403 ONLINE_CHESS_DISABLED unless online chess is offered to this club. */
export async function assertOnlineChessOffered(asker: OnlineChessAsker): Promise<void> {
  if (!(await onlineChessOffered(asker))) throw onlineChessDisabled();
}
