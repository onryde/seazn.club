import "server-only";
// server/video/cf-analytics.ts — delivered minutes of Seazn LIVE: how many minutes viewers watched each Cloudflare uid (Task 30,
// Phase 3, SEAZN_HOSTED_COST). The replay side's minutes are the replay host's (`ReplayHost.watchMinutes`); this is the live side.
//
// One GraphQL query to Cloudflare's Analytics API (developers.cloudflare.com/stream/getting-analytics/fetching-bulk-analytics,
// read 2026-11-23): the `streamMinutesViewedAdaptiveGroups` dataset, filtered by `uid_in` and the UTC dates `date_geq`/`date_leq`,
// grouped by `uid`, reading `sum { minutesViewed }`. The answer is summed per uid, and every uid asked for has a number (0 when
// Cloudflare has no group for it). Cloudflare's own limits: a query spans at most 32 days (768 hours), and its data is kept 92.
//
// Which uid a LIVE view lands under is unmeasured: the docs key `uid` as "Video ID (for HLS/DASH) or Input ID (for WebRTC/WHEP)",
// and Seazn's viewers play the programme INPUT's uid (C1). The caller always asks for the input uid AND each of its video uids
// (Task 30 review I1): the interim replay plays by VIDEO uid (cf-playback.ts `signRecordingPlayback`) from the session's end until
// the replay host's copy is verified, so a video uid carries real minutes whatever the live answer is. The Task 7 probe
// (cf-signed-live.live.test.ts, step 8) answers only whether one live view is reported under BOTH keys — a double count the
// caller must not sum (the report's decision table: then the larger of the input's and its videos' minutes, per input and day).
//
// One call gives up after SEAZN_LIVE_MINUTES_TIMEOUT_MS, the request and the body read alike, recorded `timeout` (fix round 1).
//
// Safety: the token rides in the Authorization header alone — never the URL, the body, a message or a record. Every thrown message
// is our own wording, passed through sanitise.ts's `redact` floor; a fetch failure's own text is never quoted (it can carry the
// request). An answer naming a uid that was not asked for is refused, never summed or dropped: Cloudflare ignores a filter it does
// not apply (C6), and a number for "some other uid" would mean the query was not the one sent. The data is sampled by Cloudflare,
// so a total is an estimate, not an invoice line.
import { cfAnalyticsConfig, SEAZN_LIVE_MINUTES_TIMEOUT_MS, type CfAnalyticsConfig } from "@/server/relay/config";
import { NOOP_RECORDER, type ProviderCallRecorder } from "@/server/relay/ports";
import { redact } from "@/server/relay/sanitise";

export const CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
/** Cloudflare's maximum query interval for this dataset: "32 days (768 hours)". A window over it is refused here, before a call
 *  Cloudflare would refuse anyway. The days are the UTC dates the query covers, counted inclusively. A provider-protocol number. */
export const CF_ANALYTICS_MAX_WINDOW_DAYS = 32;
/** The groups one query may answer: Cloudflare's own ceiling for `limit`. Grouped by uid alone, an answer holds at most one group
 *  per uid asked for. */
const GROUP_LIMIT = 10_000;
const DAY_MS = 86_400_000;
const OPERATION = "liveMinutesViewed";

const QUERY = `query SeaznLiveMinutesViewed($accountTag: string!, $uids: [string!]!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      streamMinutesViewedAdaptiveGroups(filter: { uid_in: $uids, date_geq: $start, date_leq: $end }, limit: ${GROUP_LIMIT}) {
        sum { minutesViewed }
        dimensions { uid }
      }
    }
  }
}`;

type Group = { sum?: { minutesViewed?: unknown } | null; dimensions?: { uid?: unknown } | null };
type Answer = { data?: { viewer?: { accounts?: { streamMinutesViewedAdaptiveGroups?: unknown }[] | null } | null } | null; errors?: unknown };

export interface LiveMinutesOptions {
  /** Default: `cfAnalyticsConfig()`, read at the call — so an unset token refuses here, naming its variable. */
  config?: CfAnalyticsConfig;
  fetchImpl?: typeof fetch;
  /** One record per call (ruling 13), like every provider adapter's. Default: nothing. */
  recorder?: ProviderCallRecorder;
}

