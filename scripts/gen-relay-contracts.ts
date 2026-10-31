// Generate docs/contracts/relay-job.v1.json from its zod twins (compositor spec 2026-10-14 §5.3; R2002).
//   node --experimental-strip-types scripts/gen-relay-contracts.ts
//
// The JSON file is the cross-repo authority — the compositor vendors it byte for byte (C07) — and the zod twins
// (RelayJobSession, RelayHeartbeat, RelayHeartbeatReply, RelayPhaseReply and RelayPhaseEndpoint in
// apps/web/src/server/api-v1/schemas.ts) mirror it. Modelled on gen-capture-contracts.ts, with ONE difference: the root
// is BARE. It carries only `$schema`, `$id`, `title`, `description` and `$defs` (session, heartbeat, heartbeatReply,
// phaseReply, phaseEndpoint), never a schema twin of its own: a vendoring repo validates against `#/$defs/<name>`. Every STRUCTURAL key comes from z.toJSONSchema; this script adds only the prose,
// and the prose lives here, not hand-typed into the JSON, so a re-run reproduces the file exactly.
//
// A run that changes the file changes its sha256: move the constant in
// apps/web/src/server/api-v1/__tests__/relay-contract.test.ts in the same commit, and tell the compositor to re-vendor.
// That test is the drift gate (checksum, parity, fixtures, vocabularies); this script is not.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RelayHeartbeat, RelayHeartbeatReply, RelayJobSession, RelayPhaseEndpoint, RelayPhaseReply } from "../apps/web/src/server/api-v1/schemas.ts";

type Json = Record<string, unknown>;

/** One shape inside the contract file: the twin, its prose and per-property prose (dotted paths). */
interface Shape {
  twin: z.ZodType;
  description: string;
  props: Record<string, string>;
}

const FILE = "relay-job.v1.json";
const SPEC = "compositor spec 2026-10-14";
const OVERLAY_SPEC = "overlay templates spec 2026-10-15";
const SPONSORS_SPEC = "sponsors on stream spec 2026-10-27";
/** web server/sponsors/airings.ts AIRING_CLOCK_SKEW_MS (spec §3.6.4), in minutes. This script cannot import that module
 *  (it runs under node, without the app's path aliases), so relay-contract.test.ts pins the sentence to the constant. */
const AIRING_CLOCK_SKEW_MINUTES = 10;
const PINNED_BY = "Vendored into the compositor repo (C07); its sha256, parity with its zod twins and its fixtures are pinned by apps/web/src/server/api-v1/__tests__/relay-contract.test.ts.";
const ENVELOPE = "On the wire a 200 is the house envelope `{ \"ok\": true, \"data\": … }` and this shape is its `data`; every refusal is `{ \"ok\": false, … }` with its status.";
const ABSENT = "Omitted when not measured, never sent as 0: a present 0 is a measured zero.";

