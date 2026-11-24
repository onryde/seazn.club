import "server-only";
// server/usecases/match-day-realtime.ts — push nudges (spec 2026-11-24 §3, plan Task 9 / T2.2): a Match Day code's realtime
// token, the door's answer (`GET /api/v1/match-day-code/realtime-token`; contract docs/contracts/capture-matchday-realtime.v1.json).
//
// The code was resolved at `now` by the md_ door (`matchDayCodeOf`: withdrawn, ended and not-yet-open are refused THERE, and a
// withdrawn code never reaches this file, so a withdrawal cannot re-mint). What is minted is the subscriber JWT for the code's
// private topic `match-day:{codeId}` (V555 keys it on `md_code_id`), living `min(1 h, the code's own expiry)`. Nothing is
// stored: every call mints a fresh token, and the app refreshes at 80% of its life, or when its channel errors.
//
// The token is a secret: it is returned to the caller and nowhere else — never logged, captured, stored or put in a URL. What
// this file logs names the code and the refusal, never the url, the key or the token; a contract failure names the PATHS of
// the issues only (an issue can quote its input, and one of these inputs is the token).
import { HttpError } from "@/lib/errors";
import { MATCH_DAY_TOKEN_TTL_SECONDS, matchDayTopic, mintMatchDayToken } from "@/lib/realtime";
import { captureError } from "@/lib/sentry";
import { CaptureMatchdayRealtime } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { realtimeConfigRefusal, type RealtimeRefusal } from "./capture-realtime";
import type { MatchDayCodeRow } from "./match-day-codes";
import { processRealtimeConfig } from "./stream-sessions";

/** What the door mints and names through: the subscriber JWT for one code's private topic, and the Supabase project the app
 *  joins. `config` is null when this deployment configures no Supabase. */
export interface MatchDayRealtimePort {
  mint(codeId: string, expiresAt: Date): Promise<string>;
  config(): { url: string; apikey: string } | null;
}
const processPort: MatchDayRealtimePort = { mint: mintMatchDayToken, config: processRealtimeConfig };

/** The wire word of every way this door cannot serve a token (outside the md_ refusal words: the app reads it by status). */
export const REALTIME_UNAVAILABLE = "REALTIME_UNAVAILABLE";
const unavailable = (): HttpError => new HttpError(503, "realtime is not available on this server", REALTIME_UNAVAILABLE);

/**
 * The realtime object for `code` at the door's clock `now`. 503 REALTIME_UNAVAILABLE when no Supabase is configured, the
 * configured one is refused (the url against the published file's pattern, its host against the project, the key against the
 * contract: `realtimeConfigRefusal`, the same guard the capture beat's answer passes), the mint throws, or the answer is not
 * the contract's — never a token for another project, never a half answer. The `url` and `apikey` sent are the PARSED values.
 */
export async function matchDayRealtimeFor(
  code: MatchDayCodeRow,
  now: Date,
  port: MatchDayRealtimePort = processPort,
): Promise<CaptureMatchdayRealtime> {
  const cfg = port.config();
  if (cfg === null) {
    log.warn({ codeId: code.id }, "match day realtime: no Supabase project is configured — no token is served");
    throw unavailable();
  }
  const refused: RealtimeRefusal | null = realtimeConfigRefusal(cfg);
  if (refused !== null) {
    log.warn({ codeId: code.id, refusal: refused }, "match day realtime: the realtime project is refused — no token is served");
    throw unavailable();
  }
  // `resolveMatchDayCode` refused a code at or past its expiry, so the remaining life is positive: at least one millisecond.
  const expiresAt = new Date(Math.min(now.getTime() + MATCH_DAY_TOKEN_TTL_SECONDS * 1000, code.expiresAt.getTime()));
  let token: string;
  try {
    token = await port.mint(code.id, expiresAt);
  } catch (err) {
    // No token exists to leak: reported, and no subscription — the app polls.
    log.error({ err: String(err), codeId: code.id }, "match day realtime: the mint failed — no token is served");
    captureError(err, { orgId: code.orgId, route: "match_day_code.realtime_token", extra: { codeId: code.id } });
    throw unavailable();
  }
  const parsed = CaptureMatchdayRealtime.safeParse({
    url: cfg.url, apikey: cfg.apikey, topic: matchDayTopic(code.id), token, expiresAt: Math.floor(expiresAt.getTime() / 1000),
  });
  if (!parsed.success) {
    // The issues' PATHS only: an issue can quote its input, and one of these inputs is the token.
    const fields = parsed.error.issues.map((issue) => issue.path.join("."));
    log.warn({ codeId: code.id, refusal: "answer_not_contract" satisfies RealtimeRefusal, fields }, "match day realtime: the answer is not the contract's — no token is served");
    throw unavailable();
  }
  return parsed.data;
}
