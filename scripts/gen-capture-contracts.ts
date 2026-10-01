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
  CaptureBeat, CaptureBeatAnswer, CaptureDescriptor, CaptureRefusal, CaptureStartBody, CaptureStartOk,
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
        "cred.srt.url": "srt://live.cloudflare.com:778 (as Cloudflare issues it, W21) or the environment's live.* host; null cred.srt means the RTMPS-only safety net (A18). The server never rewrites it (§6.4, G0-i).",
        "cred.srt.latencyMs": "SRT_LATENCY_MS, 2000 (§6.4).",
        "cred.rtmps.url": "the environment's live.* host (live.seazn.club / live.stg.seazn.club) (§6.4, W15, G0-i).",
        endReason: END_REASON,
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
  const next = (n.properties as Json | undefined)?.[path[0]];
  return [...viaUnions, ...(next === undefined ? [] : nodesAt(next, path.slice(1)))];
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