// ---------------------------------------------------------------------------------------------------------------
// The prose. Every description cites where its rule comes from.
// ---------------------------------------------------------------------------------------------------------------
const SESSION: Shape = {
  twin: RelayJobSession,
  description: `GET /api/internal/relay/sessions/{sid} with \`Authorization: Bearer <job token>\`: the facts a Machine boots from (${SPEC} §5.3; web \`sessionFactsForJob\`). ${ENVELOPE} Strict: no other key. A refused token is 401 (one body for every cause), an unknown session 404, a terminal one 410 with code SESSION_ENDED. The four composed-only keys (input, output, heartbeatIntervalMs, overlayUrl) are absent on a passthrough session; a compositor refuses any session that is not composed or lacks one of them.`,
  props: {
    sessionId: "The broadcast session: the Machine's SESSION_ID.",
    fixtureId: "The fixture the session broadcasts. null once that fixture has been deleted mid-session: the session outlives it and ends through the normal commands (V410 `on delete set null`).",
    mode: "\"passthrough\" (no Machine composes) or \"composed\".",
    themeId: "The overlay theme picked at Go live, or null for the default theme.",
    overlayDelayMs: "How far the score overlay runs behind real time, in milliseconds, fixed for the session when it is created: the fixture's override, or else the measured camera-to-compositor delay (ADR 0006; web config.ts RELAY_OVERLAY_DELAY_DEFAULT_MS). 0 is a real value, never \"unset\". On a composed session it must agree with the `delay=` in overlayUrl.",
    maxDurationMinutes: "The session's own duration cap. A Machine's deadline authority is RELAY_DEADLINE_AT (env), not this.",
    target: "Where the Machine pushes. Passthrough: the organiser's destination. Composed: Cloudflare Input B's RTMPS ingest, never the destination itself (§5.3, R2004).",
    "target.url": "The RTMP(S) ingest URL, without the key.",
    "target.streamKey": "The stream key. A credential: never logged, never in argv, never formatted into an error.",
    pageToken: "A relay-page token for this session: the overlay page's credential. Never logged.",
    input: "Composed only: Cloudflare Input A slot 0's SRT playback, the camera the compositor reads (§5.3, R2004).",
    "input.protocol": "Always \"srt\".",
    "input.url": "srt://host:port and nothing else: no path, no query, no userinfo. The stream id and the passphrase travel as their own fields.",
    "input.streamId": "The SRT stream id. A credential.",
    "input.passphrase": "The SRT passphrase. A credential.",
    output: "Composed only: the programme encode. 1080p30 (1920×1080, 30 fps, 6000 kbps) by default (owner ruling 2026-10-27, compositor F-033), 720p30 (1280×720, 30 fps, 4000 kbps) when set explicitly (compositor ADR 0005). A compositor refuses any other profile.",
    "output.width": "Pixels.",
    "output.height": "Pixels.",
    "output.fps": "Frames per second.",
    "output.videoKbps": "The video bitrate, kbit/s.",
    heartbeatIntervalMs: "Composed only: how often the Machine POSTs its heartbeat, in milliseconds (§5.3; web config.ts RELAY_HEARTBEAT_INTERVAL_MS).",
    overlayUrl: "Composed only: the score overlay page the compositor renders, {APP_URL}/overlay/fixtures/{fixtureId}?sid={sessionId}&st={pageToken}&host=compositor&delay={overlayDelayMs} (R2004). It carries the page token, so it is logged only with its query removed. Its `delay=` appears exactly once and equals overlayDelayMs: the server never serves, and a compositor refuses, a session whose overlayUrl has no `delay=`, has it twice, or has a different value. Neither number is defaulted from the other.",
  },
};

/** The server's exitDetail bound (schemas.ts `.max(200)`), in UTF-16 code units — JavaScript string length. */
const EXIT_DETAIL_UTF16_MAX = 200;