/** The UTC date of an instant, as Cloudflare's `Date` filter takes it (`YYYY-MM-DD`). */
const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Minutes viewed per uid over the UTC dates from `from`'s to `to`'s, both included. No uids is `{}` and no call. */
export async function liveMinutesViewed(
  uids: readonly string[], from: Date, to: Date, opts: LiveMinutesOptions = {},
): Promise<Record<string, number>> {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) throw new RangeError(`cloudflare ${OPERATION}: the window's \`from\` or \`to\` is not a date`);
  if (from.getTime() > to.getTime()) throw new RangeError(`cloudflare ${OPERATION}: the window ends (${to.toISOString()}) before it starts (${from.toISOString()})`);
  const start = utcDate(from);
  const end = utcDate(to);
  const days = (Date.parse(end) - Date.parse(start)) / DAY_MS + 1;
  if (days > CF_ANALYTICS_MAX_WINDOW_DAYS) {
    throw new RangeError(`cloudflare ${OPERATION}: the window ${start}..${end} spans ${days} days; Cloudflare answers at most ${CF_ANALYTICS_MAX_WINDOW_DAYS}`);
  }
  const asked = [...new Set(uids)];
  if (asked.length === 0) return {};

  const config = opts.config ?? cfAnalyticsConfig();
  const secrets = [config.token];
  const fail = (text: string) => new Error(redact(`cloudflare ${OPERATION}: ${text}`, secrets));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const rec = opts.recorder ?? NOOP_RECORDER;
  const started = Date.now();
  const record = (status: number | null, requestId: string | null, errorCode: string | null) =>
    void Promise.resolve()
      .then(() => rec.record({
        provider: "cloudflare", operation: OPERATION, subjectId: null, sessionId: null, method: "POST", url: CF_GRAPHQL_URL,
        ids: [config.accountId], status, latencyMs: Date.now() - started, attempt: 1, requestId, errorCode,
      }))
      .catch(() => undefined);

  // One deadline for the request and the body read alike: a call that does not finish in it is a failed call, recorded `timeout`.
  const signal = AbortSignal.timeout(SEAZN_LIVE_MINUTES_TIMEOUT_MS);
  const failure = (e: unknown) => (signal.aborted || (e as { name?: string })?.name === "TimeoutError" ? "timeout" : "network");
  let res: Response;
  try {
    res = await fetchImpl(CF_GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { accountTag: config.accountId, uids: asked, start, end } }),
      signal,
    });
  } catch (e) {
    record(null, null, failure(e));
    throw fail("request failed before a response");
  }
  let json: Answer | undefined;
  try {
    json = (await res.json()) as Answer;
  } catch (e) {
    // A body that arrived but is not JSON (an error page) reads as absent. One that never arrived in full — the deadline, or the
    // connection cut — is a failed call, never its status (the replay host's rule, replay-bunny.ts `api`).
    if (!(e instanceof SyntaxError)) {
      record(null, null, failure(e));
      throw fail("the response did not arrive in full");
    }
    json = undefined;
  }
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  record(res.status, res.headers.get("cf-ray"), errors.length > 0 ? "graphql_error" : null);
  if (errors.length > 0) {
    const reasons = errors.map((e) => (typeof (e as { message?: unknown })?.message === "string" ? (e as { message: string }).message : "(no message)"));
    throw fail(`HTTP ${res.status}, the query was refused: ${reasons.join("; ").slice(0, 300)}`);
  }
  if (!res.ok) throw fail(`HTTP ${res.status}`);

  const accounts = json?.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) throw fail(`HTTP ${res.status} answered ${Array.isArray(accounts) ? accounts.length : "no"} accounts, not the one asked for`);
  const groups = accounts[0]?.streamMinutesViewedAdaptiveGroups;
  if (!Array.isArray(groups)) throw fail(`HTTP ${res.status} answered no minutes-viewed groups`);
  const out: Record<string, number> = Object.fromEntries(asked.map((uid) => [uid, 0]));
  const askedSet = new Set(asked);
  for (const g of groups as Group[]) {
    const uid = g?.dimensions?.uid;
    const minutes = g?.sum?.minutesViewed;
    if (typeof uid !== "string") throw fail("a group carries no uid");
    if (!askedSet.has(uid)) throw fail(`a group names a uid that was not asked for (${groups.length} groups for ${asked.length} uids): the uid filter was not applied`);
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) throw fail(`the group for ${uid} carries no minutes count`);
    out[uid] += minutes;
  }
  return out;
}
