import "server-only";
// server/usecases/capture-realtime.ts — push nudges (spec 2026-11-24 §2.1, plan Task 5 / T1.3): the beat answer's `realtime`,
// the code's CURRENT pairing's private push channel. `runBeat` (capture-phone.ts step 7) decides who is served
// (`realtimePairingOf`) and asks `captureRealtimeFor` for the object; a fixture code's beat and a court code's
// (`postCourtBeat` delegates to `runBeat`) are served the same way.
//
// The token is a secret: it is returned to the caller and nowhere else — never logged, captured, stored or put in a URL.
// What this file logs names the pairing and the refusal, never the url, the key or the token.
import { captureTopic } from "@/lib/realtime";
import { CAPTURE_REALTIME_URL_RE, CaptureBeatAnswer, CaptureRealtime } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { CAPTURE_REALTIME_TTL_SECONDS } from "@/server/relay/config";
import { realtimeOf, type SessionDeps } from "./stream-sessions";

type AnswerState = CaptureBeatAnswer["state"];
/** The branches the contract admits `realtime` on (waiting, go-live, live, over), read off the twin's own shapes: replaced
 *  and taken omit it, because their caller no longer holds the pairing. */
const SERVED_STATES: ReadonlySet<AnswerState> = new Set(
  CaptureBeatAnswer.options.filter((o) => "realtime" in o.shape).map((o) => o.shape.state.value),
);

/**
 * Who a beat answer's channel is for: the caller's pairing (`mineId`, null when the caller holds none), only when it IS the
 * code's current pairing as re-read after the beat committed (`holderId`), and only on a branch the contract admits it on.
 * Else null. The post-commit re-read is what tells the phone a desk Stop left current (served on `over`) from the phone
 * whose own `ended` closed its pairing (T21: `mineId` is that pairing, `holderId` no longer is — not served).
 */
export function realtimePairingOf(i: { mineId: string | null; holderId: string | null; state: AnswerState }): string | null {
  if (i.mineId === null || i.holderId !== i.mineId) return null;
  return SERVED_STATES.has(i.state) ? i.mineId : null;
}

type Refusal = "url_not_contract" | "host_not_project" | "apikey_not_contract" | "answer_not_contract";

/** The configured project, or why it is not served. The url is tested RAW against the published file's pattern
 *  (`z.url()` trims, so the twin alone would pass a padded value or let a query through to the phone) and its host must be
 *  the project this deployment's NEXT_PUBLIC_SUPABASE_URL names, so a token is never handed out for another host. */
function configRefusal(cfg: { url: string; apikey: string }): Refusal | null {
  if (!CAPTURE_REALTIME_URL_RE.test(cfg.url)) return "url_not_contract";
  const host = hostOf(cfg.url);
  const projectHost = hostOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (host === null || projectHost === null || host !== projectHost) return "host_not_project";
  if (!CaptureRealtime.shape.apikey.safeParse(cfg.apikey).success) return "apikey_not_contract";
  return null;
}
/** A url's host, or null when it has none or does not parse (a refusal, never a throw the caller would read as a mint's). */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * The `realtime` object for `pairingId`'s beat answer at the beat's server clock `now`: the configured project, the pairing's
 * topic, a FRESH token living CAPTURE_REALTIME_TTL_SECONDS (a new one on every current-pairing beat; the phone swaps only
 * when its joined one runs low), and that expiry in epoch seconds. Null — the key omitted — when no Supabase is configured
 * (silently) or the configured one is refused (logged). A mint that throws is the CALLER's to catch: `runBeat` answers the
 * beat without the key.
 */
export async function captureRealtimeFor(pairingId: string, now: Date, deps: SessionDeps): Promise<CaptureRealtime | null> {
  const port = realtimeOf(deps);
  const cfg = port.config();
  if (cfg === null) return null;
  const refused = configRefusal(cfg);
  if (refused !== null) {
    log.warn({ pairingId, refusal: refused }, "capture beat: the realtime project is refused — the beat is answered without realtime");
    return null;
  }
  const expiresAt = new Date(now.getTime() + CAPTURE_REALTIME_TTL_SECONDS * 1000);
  const token = await port.mint(pairingId, expiresAt);
  const parsed = CaptureRealtime.safeParse({
    url: cfg.url, apikey: cfg.apikey, topic: captureTopic(pairingId), token, expiresAt: Math.floor(expiresAt.getTime() / 1000),
  });
  if (!parsed.success) {
    // The issues' PATHS only: an issue can quote its input, and one of these inputs is the token.
    const fields = parsed.error.issues.map((issue) => issue.path.join("."));
    log.warn({ pairingId, refusal: "answer_not_contract" satisfies Refusal, fields }, "capture beat: the realtime object is not the contract's — the beat is answered without realtime");
    return null;
  }
  return parsed.data;
}