const HEARTBEAT: Shape = {
  twin: RelayHeartbeat,
  description: `POST /api/internal/relay/sessions/{sid}/heartbeat with \`Authorization: Bearer <job token>\`, every heartbeatIntervalMs (${SPEC} §5.3): the Machine's report, and the control channel. The body is bare (no envelope). Strict: an unknown key is a 400, never dropped. Every field but \`state\` is optional. ${ABSENT} null is admitted and stored as sent, but a compositor omits a field rather than sending null. The server keeps the whole latest body and every beat as a sample, except \`airings\`, which it records as proof of play instead. The 200 is \`{ "ok": true, "data": <heartbeatReply> }\`; 400 a body this schema refuses; 401 a refused token; 404 an unknown session; 410 SESSION_ENDED.`,
  props: {
    state: "starting | playing | stalled | stopped. `playing` means the output is connected, whether it carries a slate or the camera (owner ruling 2026-10-14); the camera's own state is in programmePhase and input.",
    videoState: "R1's video state word, verbatim, at most 40 characters. The compositor does not send it.",
    fps: `Programme frames per second. ${ABSENT}`,
    bitrateKbps: `Output bitrate, kbit/s. ${ABSENT}`,
    egressBytes: "Bytes the output has sent since the Machine started, a whole number. Omitted when not measured: an omitted value leaves the stored count unchanged, and only a reported 0 stores 0.",
    measuredLatencyMs: `Measured latency, whole milliseconds. ${ABSENT}`,
    droppedFrames: "Frames dropped (the compositor: encoder overruns that stepped the ladder), a whole number. A present 0 is a measured zero.",
    encoderSpeed: `Encoder speed, 1.0 is real time. ${ABSENT}`,
    cpuPct: `Machine CPU, percent. ${ABSENT}`,
    memMb: `Machine memory, MB. ${ABSENT}`,
    programmePhase: `The programme (compositor C03, C06): \`waiting\` before the first camera frame, \`live\`, \`frozen\` after 0.5 s with no frame, \`reconnecting\` (the slate) after 3 s. Back to \`live\` after 1 s of continuous frames. \`final\` is the final hold (compositor C06 \`Holding\`, its 2026-10-15 amendment; ${OVERLAY_SPEC} §4.2): the compositor enters it on the FIRST end request (an \`ending\` heartbeat reply, a SIGINT, which is web's organiser and deadline stop, or its own deadline, RELAY_DEADLINE_AT) and shows the Final scene for FINAL_HOLD_MS before it drains and sends EOS. A later end request keeps the first one's clock. It is terminal and wins over every camera state, and the exit beat after a hold carries it too. A SIGTERM that arrives before any hold (the platform's controlled stop) drains at once with no hold, so that exit beat does not carry \`final\`.`,
    input: "The camera link, the SRT read of Input A (compositor C04): connecting, connected, or backoff between retries.",
    output: "The programme push to Input B (compositor C04): connecting, connected, or backoff between retries.",
    graphics: "The score overlay renderer (compositor C05): starting, ready, restarting, or failed (the camera goes out without the overlay).",
    inputKicks: "How many times the camera's playback was closed under the compositor within the kick window (5 minutes). A present 0 is a measured zero.",
    inputKickAlert: "true once inputKicks exceeds the alert count (more than 3 in 5 minutes): a second reader or Cloudflare maintenance.",
    pipelineRebuilds: "Camera pipeline builds after the first, since the process started. A present 0 is a measured zero.",
    sinkSwaps: "Output pipeline builds after the first, since the process started. A present 0 is a measured zero.",
    rung: "The degrade ladder's rung (compositor C05): full, or overlay_half_rate, the bottom, where the overlay is refreshed at half rate. The score is never removed (owner ruling 2026-10-18), so the ladder has no lower rung, and the bottom holds: the compositor never steps back up (a restarted process starts on full). Anything but full means the encoder overran and the ladder stepped down: the Machine is short of CPU, and the server raises a sizing alarm.",
    scoreStale: "true while the overlay page cannot reach the score feed (it keeps the last score). Omitted until the page has reported either way.",
    phaseChannel: `Which channel the overlay page reads the programme phase from (${OVERLAY_SPEC} §4.3): \`loopback\`, the compositor's own endpoint (#/$defs/phaseEndpoint, the primary), or \`web\`, the fallback that reads programmePhase from the session's latest beat through the page's data poll (the page switches after 3 failed loopback attempts). Omitted until the page has reported.`,
    exitReason: "Sent only with `state: \"stopped\"`, on the final beat: why the Machine is exiting (compositor C06 `ExitReason`). ended, deadline, signalled and session_gone exit 0; refused exits 78; fatal exits 70; restart exits 75 (the compositor restarts itself in place: the host restarts the process on the same Machine, and the server records the beat and does not count it as a crash). A beat in any other state that carries exitReason or exitDetail is refused (400); this schema states it as its if/then. The server records the reason with the beat; the runner's observed exit stays the authority for how the session ends.",
    airings: `R4 sponsors on stream (${SPONSORS_SPEC} §3.6): the overlay page's proof-of-play items, oldest first. The compositor reads each \`seazn:sponsor:start\` or \`seazn:sponsor:end\` console line (JSON of at most 512 bytes, with exactly the keys below except \`kind\`), sets \`kind\` from the line's name, and buffers at most 64 items: an overflow drops the OLDEST and counts it in airingsDropped. An item is cleared when a beat that carried it is answered 2xx. A 400 or 422 reply drops what that beat carried, counted in airingsDropped (the beat will never be admitted as it is); a 5xx, a transport error or a 410 keeps it for the next beat. The final beat flushes the rest. Validate each item against this shape before buffering it: the beat is strict, so one item this schema refuses makes the whole beat a 400. The server records each item as proof of play, one airing per session and momentId. A repeated start keeps the FIRST row and a repeated end changes nothing, so sending an item again after a lost reply is safe. An item whose \`at\` is more than ${AIRING_CLOCK_SKEW_MINUTES} minutes from the server's clock is refused and counted, and the beat is still answered. The list is not kept with the beat: the stored latest beat and its samples carry every other field, never this one. Omitted when there is nothing to send.`,
    "airings.kind": "`start` (a `seazn:sponsor:start` line: the card went on air) or `end` (a `seazn:sponsor:end` line: it left the screen).",
    "airings.momentId": "The showing's id, as the page logged it: `<seq>:sponsor.<breakKind>` for a break's card, `scene:<sceneId>:<10-second bucket>` for a scene carousel showing. An end names its start's id.",
    "airings.cardId": "The card on air. The server takes a break card's sponsor from its own assignment for the moment, and a scene card's sponsor from this id.",
    "airings.style": "lower_third or banner.",
    "airings.source": "`rotation` for a break's card (the server reads whether the rotation or the operator chose it from its own assignment), `scene` for a scene carousel showing. `operator` is admitted and read like `rotation`.",
    "airings.breakKind": "The natural break the card filled, as the sport declares it (for example over_end). null for a scene carousel showing.",
    "airings.at": "When the page logged the line, in UTC, as JavaScript's `Date.toISOString()` writes it (ending `Z`, never an offset). Pass it through unchanged.",
    "airings.cutShort": "true when the card left before its hold ran out (a score moment cut it, or the operator skipped it).",
    airingsDropped: "How many proof-of-play items the compositor's buffer has dropped since its process started (it holds 64 and drops the oldest): a total for the process and an upper bound, which starts again from 0 when the process restarts. Sent on every beat once above 0, with or without airings. A present 0 is a measured zero.",
    exitDetail: `Sent only with \`state: "stopped"\`, on the final beat: what went wrong, in words. The server's bound is ${EXIT_DETAIL_UTF16_MAX} UTF-16 code units. This schema's maxLength counts characters (code points), and a character is at most two UTF-16 code units, so it publishes ${EXIT_DETAIL_UTF16_MAX / 2} characters: a text within that is never refused. Redacted by the compositor before it is sent (no key, token or query). The server scrubs it again before storing it (anything JWT-shaped, the session's own job token, everything from the first \`?\`), and both stores keep the same text. Human text, never parsed.`,
  },
};

