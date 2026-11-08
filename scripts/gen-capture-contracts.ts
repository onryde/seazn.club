// Generate docs/contracts/capture-*.json from their zod twins (capture QR v2 spec 2026-10-01 §6.14; PR-1 T1).
//   node --experimental-strip-types scripts/gen-capture-contracts.ts
//
// The JSON files are the cross-repo authority — the capture app vendors them byte for byte — and the zod twins
// (apps/web/src/server/api-v1/capture-schemas.ts, CaptureQrV2 in apps/web/src/lib/capture-qr.ts) mirror them.
// Every STRUCTURAL key comes from z.toJSONSchema; this script adds only `$schema`, `$id`, `title` and `description`.
// The prose lives here, not hand-typed into the JSON, so a re-run for the next v-bump reproduces the files exactly.
//
// A run that changes a file changes its sha256: move the constant in
// apps/web/src/server/api-v1/__tests__/capture-contract.test.ts in the same commit, and tell capture to re-vendor.
// That test is the drift gate (checksums, parity, fixtures, the per-state field matrices); this script is not.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CaptureBeat, CaptureBeatAnswer, CaptureDescriptor, CaptureRefusal, CaptureScoringLinkOk, CaptureStartBody, CaptureStartOk,
  CaptureMatchdayDay, CaptureMatchdayRefusal, CaptureMatchdayOpen,
  CaptureMatchdayApprovalReview, CaptureMatchdayApprovalRequest, CaptureMatchdayApprovalOk,
} from "../apps/web/src/server/api-v1/capture-schemas.ts";
import { CaptureQrV2 } from "../apps/web/src/lib/capture-qr.ts";

type Json = Record<string, unknown>;

/** One shape inside a contract file: the twin, its prose, per-property prose (dotted paths) and per-`state` branch prose. */
interface Shape {
  twin: z.ZodType;
  description?: string;
  props?: Record<string, string>;
  branches?: Record<string, string>;
}
interface Contract {
  file: string;
  title: string;
  root: Shape;
  defs?: Record<string, Shape>;
}

const PINNED_BY = "Vendored into the capture repo; its sha256, parity with its zod twin and its fixtures are pinned by apps/web/src/server/api-v1/__tests__/capture-contract.test.ts.";
const SPEC = "capture QR v2 spec 2026-10-01";
const MD_SPEC = "capture S4 Match Day design 2026-11-07";
/** One match as the Match Day list shows it: the same prose wherever a row sits. */
const MD_ROW: Record<string, string> = {
  fixture_id: "The match.",
  sport_key: "The match's sport: it decides which pad the phone opens.",
  division_name: "The match's division.",
  round_label: "The round as the web's board codes it (R2, QF, SF, F, …).",
  home: "The first side's name; null while the seat has no entrant.",
  away: "The second side's name; null while the seat has no entrant.",
  status: "upcoming (not started), in_play, or finished (decided, finalized, held, abandoned, forfeited or cancelled).",
  scheduled_at: "The match's planned start as a UTC instant; null when it has none.",
  summary: "The match's short score while it plays, or its result once finished (the scoreboard's headline); null before any.",
};

// ---------------------------------------------------------------------------------------------------------------
// Shared prose. Every description cites the spec section it comes from.
// ---------------------------------------------------------------------------------------------------------------
const END_REASON = "Why the broadcast ended, on the wire (§6.8.4): every DB end or fail reason maps to exactly one value. `failed` is a server-side end that is neither a stop nor a timeout (G0-f), including a completed session with no recorded end reason (R11).";
const REFUSAL = {
  code: "The machine word the phone keys its copy on (§4).",
  message: "A plain English developer string; the phone never shows it (§4).",
  sid: "already_live only: the session that is already live (§6.3.4, ask 4).",
  startedBy: "already_live only: who started it (§6.3.4, ask 4).",
};
const COMMON_PROSE = (scheduledStart: string): Record<string, string> => ({
  label: "\"{side A} v {side B}\", or \"Match {n}\" in the competition's locale while a side is not yet known; at most 200 characters, cut with one \"…\" (§6.4, W25, §17.6).",
  scheduledStart,
  autoAllowed: "Whether the server may start the broadcast on its own; always false in PR-1 (§6.4, §7.1).",
  destinationName: "The pre-picked destination's label, at most 80 characters cut with one \"…\"; null when there is none or it is archived (§6.4, §6.7.3, §17.6).",
  overlayUrl: "The scorebug overlay page, or null when the org lacks streaming.overlay (§6.4.1, W11, W18).",
  pollSeconds: "How often the phone polls and beats, 5 to 300 seconds (§6.6, §6.9).",
});