const REPLY: Shape = {
  twin: RelayHeartbeatReply,
  description: `The \`data\` of a heartbeat's 200 (${SPEC} §5.3): what the Machine must do. A Machine takes no inbound traffic, so this reply is the only way a stop reaches it, and the only way web can tell it the phone is back.`,
  props: {
    desiredState: "\"live\": keep going. \"ending\": flush, send EOS and exit 0.",
    phoneLiveEdge: "The session's phone-live edge counter (Owed 108 fix b): web adds 1 each time the session's phone goes from not-live back to live, after it had been live before, so a Machine waiting out its input's reconnect back-off can reconnect at once. Act once per INCREASE of the value you have seen, and treat an increase as a hint: never rebuild an input still receiving frames (latch it and act only at a stall). Web raises it from the phone's own beats, including after the phone had gone silent for the not-responding window (about 30 s), so a web outage of 30 s or more, which silences the phone-to-web leg while video keeps flowing, raises it on every live session at once; that guard absorbs it. The first-ever live is not an edge (the counter first appears at 0). Monotonic for the life of the session and stored by web, so it survives a restart of web or of the Machine. Served on every reply once it exists, so a repeat is not news. Absent, or null (a reader treats both alike), means unknown: the session has no phone, or its phone has not been live yet.",
  },
};

const PHASE_REPLY: Shape = {
  twin: RelayPhaseReply,
  description: `GET http://127.0.0.1:{port}{path}?after=<seq> (#/$defs/phaseEndpoint) inside the Machine: the compositor's loopback reply, which the overlay page reads when its URL carries host=compositor (${OVERLAY_SPEC} §4.3). Served by the compositor, not web, so it is bare JSON with no envelope. \`?after=<seq>\` long-polls: the request is held at most longPollMaxMs. Strict: no other key.`,
  props: {
    phase: "The programme phase, in heartbeat.programmePhase's words.",
    seq: "The phase's sequence number, a whole number, never negative. A reader passes the last one it saw as `after`.",
  },
};

const PHASE_ENDPOINT: Shape = {
  twin: RelayPhaseEndpoint,
  description: `Where the compositor's phase endpoint listens (${OVERLAY_SPEC} §4.3). Not a message: three constants, each published as a const. Web declares them in lib/relay-phase.ts, and a vendoring repo drift-tests its own copies against this file (C12). Loopback only (127.0.0.1) inside the Machine: never exposed outside it, and not part of the outbound-only host contract (compositor ADR 0007). The page is https and the endpoint is loopback, so the compositor answers the preflight with \`Access-Control-Allow-Private-Network: true\` and a CORS origin locked to the app's exact origin.`,
  props: {
    port: "The TCP port on 127.0.0.1. Unprivileged (above 1023) and below Linux's default ephemeral range (32768–60999), so no outbound socket is handed it first.",
    path: "The path: GET {path}?after=<seq>.",
    longPollMaxMs: "The longest a long-poll is held, in milliseconds.",
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Generation (gen-capture-contracts.ts's own helpers, for the same reasons).
// ---------------------------------------------------------------------------------------------------------------
/** Puts `description` first on the node, in place (a parent keeps its reference). */
function setDescription(node: Json, text: string): void {
  const rest = Object.entries(node).filter(([k]) => k !== "description");
  for (const k of Object.keys(node)) delete node[k];
  node.description = text;
  for (const [k, v] of rest) node[k] = v;
}

/** Every node at a dotted property path, through properties / anyOf / oneOf, and into an array's `items` (R4 S8: the
 *  beat's `airings.at` names each item's `at`, in both of the union's branches). */
function nodesAt(node: unknown, path: string[]): Json[] {
  if (node === null || typeof node !== "object") return [];
  const n = node as Json;
  if (path.length === 0) return [n];
  const viaUnions = [...((n.anyOf as Json[] | undefined) ?? []), ...((n.oneOf as Json[] | undefined) ?? []), ...(n.items === undefined ? [] : [n.items])]
    .flatMap((b) => nodesAt(b, path));
  const next = (n.properties as Json | undefined)?.[path[0]];
  return [...viaUnions, ...(next === undefined ? [] : nodesAt(next, path.slice(1)))];
}

/** Review M1: JSON Schema's maxLength counts code points, zod's max counts UTF-16 units, so the twin's 200 would let a
 *  validator admit 150 emoji (300 units) that the server refuses. The file publishes the code-point bound under which any
 *  text fits 200 units — never looser than the twin. The ONE structural key not taken from z.toJSONSchema. */
function publishExitDetailInCodePoints(heartbeat: Json): void {
  const node = (heartbeat.properties as Record<string, Json>).exitDetail;
  const strings = ((node?.anyOf as Json[] | undefined) ?? []).filter((b) => b.type === "string");
  if (strings.length !== 1 || strings[0].maxLength !== EXIT_DETAIL_UTF16_MAX) {
    throw new Error(`heartbeat.exitDetail: expected one string branch with maxLength ${EXIT_DETAIL_UTF16_MAX}, got ${JSON.stringify(node)}`);
  }
  strings[0].maxLength = EXIT_DETAIL_UTF16_MAX / 2;
}

/** Confirm pass, minor 1: the stopped-only rule (RelayHeartbeat's superRefine) in JSON Schema, so the file is not looser
 *  than the twin there either — IF either exit field is present and not null, THEN state is "stopped". z.toJSONSchema
 *  cannot emit a refinement, so this is the second structural key the generator writes itself. */
const EXIT_FIELDS = ["exitReason", "exitDetail"] as const;
function publishStoppedOnly(heartbeat: Json): void {
  const props = heartbeat.properties as Record<string, Json>;
  for (const f of [...EXIT_FIELDS, "state"]) if (!(f in props)) throw new Error(`heartbeat: no property "${f}" for the stopped-only rule`);
  if ("if" in heartbeat || "then" in heartbeat) throw new Error("heartbeat: z.toJSONSchema already wrote an if/then");
  heartbeat.if = {
    type: "object",
    anyOf: EXIT_FIELDS.map((f) => ({ type: "object", required: [f], properties: { [f]: { not: { type: "null" } } } })),
  };
  heartbeat.then = { type: "object", properties: { state: { const: "stopped" } } };
}

function render(shape: Shape, where: string): Json {
  // The round trip unshares nodes: a zod instance reused by two fields (the input/output link enum) may come back as
  // ONE object, and a description set on one field would then land on the other.
  const json = JSON.parse(JSON.stringify(z.toJSONSchema(shape.twin, { target: "draft-2020-12" }))) as Json;
  delete json.$schema;
  for (const [path, text] of Object.entries(shape.props)) {
    const nodes = nodesAt(json, path.split("."));
    // Prose must never fall off silently: a path that matches nothing is a renamed or deleted field.
    if (nodes.length === 0) throw new Error(`${where}: no property at "${path}"`);
    for (const node of nodes) setDescription(node, text);
  }
  // Every property carries prose: a field added to a twin without it fails here, not in a vendoring repo's reading.
  for (const name of Object.keys((json.properties as Json | undefined) ?? {})) {
    if (!(name in shape.props)) throw new Error(`${where}: property "${name}" has no prose`);
  }
  setDescription(json, shape.description);
  return json;
}

const doc: Json = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://seazn.club/contracts/${FILE}`,
  title: "Seazn relay job, v1: the Machine's session facts and heartbeat",
  description: `The web↔Machine contract for a relay session (${SPEC} §5.3, §5.4). The root is bare: validate against #/$defs/session (the GET's data), #/$defs/heartbeat (the POST body) and #/$defs/heartbeatReply (the POST's data). ${ENVELOPE} Inside the Machine, the overlay page reads the compositor's loopback phase endpoint: #/$defs/phaseReply is its reply and #/$defs/phaseEndpoint where it listens (${OVERLAY_SPEC} §4.3). ${PINNED_BY}`,
  $defs: {
    session: render(SESSION, `${FILE}#/$defs/session`),
    heartbeat: ((h) => (publishExitDetailInCodePoints(h), publishStoppedOnly(h), h))(render(HEARTBEAT, `${FILE}#/$defs/heartbeat`)),
    heartbeatReply: render(REPLY, `${FILE}#/$defs/heartbeatReply`),
    phaseReply: render(PHASE_REPLY, `${FILE}#/$defs/phaseReply`),
    phaseEndpoint: render(PHASE_ENDPOINT, `${FILE}#/$defs/phaseEndpoint`),
  },
};

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, "docs", "contracts"), { recursive: true });
const out = join(root, "docs", "contracts", FILE);
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${out}`);