/** W28 (2026-10-06): the descriptor's `stage`, on every state. The kinds are the engine's `RoundRole` kinds as of
 *  2026-10-06; capture-contract.test.ts pins this list against the engine's own type. */
const ROLE_KINDS = [
  "round_of", "quarter_final", "semi_final", "final", "winners_final", "losers_round", "losers_final", "grand_final",
  "grand_final_reset", "third_place", "qualifier1", "eliminator", "qualifier2", "rung", "plain_round",
];
const STAGE_PROSE: Record<string, string> = {
  stage: "Where the match sits in its stage (W28, added 2026-10-06): the scheduler board's chip, the round's role, the pool and (2026-10-07) the label the phone shows. On the waiting shape and every session state; omitted, never null, when no code can be produced. Recomputed on every read.",
  "stage.code": "Exactly the scheduler board's chip for this match, 1 to 8 characters: a bracket round's short code (QF, SF, F, 3rd, R16, WB2, LB3, GF, Q1, E, E2, …) or R{round} where the board codes no round (a league, a group, a Swiss round). In the language the label uses (the org's locale, W25): a Spanish org reads CF for a quarter-final.",
  "stage.role": "The engine's round role for this match, serialised verbatim: kind, plus n or entrants where the role has one (W28).",
  "stage.role.kind": `The role's kind. An OPEN string: today's values are ${ROLE_KINDS.map((k) => `\`${k}\``).join(", ")}. Consumers show nothing for an unknown kind — a newer server may send one (W28).`,
  "stage.role.n": "The round number the role carries (losers_round, rung, plain_round), from 1 (W28).",
  "stage.role.entrants": "round_of only: how many entrants the round starts with, from 2 (W28).",
  "stage.pool": "The key of the match's pool, one capital letter (A, B, …), present only for a pooled group match. Never the pool's display name (W28).",
  "stage.label": "What the phone shows for the stage, verbatim, 1 to 40 characters, in the org's locale (W28, added 2026-10-07; reshaped 2026-10-08): the division's name, then the pool's word and key for a pooled match, then the round, joined with \" · \" (\"Open · Round 2\", \"Open · QF\", \"Open · Final\", \"Girls U14 · Group A · Round 2\", \"Open · Grupo A · Ronda 1\"). The round is \"Round {n}\" where the board codes no round (n is the number in its R{n} code); the final, the third-place match and the grand final use their long names (\"Final\", \"Third place\", \"Grand final\"); every other round uses its code. Over 40 characters the pool is dropped first, then the division; a round still over 40 omits the label. Omitted, never cut; show nothing then.",
};

const contracts: Contract[] = [
  {
    file: "capture-qr.v2.json",
    title: "Seazn capture QR payload, v2",
    root: {
      twin: CaptureQrV2,
      description: `What the organiser's panel encodes in the stream QR, and the paste code's exact text (${SPEC} §6.2, W3). The panel sends exactly four keys, in the order v, code, slot, tok; exp is capture's optional field (A1, §1.2), which this server never sends. No other key is admitted. The QR never carries credentials: the phone fetches them with the tok (§6.3.1). Supersedes capture-qr.v1.json, removed (W4, §6.13). ${PINNED_BY}`,
      props: {
        v: "The payload version (§6.2). A phone that reads any other value says \"update the app\", never \"bad QR\".",
        code: "The fixture's stable stream code: 12 characters of lowercase Crockford base32 (§6.1, W1). An identifier, not a secret, and the only path segment of the phone API (§6.3, §10.1).",
        slot: "The camera slot, 0 in PR-1. The phone sends it back as ?slot= and in every beat (§6.3.1).",
        tok: "The bearer secret: 16 random bytes as base64url, 22 characters (§6.1). It authorises pairing and POST start, and travels only as `Authorization: Bearer`, never in a body, a URL or a log (§10.1).",
        exp: "Optional: when the QR expires, in epoch SECONDS (v1's unit), an integer of at least 0 (capture's A1, §1.2). Absent means the server decides. This server never sends it (§6.2), so a phone must accept a QR without it; null is not admitted.",
      },
    },
  },
  {
    file: "capture-descriptor.v1.json",
    title: "Seazn capture descriptor, v1: GET /api/v1/capture/codes/{code}",
    root: {
      twin: CaptureDescriptor,
      description: `The 200 answer to GET /api/v1/capture/codes/{code}?slot=&phone= (${SPEC} §6.3.1, §6.4; amended §17.5, R5 final, agreed with capture 2026-10-01): a union on \`state\`. \`waiting\` is the waiting shape; warming, live, ending, completed and failed are the session shape. Each state admits only its own fields, and a field from another state is refused, never ignored. A field that is not required is omitted when it does not apply, never sent as null (§4). There is no hint field: a session shape without cred is the hint to claim (§6.3.1). $defs.refusal is the body of every refusal (§4). This route never sends 410 (ask 8). ${PINNED_BY}`,
      branches: {
        waiting: "No session for the slot, a session still requested or provisioning (then pollSeconds is 5), a session that ended before warming, or a caller without ?phone= (§6.3.1).",
        warming: "An open session warming up; cred only to the slot's current phone (§6.3.1, §5.3).",
        live: "An open live session; cred only to the slot's current phone (§6.3.1).",
        ending: "An open session that is ending, with its endReason; cred only to the slot's current phone (§6.3.1, §17.5).",
        completed: "An ended session with its endReason, served until a newer session is created; no cred (§6.3.1).",
        failed: "A failed session with its endReason, served until a newer session is created; no cred (§6.3.1).",
      },
      props: {
        code: "The stream code (§6.1).",
        venueTimezone: "IANA zone: the division's override, then the org's timezone, then UTC (§6.4).",
        ...COMMON_PROSE("fixtures.scheduled_at as epoch seconds; omitted, never null, when the fixture has none (§6.4, §4)."),
        heartbeatUrl: "Where the phone POSTs its beats: {origin}/api/v1/capture/codes/{code}/beats (§6.4, §6.3.2).",
        startUrl: "Where the phone POSTs Go live: {origin}/api/v1/capture/codes/{code}/start (§6.4, §6.3.4).",
        sid: "The broadcast session (§6.3.1).",
        preferred: "The transport to publish on. It never names a null shape: \"rtmps\" whenever cred.srt is null (§6.4, A18).",
        playbackUrl: "The bare HLS manifest, with no query (§6.4, W14).",
        holdWindowSeconds: "Per transport, how long the ingest holds a dropped publish before the broadcast ends; each at most 999 (§6.4).",
        maxDurationMinutes: "The session's own duration cap (§6.4).",
        warmingDeadline: "warming_at + WARMING_TIMEOUT_MINUTES, as epoch seconds (§6.4, §5.3).",
        scoreUpdates: "\"realtime\" when overlayUrl carries a key, \"polled\" otherwise (§6.4).",
        cred: "present only to the slot's current phone; absent = claim first (G0-d). Only in warming, live and ending (§6.3.1, §10.2, §17.5).",
        "cred.srt": "SRT publish settings. null is A18's RTMPS-only safety net (STREAM_SRT_ENABLED off), and preferred is then \"rtmps\" (§6.4, W21).",
        "cred.srt.url": "srt://live.cloudflare.com:778, exactly as Cloudflare issues it, in every environment; there is no custom ingest host. null cred.srt means the RTMPS-only safety net (A18). The server never rewrites it (§6.4, W21, W26).",
        "cred.srt.latencyMs": "SRT_LATENCY_MS, 2000 (§6.4).",
        "cred.rtmps.url": "rtmps://live.cloudflare.com:443/live/, exactly as Cloudflare issues it, in every environment; there is no custom ingest host (§6.4, W26, superseding W15).",
        endReason: END_REASON,
        ...STAGE_PROSE,
      },
    },
    defs: {
      refusal: {
        twin: CaptureRefusal,
        description: "Every refusal: `code` is the machine word the phone keys its copy on; `message` is a developer string, never shown (§4). This route answers 401 code_ended for an unknown code, a wrong tok or an ended code, and 404 not_a_stream_code for a malformed code; 422, 429 (with Retry-After) and 503 count as no evidence (§6.3.1, §10.1).",
        props: REFUSAL,
      },
    },
  },
  {
    file: "capture-beat.v1.json",
    title: "Seazn capture beat, v1: POST /api/v1/capture/codes/{code}/beats",
    root: {
      twin: CaptureBeat,
      description: `The phone's heartbeat body (${SPEC} §6.3.2; \`at\` amended §17.5, R5 final, agreed with capture 2026-10-01). Strict: anything malformed is 422, which the phone counts as a failed beat. $defs.answer is the 200 answer (§6.3.3). A beat never answers 410 (ask 8). ${PINNED_BY}`,
      props: {
        code: "The stream code (§6.1).",
        slot: "The camera slot, 0 in PR-1 (§6.3.1).",
        phone: "The phone's own install id (§6.3.2, §6.5).",
        claim: "\"new\" or \"resume\" on a claim beat, otherwise null (§6.5, ask 2). A claim rides only until the pairing's first 2xx, so it is never together with cause \"rejoin\" (a rejoin follows a 2xx live); the server refuses that pair with 422 (D16).",
        device: "{model} on a claim beat, Build.MODEL only, otherwise null; read only on a claim (G0-e, §6.3.2).",
        sid: "The session this phone holds, or null (§6.3.2).",
        at: "When the phone took the beat: ISO-8601 with any offset; a value with no zone is refused. The server normalises it to UTC before storing it; the phone sends Z (§17.5, R5).",
        state: "The phone's own state, in kebab-case (§6.3.2, §4).",
        cause: "Why the broadcast this phone holds was started (§6.3.2). Non-null only while sid is non-null (a broadcast is held), otherwise null; never \"rejoin\" on a claim beat. The server refuses either breach with 422 (D16, capture's field-by-field check 2026-10-01).",
        stopped: "A session this phone stopped; only while sid is null (§6.3.2, capture RR3, §6.8.2).",
        mode: "\"automatic\" or \"operator\" (§6.3.2, §4).",
        appVersion: "The capture app's version (§6.3.2).",
        endReason: "Only \"operator-stopped\", and only with state \"ended\" (§6.3.2, §6.8.2).",
      },
    },
    defs: {
      answer: {
        twin: CaptureBeatAnswer,
        description: "The 200 answer to a beat (§6.3.3; amended §17.5, R5 final): a union on `state`. The first precedence row that applies wins: taken, replaced, over, waiting, go-live, live. The common fields (label, scheduledStart, autoAllowed, destinationName, overlayUrl, pollSeconds) are required on waiting, go-live, live and over, and optional on replaced and taken; PR-1's server still sends them on every 2xx (ask 1). sid, startedBy and endReason are omitted where they do not apply, never null.",
        branches: {
          taken: "The beat's new claim was refused (§6.3.3 row 1, G0-g).",
          replaced: "The caller is not the slot's current phone (§6.3.3 row 2, ask 2, G0-g).",
          over: "The beat named an ended sid, by its sid or its stopped: show the line for endReason (§6.3.3 row 3, ask 8).",
          waiting: "The slot is empty, paired or starting; while starting, pollSeconds is 5 (§6.3.3 rows 4 and 5).",
          "go-live": "The slot is armed: publish to sid; startedBy says who asked (§6.3.3 row 6).",
          live: "The slot is live, with or without video: keep publishing to sid. No startedBy (§6.3.3 row 7, §17.5).",
        },
        props: {
          sid: "The broadcast session (§6.3.3).",
          startedBy: "go-live only: who asked for the broadcast (§6.3.3, §17.5).",
          endReason: END_REASON,
          device: "replaced and taken only: the current phone's model, for the organiser panel's takeover notice. The phone ignores it, and PR-1 never sends it (G0-e, §7.5, §17.5).",
          ...COMMON_PROSE("fixtures.scheduled_at as epoch seconds, or null when the fixture has none (§6.4, §4)."),
        },
      },
    },
  },
  {
    file: "capture-start.v1.json",
    title: "Seazn capture start, v1: POST /api/v1/capture/codes/{code}/start",
    root: {
      twin: CaptureStartBody,
      description: `Go live from the phone (${SPEC} §6.3.4, §6.7): the request body. $defs.ok is the 200 answer and $defs.refusal every refusal body. Not idempotent by design: a retry after a lost 200 meets 409 already_live naming the same sid, and the phone treats that as success. ${PINNED_BY}`,
      props: {
        phone: "The phone's own install id. A phone that is not the slot's current phone gets 409 replaced (§6.3.4, ask 9).",
      },
    },
    defs: {
      ok: {
        twin: CaptureStartOk,
        description: "200: the broadcast was started (§6.3.4). The bare shape, never an {ok, data} envelope (§4).",
        props: { sid: "The broadcast session (§6.3.4)." },
      },
      refusal: {
        twin: CaptureRefusal,
        description: "Every refusal: `code` is the machine word the phone keys its copy on; `message` is a developer string, never shown (§4). 409 already_live (with sid and startedBy), 409 replaced, 409 no_destination, 402 no_credit, 403 not_entitled, 503 unavailable, 401 code_ended; 422 invalid and 429 rate_limited (with Retry-After) (§6.3.4, §6.7.2).",
        props: REFUSAL,
      },
    },
  },
  {
    file: "capture-scoring-link.v1.json",
    title: "Seazn capture scoring link, v1: POST /api/v1/capture/codes/{code}/scoring-link",
    root: {
      twin: CaptureStartBody,
      description: `The match's Remote scoring link, for the slot's current phone (${SPEC} §6.3.5, W27, added 2026-10-06): the request body, the start's own. $defs.ok is the 200 answer and $defs.refusal every refusal body. The server never removes or replaces an existing link: it returns the match's live link, or creates one. A repeat call returns the same url. ${PINNED_BY}`,
      props: {
        phone: "The phone's own install id. A phone that is not the slot's current phone gets 409 replaced (§6.3.5).",
      },
    },
    defs: {
      ok: {
        twin: CaptureScoringLinkOk,
        description: "200: the match's Remote scoring link (§6.3.5, W27). The bare shape, never an {ok, data} envelope (§4).",
        props: { url: "The scoring pad's address: the server's https origin, /score/, and the link's secret (dl_ and 43 base64url characters). It is a credential: open it, show it as a QR, never log it." },
      },
      refusal: {
        twin: CaptureRefusal,
        description: "Every refusal: `code` is the machine word the phone keys its copy on; `message` is a developer string, never shown (§4). 409 replaced (not the slot's current phone), 409 match_finished (the match is finalized or cancelled), 402 not_entitled (the plan has no scoring links), 503 unavailable, 401 code_ended, 404 not_a_stream_code; 422 invalid and 429 rate_limited (with Retry-After) (§6.3.5, W27).",
        props: REFUSAL,
      },
    },
  },
  {
    file: "capture-matchday-day.v1.json",
    title: "Seazn Match Day code day read, v1: GET /api/v1/match-day-code",
    root: {
      twin: CaptureMatchdayDay,
      description: `What a phone holding a Match Day code lists (${MD_SPEC} §5, §9.3; MD-1 Task 3), authenticated by Authorization: Bearer md_… only. The answer is \`data\` in the v1 envelope {ok: true, data, requestId}; $defs.refusal is \`error\` in {ok: false, error, requestId}. It never carries the code's token or any scoring link. ${PINNED_BY}`,
      props: {
        competition: "The competition the code was minted for: its id and name.",
        scope: "The code's scope: kind competition (every court, and the matches with no court), venue (that venue's courts) or courts (exactly those courts). label is what the header shows: the competition's name, the venue's name, or the courts' names joined with \", \" in the board's order.",
        day: "The day the code is good for, YYYY-MM-DD, in tz.",
        tz: "The IANA zone the day is in: the competition's organisation's zone (one zone per code).",
        opens_at: "00:00 of day in tz, as a UTC instant. Before it the code answers 403 MD_NOT_OPEN.",
        expires_at: "24:00 of day in tz, as a UTC instant. From it the code answers 410 MD_ENDED.",
        can_approve: "Whether the code was minted with \"can approve draws\": without it the phone shows an approval's banner with no button.",
        courts: "One card per court in scope, in the order the web gives (the organisation's venue order, then its court order): the board's courts — every live division's candidate courts and every court holding one of the competition's matches today.",
        "courts.court_name": "The court's name as the web's board names it.",
        "courts.venue_name": "The court's venue's name.",
        "courts.state": "playing (one of the competition's matches is in play on it), called (one is called onto it), free, or in_use_elsewhere (another competition holds it).",
        "courts.now": "The match playing or called on the court, if it is the competition's and in the code's scope; null otherwise.",
        "courts.next": "The court's queue: the competition's matches planned on it today, not started and not called, in planned order.",
        "courts.finished": "The competition's matches finished on the court today (not cancelled), newest first.",
        no_court: "A whole-competition code only (empty otherwise): the matches in play on no court, then the ready matches with no court planned no later than today, in the desk's order.",
        online: "Online chess boards, read-only. Always empty until the web's all-in-one read model lists them.",
        approvals: "The approvals waiting in the code's scope, listed whether or not can_approve: a knockout whose draw (the seed proposal) is owed, or a Swiss stage whose previous round is complete and whose next round is unpaired. A narrowed code lists a stage only when one of its matches today is on its courts. A division whose schedule is locked lists none: the web desk's.",
        "approvals.kind": "draw (the seed proposal from groups into a knockout) or swiss (the next Swiss round).",
        "approvals.stage_id": "The stage to review and approve.",
        "approvals.label": "The stage's name.",
        "approvals.round": "swiss only: the round awaiting pairing (the phone's \"Round 4 pairings are ready\"); null for a draw.",
        ...Object.fromEntries(
          ["courts.now", "courts.next", "courts.finished", "no_court", "online"].flatMap((at) =>
            Object.entries(MD_ROW).map(([field, text]) => [`${at}.${field}`, text]),
          ),
        ),
      },
    },
    defs: {
      refusal: {
        twin: CaptureMatchdayRefusal,
        description: "Every refusal, the envelope's error: 401 MD_UNKNOWN (no such code, or no md_ bearer), 410 MD_WITHDRAWN, 410 MD_ENDED, 403 MD_NOT_OPEN (with opens_at). The open and the approvals answer MD_OUT_OF_SCOPE, MD_NO_APPROVE, MD_STALE, MD_ALREADY and MD_TIES too. A 429 RATE_LIMITED (with Retry-After) is the v1 envelope's own answer, outside this shape.",
        props: {
          code: "The machine word the phone keys its copy on: one of the plan's MD_ words, a closed list. The v1 envelope's own answers (429 RATE_LIMITED, 404 NOT_FOUND, 500 INTERNAL) are not md_ refusals and are outside this shape; the phone reads them by status.",
          message: "A plain English developer string; the phone never shows it.",
          opens_at: "MD_NOT_OPEN only: when the code's day starts, as a UTC instant.",
        },
      },
    },
  },
  {
    file: "capture-matchday-open.v1.json",
    title: "Seazn Match Day code open, v1: POST /api/v1/match-day-code/fixtures/{id}/scoring-link",
    root: {
      twin: CaptureMatchdayOpen,
      description: `What a phone holding a Match Day code gets when it opens a match (${MD_SPEC} §6, §9.4; MD-1 Task 4), authenticated by Authorization: Bearer md_… only, with no body. The answer is \`data\` in the v1 envelope {ok: true, data, requestId}; $defs.refusal is \`error\` in {ok: false, error, requestId}. ${PINNED_BY}`,
      props: {
        kind: "link (the match's scoring link) or finished (the match is finalized or cancelled: there is nothing to score, and nothing was written).",
        url: "link only: the match's own Remote scoring link, https://{host}/score/dl_{43 base64url}, the printed QR's when the match has one. Re-shown on every open, never a second link beside a live one, and nothing is revoked. A credential: the phone hands it to its scoring pad and stores it as a scan of that QR would be.",
        sport_key: "link only: the match's sport: it decides which pad the phone opens.",
      },
    },
    defs: {
      refusal: {
        twin: CaptureMatchdayRefusal,
        description: "Every refusal, the envelope's error: 401 MD_UNKNOWN (no such code, or no md_ bearer), 410 MD_WITHDRAWN, 410 MD_ENDED, 403 MD_NOT_OPEN (with opens_at), 403 MD_OUT_OF_SCOPE (the match is not in the code's competition, venue or courts, or not on its day, at the moment of asking). A 404 NOT_FOUND (no such match) and a 429 RATE_LIMITED (with Retry-After) are the v1 envelope's own answers, outside this shape.",
        props: {
          code: "The machine word the phone keys its copy on: one of the plan's MD_ words, a closed list. The v1 envelope's own answers (429 RATE_LIMITED, 404 NOT_FOUND, 500 INTERNAL) are not md_ refusals and are outside this shape; the phone reads them by status.",
          message: "A plain English developer string; the phone never shows it.",
          opens_at: "MD_NOT_OPEN only: when the code's day starts, as a UTC instant.",
        },
      },
    },
  },
  {
    file: "capture-matchday-approval.v1.json",
    title: "Seazn Match Day code approval, v1: GET|POST /api/v1/match-day-code/approvals/{kind}/{stageId}",
    root: {
      twin: CaptureMatchdayApprovalReview,
      description: `An approval as a phone holding a Match Day code reviews it (${MD_SPEC} §7, §9.5; MD-1 Task 6): GET /api/v1/match-day-code/approvals/{kind}/{stageId}, kind swiss or draw, authenticated by Authorization: Bearer md_… only, and only for a code minted with "can approve draws". The root is the review, \`data\` in the v1 envelope {ok: true, data, requestId}. POST to the same path with $defs.request approves it and answers $defs.ok; $defs.refusal is \`error\` in {ok: false, error, requestId}. Nothing in it is a credential. ${PINNED_BY}`,
      props: {
        kind: "swiss (the next round of a Swiss stage) or draw (the seed proposal from groups into a knockout).",
        stage_id: "The stage the approval acts on: the day read's approvals.stage_id.",
        division_name: "The stage's division.",
        round: "swiss: the round awaiting pairing, the day read's approvals.round; the approve hands it back. draw: null.",
        rows: "What the server computed, read-only, in order: swiss, one row per board of the round, the bye last with away null; draw, one row per knockout match a qualifier is drawn into, in round then match order. To change a slot, the organiser uses the web desk.",
        "rows.label": "The row's place: the round as the web's board codes it (R4, QF, SF, F, …), then its number in the round when the round holds more than one (R4 1, QF 2).",
        "rows.home": "The first side's name.",
        "rows.away": "The second side's name; null on a bye, or in a knockout match whose other seat is fed from elsewhere.",
        hash: "What the approve hands back, unchanged: swiss, a hash of the round's inputs (results, field, stage settings and lots); draw, the proposal's id. An approve whose hash is no longer the server's is refused MD_STALE.",
        ties: "draw only (swiss: false): the draw has a tie only the web desk can resolve. The phone shows it and does not approve it; an approve is refused MD_TIES.",
      },
    },
    defs: {
      request: {
        twin: CaptureMatchdayApprovalRequest,
        description: "The approve's body, POST /api/v1/match-day-code/approvals/{kind}/{stageId}: the review's hash, and for swiss its round.",
        props: {
          hash: "The review's hash, unchanged.",
          round: "swiss: the review's round (required: an approve without it is a 422). draw: omitted, or null.",
        },
      },
      ok: {
        twin: CaptureMatchdayApprovalOk,
        description: "The approve's 200: this request approved it. The new matches are on the server at once; the phone refreshes its day read. A second phone's approve is the refusal MD_ALREADY, never this.",
        props: {
          ok: "Always true.",
        },
      },
      refusal: {
        twin: CaptureMatchdayRefusal,
        description: "Every refusal, the envelope's error: 401 MD_UNKNOWN (no such code, or no md_ bearer), 410 MD_WITHDRAWN, 410 MD_ENDED, 403 MD_NOT_OPEN (with opens_at), 403 MD_NO_APPROVE (the code was minted without \"can approve draws\", or the division's schedule is locked — the desk's, and the day read lists none of its approvals: the review AND the approve), 403 MD_OUT_OF_SCOPE (the stage is not in the code's competition, or for a venue or courts code none of its matches is on those courts on the code's day), 409 MD_STALE (the hash is no longer the server's — a result, the field, a seat or the proposal changed — or the approval is not ready: the round before is still in play, the groups are not complete, or nobody is left to seed; review again), 409 MD_ALREADY (approved already: another phone or the desk was first), 409 MD_TIES (draw: a tie the web desk must resolve). Every 409 is one of these words. A 404 NOT_FOUND (no such stage, kind or proposal), a 422 (a swiss approve without a whole round, or a kind the stage has not: a swiss approval of a stage that is not a Swiss, a draw of a Swiss stage), any other 4xx refusal (by its status, with no word of its own), a 429 RATE_LIMITED (with Retry-After) and a 500 INTERNAL (a fault on the server) are the v1 envelope's own answers, outside this shape.",
        props: {
          code: "The machine word the phone keys its copy on: one of the plan's MD_ words, a closed list. The v1 envelope's own answers (429 RATE_LIMITED, 404 NOT_FOUND, 422, 500 INTERNAL) are not md_ refusals and are outside this shape; the phone reads them by status.",
          message: "A plain English developer string; the phone never shows it.",
          opens_at: "MD_NOT_OPEN only: when the code's day starts, as a UTC instant.",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Generation.
// ---------------------------------------------------------------------------------------------------------------
/** Puts `description` first on the node, in place (a parent keeps its reference). */
function setDescription(node: Json, text: string): void {
  const rest = Object.entries(node).filter(([k]) => k !== "description");
  for (const k of Object.keys(node)) delete node[k];
  node.description = text;
  for (const [k, v] of rest) node[k] = v;
}

/** Every node at a dotted property path, through properties / anyOf / oneOf. */
function nodesAt(node: unknown, path: string[]): Json[] {
  if (node === null || typeof node !== "object") return [];
  const n = node as Json;
  if (path.length === 0) return [n];
  const viaUnions = [...((n.anyOf as Json[] | undefined) ?? []), ...((n.oneOf as Json[] | undefined) ?? [])].flatMap((b) => nodesAt(b, path));
  // An array's members (MD-1, the Match Day lists): a path walks through `items` as through a union branch.
  const viaItems = n.items === undefined ? [] : nodesAt(n.items, path);
  const next = (n.properties as Json | undefined)?.[path[0]];
  return [...viaUnions, ...viaItems, ...(next === undefined ? [] : nodesAt(next, path.slice(1)))];
}

function render(shape: Shape, where: string): Json {
  // The round trip unshares nodes: a zod instance reused by two fields (Url, EpochS) may come back as ONE object,
  // and a description set on one field would then land on the other.
  const json = JSON.parse(JSON.stringify(z.toJSONSchema(shape.twin, { target: "draft-2020-12" }))) as Json;
  delete json.$schema;
  for (const [path, text] of Object.entries(shape.props ?? {})) {
    const nodes = nodesAt(json, path.split("."));
    // Prose must never fall off silently: a path that matches nothing is a renamed or deleted field.
    if (nodes.length === 0) throw new Error(`${where}: no property at "${path}"`);
    for (const node of nodes) setDescription(node, text);
  }
  for (const [state, text] of Object.entries(shape.branches ?? {})) {
    const branch = ((json.oneOf as Json[] | undefined) ?? []).find(
      (b) => (b.properties as Record<string, Json> | undefined)?.state?.const === state,
    );
    if (!branch) throw new Error(`${where}: no oneOf branch for state "${state}"`);
    setDescription(branch, text);
  }
  if (shape.description) setDescription(json, shape.description);
  return json;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, "docs", "contracts"), { recursive: true });
for (const c of contracts) {
  const body = render(c.root, c.file);
  const { description, ...structure } = body;
  const doc: Json = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://seazn.club/contracts/${c.file}`,
    title: c.title,
    description,
    ...structure,
  };
  if (c.defs) doc.$defs = Object.fromEntries(Object.entries(c.defs).map(([name, shape]) => [name, render(shape, `${c.file}#/$defs/${name}`)]));
  const out = join(root, "docs", "contracts", c.file);
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${out}`);
}
