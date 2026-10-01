// The capture QR v2 phone↔web contract (spec 2026-10-01 §4, §6.2, §6.3, §6.14, §17.5; PR-1 T1).
//
// docs/contracts/capture-*.json are the cross-repo authority: the capture app vendors them byte for byte. The zod
// twins (server/api-v1/capture-schemas.ts, and CaptureQrV2 in lib/capture-qr.ts) mirror them. This file pins:
//   * each contract's sha256 — a change is a deliberate bump that moves the constant in the same commit;
//   * structural parity, file ↔ z.toJSONSchema(twin), per union branch matched by `state`;
//   * every hand-written fixture: `valid*` parses, `invalid-*` / `tampered*` / `wrong-version` is refused — by the zod
//     twin AND by the published JSON bytes under ajv (draft 2020-12, formats asserted), so the vendored file is proven
//     behaviourally, not only structurally;
//   * every enum, typed here from the spec's literal lists (§6.3.1–§6.3.4), against the file and the twin;
//   * the per-state field matrices (R5 final, A21), TYPED HERE FROM THE SPEC'S TEXT (§6.3.1, §17.5) — the rulebook,
//     never read off the twin — run against BOTH the twin (through the fixtures) and the JSON file (structurally);
//   * optional-versus-null, `at`'s offset, strictness surviving .extend()/.partial(), W21's hosts, QR v2 (with
//     capture's optional `exp`, which this server never sends), and 409.
// Every sweep counts what it checked, and the counts are pinned: a skipped cell, branch or fixture fails the run.
//
// Pure — no DB. One "sport" on purpose: the contract reads no sport (the capture surface is sport-agnostic).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import * as CS from "../capture-schemas";
import * as S from "../schemas";
import { CaptureQrV2, captureQrV2Text, parseCaptureQrV2 } from "@/lib/capture-qr";

type Json = Record<string, unknown>;
type Twin = z.ZodType;

const CONTRACTS = resolve(import.meta.dirname, "../../../../../../docs/contracts");
const FIXTURES = resolve(CONTRACTS, "fixtures");
const contractText = (file: string): string => readFileSync(resolve(CONTRACTS, file), "utf8");
const contract = (file: string): Json => JSON.parse(contractText(file)) as Json;
const fixture = (dir: string, name: string): Json =>
  JSON.parse(readFileSync(resolve(FIXTURES, dir, `${name}.json`), "utf8")) as Json;
const parses = (twin: Twin, value: unknown): boolean => twin.safeParse(value).success;
const without = (o: Json, key: string): Json => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

/** `shasum -a 256 docs/contracts/<file>`. A contract change is a DELIBERATE bump: it moves its constant here in the
 *  same commit, and capture re-vendors the file. */
const SHA256: Record<string, string> = {
  "capture-qr.v2.json": "3292e33f84b693e5def6048012f6653ca7e31e1573fda3901da4fe67a62c5d43",
  "capture-descriptor.v1.json": "3052101953e6998969749455a10b7343621e6b1c37908457c3520477b8a38612",
  "capture-beat.v1.json": "acaeb033927340fd9782894d99f821d848f52bcf32266b592a0730a6ba9f818f",
  "capture-start.v1.json": "d48f45fee7d1a73da22da83f3406bcaeb6a0b1f1c734278313de294f9215b2ea",
};

// ---------------------------------------------------------------------------------------------------------------
// The rulebook, typed from the spec's text.
// ---------------------------------------------------------------------------------------------------------------
type Cell = "required" | "optional" | "forbidden";
const REQ: Cell = "required", OPT: Cell = "optional", NO: Cell = "forbidden";

/** §17.5: "The common fields are label, scheduledStart: epoch-s | null, autoAllowed, destinationName: string | null,
 *  overlayUrl: string | null and pollSeconds." */
const COMMON = ["label", "scheduledStart", "autoAllowed", "destinationName", "overlayUrl", "pollSeconds"] as const;
const COMMON_NULLABLE = new Set<string>(["scheduledStart", "destinationName", "overlayUrl"]);
const ANSWER_FIELDS = ["sid", "startedBy", "endReason", "device", ...COMMON] as const;
type AnswerField = (typeof ANSWER_FIELDS)[number];
const answerRow = (sid: Cell, startedBy: Cell, endReason: Cell, device: Cell, common: Cell): Record<AnswerField, Cell> => ({
  sid, startedBy, endReason, device, ...(Object.fromEntries(COMMON.map((f) => [f, common])) as Record<(typeof COMMON)[number], Cell>),
});
/** §17.5's table, row for row (absent = forbidden). */
const ANSWER_MATRIX: Record<string, Record<AnswerField, Cell>> = {
  waiting: answerRow(NO, NO, NO, NO, REQ),
  "go-live": answerRow(REQ, REQ, NO, NO, REQ),
  live: answerRow(REQ, NO, NO, NO, REQ),
  over: answerRow(REQ, NO, REQ, NO, REQ),
  replaced: answerRow(NO, NO, NO, OPT, OPT),
  taken: answerRow(NO, NO, NO, OPT, OPT),
};

/** §6.3.1's session shape, the fields the waiting shape lacks; §17.5: "endReason is required on ending, completed and
 *  failed, and absent on warming and live; cred is optional on warming, live and ending, and absent on completed and
 *  failed." */
const SESSION_ONLY = ["sid", "preferred", "playbackUrl", "holdWindowSeconds", "maxDurationMinutes", "warmingDeadline", "scoreUpdates"] as const;
const DESCRIPTOR_FIELDS = ["cred", "endReason", ...SESSION_ONLY] as const;
type DescriptorField = (typeof DESCRIPTOR_FIELDS)[number];
const descriptorRow = (cred: Cell, endReason: Cell, session: Cell): Record<DescriptorField, Cell> => ({
  cred, endReason, ...(Object.fromEntries(SESSION_ONLY.map((f) => [f, session])) as Record<(typeof SESSION_ONLY)[number], Cell>),
});
const DESCRIPTOR_MATRIX: Record<string, Record<DescriptorField, Cell>> = {
  waiting: descriptorRow(NO, NO, NO),
  warming: descriptorRow(OPT, NO, REQ),
  live: descriptorRow(OPT, NO, REQ),
  ending: descriptorRow(OPT, REQ, REQ),
  completed: descriptorRow(NO, REQ, REQ),
  failed: descriptorRow(NO, REQ, REQ),
};

/** §6.8.4 / plan Global Constraints: the wire end reasons. */
const WIRE_END_REASONS = ["stopped", "auto_stopped", "no_inbound_timeout", "target_rejected", "max_duration", "phone_lost", "failed"];
/** §6.1: "12 characters of lowercase Crockford base32" — Crockford's alphabet drops i, l, o and u. */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** §6.3.2's body, word for word: the beat request's closed vocabularies (the `| null` is the field's, not a value). */
const SPEC_BEAT = {
  claim: ["new", "resume"],
  state: ["paired", "arming", "armed", "connecting", "publishing", "degraded", "reconnecting", "ended"],
  cause: ["organiser", "automatic", "operator", "rejoin"],
  notReady: ["camera", "sound", "network", "held"],
  startFailed: ["not-found", "cred-host", "config", "start-error"],
  mode: ["automatic", "operator"],
  transport: ["srt", "rtmps"],
  delivery: ["ok", "stalled", "unknown"],
  endReason: ["operator-stopped"],
};
/** §6.3.3 / §6.3.4: `startedBy?: "organiser" | "automatic" | "operator"`, on go-live and on 409 already_live. */
const SPEC_STARTED_BY = ["organiser", "automatic", "operator"];
/** §6.3.3's answer `state`. */
const SPEC_ANSWER_STATES = ["waiting", "go-live", "live", "over", "replaced", "taken"];
/** §6.3.1's descriptor: `state` across the waiting and session shapes, `preferred`, `scoreUpdates`. */
const SPEC_DESCRIPTOR = {
  state: ["waiting", "warming", "live", "ending", "completed", "failed"],
  preferred: ["srt", "rtmps"],
  scoreUpdates: ["realtime", "polled"],
};
/** §6.3.1 and §6.3.4 name eight refusal words with their statuses. The bare `422` and `429` got their words in the T1
 *  brief (`invalid`, `rate_limited`): coined there, so the OG1 hand-off note asks capture to confirm them (review G-2).
 *  `503` is ALWAYS `unavailable` — a cause such as an unexpected ingest host goes in `message` or the log, never in
 *  `code` (review G-1). */
const SPEC_REFUSALS: Record<string, number> = {
  already_live: 409, replaced: 409, no_destination: 409, no_credit: 402, not_entitled: 403, unavailable: 503,
  code_ended: 401, not_a_stream_code: 404, invalid: 422, rate_limited: 429,
};
/** §6.3.1's statuses for GET codes/{code}: 401, 404, 422, 429, 503 — never 409, 402, 403 (no start runs there). */
const SPEC_DESCRIPTOR_REFUSALS = ["code_ended", "not_a_stream_code", "invalid", "rate_limited", "unavailable"];

/** D16 (capture's field-by-field check, 2026-10-01): cross-field rules the server enforces in the twin. A refine is not
 *  exported to JSON Schema and the published bytes stay frozen, so ajv ADMITS each of these fixtures; only the twin
 *  refuses them (a 422). Each names its valid sibling, from which it differs in `field` alone. */
const ZOD_ONLY: Record<string, { sibling: string; field: string; file: string; twin: Twin; rule: string }> = {
  "capture-beat.v1/beat-invalid-cause-without-sid": { sibling: "beat-valid", field: "cause", file: "capture-beat.v1.json", twin: S.CaptureBeat, rule: "cause rides only while a broadcast is held (sid non-null)" },
  "capture-beat.v1/beat-invalid-endReason-not-ended": { sibling: "beat-valid-publishing", field: "endReason", file: "capture-beat.v1.json", twin: S.CaptureBeat, rule: "endReason only with state ended (§6.3.2)" },
  "capture-beat.v1/beat-invalid-stopped-with-sid": { sibling: "beat-valid-publishing", field: "stopped", file: "capture-beat.v1.json", twin: S.CaptureBeat, rule: "stopped only while sid is null (§6.3.2, RR3)" },
  "capture-beat.v1/beat-invalid-claim-with-rejoin": { sibling: "beat-valid-resume", field: "cause", file: "capture-beat.v1.json", twin: S.CaptureBeat, rule: "a claim never rides with cause rejoin" },
  "capture-descriptor.v1/invalid-srt-null-preferred-srt": { sibling: "valid-live-srt-null", field: "preferred", file: "capture-descriptor.v1.json", twin: S.CaptureDescriptor, rule: "cred.srt null ⇒ preferred rtmps (§6.4, A18)" },
};

// ---------------------------------------------------------------------------------------------------------------
// Structural helpers.
// ---------------------------------------------------------------------------------------------------------------
const PROSE = new Set(["$schema", "$id", "title", "description"]);
/** Drops the prose keys at every level (never a property NAMED like one), sorts `required` and `enum`. */
function normalise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalise);
  if (node === null || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (PROSE.has(k)) continue;
    if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as Json).map(([p, s]) => [p, normalise(s)]));
    else if ((k === "required" || k === "enum") && Array.isArray(v)) out[k] = [...(v as string[])].sort();
    else out[k] = normalise(v);
  }
  return out;
}
/** Both directions of the twin. Output mode writes `additionalProperties: false` for a STRIPPING z.object as well as a
 *  strict one, so on its own it cannot see a branch that silently drops an unknown key (found by mutant M8 in T1);
 *  input mode writes it only for a strict object. The contract must equal both. */
const IO = ["output", "input"] as const;
const zodJson = (twin: Twin, io: (typeof IO)[number]): Json => z.toJSONSchema(twin, { target: "draft-2020-12", io }) as Json;
const rootOf = (file: Json): Json => without(file, "$defs");
const defOf = (file: Json, name: string): Json => (file.$defs as Record<string, Json>)[name]!;
/** A `oneOf` keyed by each branch's `properties.state.const`. */
function branchesByState(node: Json): Record<string, Json> {
  const branches = node.oneOf as Json[];
  expect(Array.isArray(branches), "a oneOf").toBe(true);
  const out: Record<string, Json> = {};
  for (const b of branches) {
    const state = ((b.properties as Record<string, Json>).state as Json).const as string;
    expect(out[state], `two branches for state ${state}`).toBeUndefined();
    out[state] = b;
  }
  return out;
}
/** Every node at a dotted property path, through properties / anyOf / oneOf — the same walk the generator does. */
function nodesAt(node: unknown, path: string[]): Json[] {
  if (node === null || typeof node !== "object") return [];
  const n = node as Json;
  if (path.length === 0) return [n];
  const viaUnions = [...((n.anyOf as Json[]) ?? []), ...((n.oneOf as Json[]) ?? [])].flatMap((b) => nodesAt(b, path));
  const props = n.properties as Json | undefined;
  const next = props?.[path[0]!];
  return [...viaUnions, ...(next === undefined ? [] : nodesAt(next, path.slice(1)))];
}
/** A node's closed values, sorted: its `enum`, its `const`, or its anyOf/oneOf members' — `null` dropped (whether a
 *  field admits null is the optional-versus-null test's question). A node that closes nothing yields []. */
function enumOf(node: Json): string[] {
  const own = node.enum !== undefined ? (node.enum as unknown[]) : node.const !== undefined ? [node.const] : [];
  const members = [...((node.anyOf as Json[] | undefined) ?? []), ...((node.oneOf as Json[] | undefined) ?? [])].flatMap(enumOf);
  return [...own, ...members].filter((v) => v !== null).map(String).sort();
}

// ---------------------------------------------------------------------------------------------------------------
// The file → twin map, and the fixture directories' routing.
// ---------------------------------------------------------------------------------------------------------------
const QR = "capture-qr.v2.json", DESCRIPTOR = "capture-descriptor.v1.json", BEAT = "capture-beat.v1.json", START = "capture-start.v1.json";
/** Each file's `$defs`, exactly. */
const DEFS: Record<string, string[]> = { [QR]: [], [DESCRIPTOR]: ["refusal"], [BEAT]: ["answer"], [START]: ["ok", "refusal"] };

/** Per directory: its contract file; [file prefix, twin, the shape's pointer in that file], first match wins; and the
 *  exact fixture count (never 0). */
type Route = [prefix: string, twin: Twin, pointer: "" | "#/$defs/refusal" | "#/$defs/answer" | "#/$defs/ok"];
const DIRS: Record<string, { file: string; routes: Route[]; count: number }> = {
  "capture-qr.v2": { file: QR, routes: [["", CaptureQrV2, ""]], count: 12 },
  "capture-descriptor.v1": { file: DESCRIPTOR, routes: [["refusal-", S.CaptureRefusal, "#/$defs/refusal"], ["", S.CaptureDescriptor, ""]], count: 31 },
  "capture-beat.v1": { file: BEAT, routes: [["beat-", S.CaptureBeat, ""], ["answer-", S.CaptureBeatAnswer, "#/$defs/answer"]], count: 40 },
  "capture-start.v1": { file: START, routes: [["request-", S.CaptureStartBody, ""], ["ok-", S.CaptureStartOk, "#/$defs/ok"], ["", S.CaptureRefusal, "#/$defs/refusal"]], count: 18 },
};

/** The published bytes as a validator sees them: ajv 2020-12, strict, formats ASSERTED (uuid, uri, date-time) — the
 *  stricter of the two readings a vendoring repo may take, so a fixture the file admits only with formats off fails. */
function fileValidator(): (file: string, pointer: string, value: unknown) => boolean {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const file of Object.keys(SHA256)) ajv.addSchema(JSON.parse(contractText(file)) as Json);
  return (file, pointer, value) => {
    const validate = ajv.getSchema(`https://seazn.club/contracts/${file}${pointer}`);
    expect(validate, `${file}${pointer}: ajv resolves the shape`).toBeDefined();
    return validate!(value) as boolean;
  };
}

describe("capture contracts (docs/contracts/capture-*.json)", () => {
  it("each of the four contracts is checksummed (the cross-repo drift gate)", () => {
    let checked = 0;
    for (const [file, sha] of Object.entries(SHA256)) {
      expect(createHash("sha256").update(contractText(file)).digest("hex"), file).toBe(sha);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("v1 is gone, and every published capture contract is one of the four twinned ones (W4, §6.13)", () => {
    expect(existsSync(resolve(CONTRACTS, "capture-qr.v1.json")), "the v1 contract").toBe(false);
    expect(existsSync(resolve(FIXTURES, "capture-qr.v1")), "the v1 fixtures").toBe(false);
    const files = readdirSync(CONTRACTS).filter((f) => f.startsWith("capture-")).sort();
    expect(files).toEqual(Object.keys(SHA256).sort());
    const dirs = readdirSync(FIXTURES).filter((f) => f.startsWith("capture-")).sort();
    expect(dirs).toEqual(Object.keys(DIRS).sort());
  });

  it("schemas.ts re-exports every twin by identity, never a re-typed copy", () => {
    const names = Object.keys(CS);
    expect(names.length, "capture-schemas.ts exports nothing").toBeGreaterThan(0);
    let checked = 0;
    for (const name of names) {
      expect((S as Record<string, unknown>)[name], name).toBe((CS as Record<string, unknown>)[name]);
      checked++;
    }
    // The brief's interface list (T1) — the names later tasks import.
    for (const name of ["CAPTURE_CODE_RE", "CaptureEndReason", "CaptureStartedBy", "CaptureCause", "CapturePhoneState",
      "CaptureNotReady", "CaptureStartFailed", "CaptureWaiting", "CaptureSession", "CaptureDescriptor", "CaptureBeat",
      "CaptureBeatAnswer", "CaptureStartBody", "CaptureStartOk", "CaptureRefusal", "CaptureRefusalCode"]) {
      expect(names, name).toContain(name);
    }
    expect(checked).toBe(names.length);
  });

  it("parity: each file (and each $def) equals z.toJSONSchema of its twin, as output AND as input, unions compared branch by branch on `state`", () => {
    const qr = contract(QR), desc = contract(DESCRIPTOR), beat = contract(BEAT), start = contract(START);
    let defsChecked = 0;
    for (const [file, json] of [[QR, qr], [DESCRIPTOR, desc], [BEAT, beat], [START, start]] as const) {
      expect(Object.keys((json.$defs as Json | undefined) ?? {}).sort(), `${file} $defs`).toEqual([...DEFS[file]!].sort());
      expect(json.$id, `${file} $id`).toBe(`https://seazn.club/contracts/${file}`);
      expect(json.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      defsChecked++;
    }
    expect(defsChecked).toBe(4);

    const whole: [string, Json, Twin][] = [
      [QR, rootOf(qr), CaptureQrV2],
      [`${DESCRIPTOR}#/$defs/refusal`, defOf(desc, "refusal"), S.CaptureRefusal],
      [BEAT, rootOf(beat), S.CaptureBeat],
      [START, rootOf(start), S.CaptureStartBody],
      [`${START}#/$defs/ok`, defOf(start, "ok"), S.CaptureStartOk],
      [`${START}#/$defs/refusal`, defOf(start, "refusal"), S.CaptureRefusal],
    ];
    let wholeChecked = 0;
    for (const io of IO) {
      for (const [name, file, twin] of whole) {
        expect(normalise(file), `${name} (${io})`).toEqual(normalise(zodJson(twin, io)));
        wholeChecked++;
      }
    }
    expect(wholeChecked).toBe(6 * 2);

    const unions: [string, Json, Twin, string[]][] = [
      [DESCRIPTOR, rootOf(desc), S.CaptureDescriptor, Object.keys(DESCRIPTOR_MATRIX)],
      [`${BEAT}#/$defs/answer`, defOf(beat, "answer"), S.CaptureBeatAnswer, Object.keys(ANSWER_MATRIX)],
    ];
    for (const io of IO) {
      for (const [name, file, twin, states] of unions) {
        const zod = zodJson(twin, io);
        // Everything beside the branches agrees too (nothing but prose, which the normaliser drops).
        expect(normalise(without(file, "oneOf")), `${name} (${io}): beside oneOf`).toEqual(normalise(without(zod, "oneOf")));
        const fileBranches = branchesByState(file), zodBranches = branchesByState(zod);
        expect(Object.keys(fileBranches).sort(), `${name}: the file's states`).toEqual([...states].sort());
        expect(Object.keys(zodBranches).sort(), `${name} (${io}): the twin's states`).toEqual([...states].sort());
        let branches = 0;
        for (const state of states) {
          expect(normalise(fileBranches[state]), `${name} [${state}] (${io})`).toEqual(normalise(zodBranches[state]));
          branches++;
        }
        expect(branches, `${name} (${io}): branches compared`).toBe(6);
      }
    }
  });

  it("fixtures: every valid* is admitted, every invalid-* / tampered* / wrong-version is refused — by the twin AND by the published file under ajv, counted per directory", () => {
    const fileAdmits = fileValidator();
    let total = 0, byFile = 0, zodOnlySeen = 0;
    for (const [dir, { file, routes, count }] of Object.entries(DIRS)) {
      const names = readdirSync(resolve(FIXTURES, dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
      let checked = 0;
      for (const name of names) {
        const route = routes.find(([prefix]) => name.startsWith(prefix));
        expect(route, `${dir}/${name}: no twin routes this fixture`).toBeDefined();
        const [prefix, twin, pointer] = route!;
        const kind = name.slice(prefix.length);
        const value = fixture(dir, name);
        let admitted: boolean;
        if (/^valid(-.+)?$/.test(kind)) admitted = true;
        else if (/^(invalid-.+|tampered(-.+)?|wrong-version)$/.test(kind)) admitted = false;
        else expect.fail(`${dir}/${name}: neither valid* nor invalid-*/tampered*/wrong-version`);
        expect(parses(twin, value), `${dir}/${name}: the twin ${admitted ? "admits" : "refuses"} it`).toBe(admitted);
        // A ZOD_ONLY fixture breaks a rule the file states in prose only: ajv ADMITS it, and only the twin refuses it.
        const zodOnly = `${dir}/${name}` in ZOD_ONLY;
        if (zodOnly) {
          expect(admitted, `${dir}/${name}: a ZOD_ONLY fixture is a refusal`).toBe(false);
          zodOnlySeen++;
        }
        const fileVerdict = zodOnly ? true : admitted;
        expect(fileAdmits(file, pointer, value), `${dir}/${name}: ${file}${pointer} ${fileVerdict ? "admits" : "refuses"} it`).toBe(fileVerdict);
        byFile++;
        checked++;
      }
      expect(checked, `${dir}: fixtures checked`).toBeGreaterThan(0);
      expect(checked, `${dir}: fixtures checked`).toBe(count);
      total += checked;
    }
    expect(total).toBe(12 + 31 + 40 + 18);
    expect(byFile, "fixtures checked against the published bytes").toBe(total);
    // Every ZOD_ONLY entry names a fixture that exists and was swept (a stale entry would excuse nothing, silently).
    expect(zodOnlySeen, "ZOD_ONLY fixtures swept").toBe(Object.keys(ZOD_ONLY).length);
    expect(zodOnlySeen).toBe(5);
  });

  it("D16 cross-field rules (zod-only): each ZOD_ONLY fixture differs from a valid sibling in ONE field, and the twin refuses it on that field alone", () => {
    const fileAdmits = fileValidator();
    let checked = 0;
    for (const [key, { sibling, field, file, twin }] of Object.entries(ZOD_ONLY)) {
      const [dir, name] = key.split("/") as [string, string];
      const bad = fixture(dir, name), good = fixture(dir, sibling);
      const differing = [...new Set([...Object.keys(bad), ...Object.keys(good)])].filter((k) => JSON.stringify(bad[k]) !== JSON.stringify(good[k]));
      expect(differing, `${key}: premise — differs from ${sibling} in ${field} alone`).toEqual([field]);
      expect(parses(twin, good), `${key}: premise — ${sibling} parses`).toBe(true);
      expect(fileAdmits(file, "", good), `${key}: premise — the file admits ${sibling}`).toBe(true);
      const result = twin.safeParse(bad);
      expect(result.success, `${key}: the twin refuses it`).toBe(false);
      // Exactly one issue, raised on the rule's own field: the refusal is the refine, not some other guard.
      expect(result.error?.issues.map((i) => i.path.join(".")), key).toEqual([field]);
      expect(fileAdmits(file, "", bad), `${key}: the file states this rule in prose only, so ajv admits it`).toBe(true);
      checked++;
    }
    expect(checked).toBe(5);
    // CaptureSession (the session-only union later tasks import) carries the same A18 rule as the descriptor.
    const srtNull = fixture("capture-descriptor.v1", "valid-live-srt-null");
    expect(parses(S.CaptureSession, srtNull), "session: srt null with rtmps").toBe(true);
    expect(S.CaptureSession.safeParse(fixture("capture-descriptor.v1", "invalid-srt-null-preferred-srt")).error?.issues.map((i) => i.path.join(".")), "session: srt null with srt").toEqual(["preferred"]);
  });

  it("enums: every closed vocabulary in the files and the twins is the spec's literal list (§6.3.1–§6.3.4)", () => {
    const beat = rootOf(contract(BEAT)), answer = defOf(contract(BEAT), "answer"), desc = rootOf(contract(DESCRIPTOR));
    // [what, the file's shape, the twin, property, the spec's list, nodes expected, union the nodes' values?]
    const owed: [string, Json, Twin, string, string[], number, boolean][] = [
      ...Object.entries(SPEC_BEAT).map(([prop, list]): [string, Json, Twin, string, string[], number, boolean] =>
        [`beat ${prop}`, beat, S.CaptureBeat, prop, list, 1, false]),
      ["answer state", answer, S.CaptureBeatAnswer, "state", SPEC_ANSWER_STATES, 6, true],
      ["answer startedBy (go-live only)", answer, S.CaptureBeatAnswer, "startedBy", SPEC_STARTED_BY, 1, false],
      ["descriptor state", desc, S.CaptureDescriptor, "state", SPEC_DESCRIPTOR.state, 6, true],
      ["descriptor preferred (5 session states)", desc, S.CaptureDescriptor, "preferred", SPEC_DESCRIPTOR.preferred, 5, false],
      ["descriptor scoreUpdates (5 session states)", desc, S.CaptureDescriptor, "scoreUpdates", SPEC_DESCRIPTOR.scoreUpdates, 5, false],
      ...[START, DESCRIPTOR].flatMap((file): [string, Json, Twin, string, string[], number, boolean][] => [
        [`${file} refusal code`, defOf(contract(file), "refusal"), S.CaptureRefusal, "code", Object.keys(SPEC_REFUSALS), 2, true],
        [`${file} refusal startedBy (already_live only)`, defOf(contract(file), "refusal"), S.CaptureRefusal, "startedBy", SPEC_STARTED_BY, 1, false],
      ]),
    ];
    let nodes = 0;
    for (const [what, fileShape, twin, prop, list, expectedNodes, union] of owed) {
      for (const [side, shape] of [["file", fileShape], ["twin", zodJson(twin, "output")]] as const) {
        const found = nodesAt(shape, [prop]).map(enumOf);
        expect(found, `${what} (${side}): nodes`).toHaveLength(expectedNodes);
        if (union) expect([...new Set(found.flat())].sort(), `${what} (${side})`).toEqual([...list].sort());
        else for (const values of found) expect(values, `${what} (${side})`).toEqual([...list].sort());
        nodes += found.length;
      }
    }
    // 9 beat + answer 6 + 1 + descriptor 6 + 5 + 5 + refusal (2 + 1) × 2 files = 38 nodes, each on the file and the twin.
    expect(nodes).toBe(38 * 2);
    // The exported enum twins later tasks import, by their own options.
    const exported: [string, z.ZodEnum, string[]][] = [
      ["CapturePhoneState", CS.CapturePhoneState, SPEC_BEAT.state], ["CaptureCause", CS.CaptureCause, SPEC_BEAT.cause],
      ["CaptureNotReady", CS.CaptureNotReady, SPEC_BEAT.notReady], ["CaptureStartFailed", CS.CaptureStartFailed, SPEC_BEAT.startFailed],
      ["CaptureStartedBy", CS.CaptureStartedBy, SPEC_STARTED_BY], ["CaptureRefusalCode", CS.CaptureRefusalCode, Object.keys(SPEC_REFUSALS)],
    ];
    for (const [name, twin, list] of exported) expect([...twin.options].sort(), name).toEqual([...list].sort());
    expect(exported).toHaveLength(6);
  });

  it("M-3: a takeover (resume), a stop, and both pre-flight failures each have a valid beat request", () => {
    const shapes: [name: string, premise: (b: Json) => boolean][] = [
      // G0-d at Arming: the GET answered the session shape with no cred ("open, not current"), so the phone claims
      // `resume` naming the open sid it resumes. A claim rides only until the pairing's first 2xx, so never with a
      // rejoin (which follows a 2xx `live`), and the phone is not yet publishing.
      ["beat-valid-resume", (b) => b.claim === "resume" && typeof b.sid === "string" && b.state === "arming" && b.cause === null && b.transport === null],
      ["beat-valid-stopped", (b) => b.sid === null && typeof b.stopped === "string"],
      // A pre-flight failure holds no broadcast (no sid), so it carries no `cause` (D12/D13: cause rides only with a sid).
      ["beat-valid-not-ready", (b) => SPEC_BEAT.notReady.includes(b.notReady as string) && b.state === "paired" && b.sid === null && b.cause === null],
      ["beat-valid-start-failed", (b) => SPEC_BEAT.startFailed.includes(b.startFailed as string) && b.state === "paired" && b.sid === null && b.cause === null],
    ];
    const fileAdmits = fileValidator();
    let checked = 0;
    for (const [name, premise] of shapes) {
      const b = fixture("capture-beat.v1", name);
      expect(premise(b), `${name}: premise`).toBe(true);
      expect(parses(S.CaptureBeat, b), name).toBe(true);
      expect(fileAdmits(BEAT, "", b), name).toBe(true);
      checked++;
    }
    expect(checked).toBe(4);
    // …and between them and the rest, `transport: "rtmps"` and `claim: "resume"` are shown at least once.
    const all = readdirSync(resolve(FIXTURES, "capture-beat.v1")).filter((f) => /^beat-valid.*\.json$/.test(f)).map((f) => fixture("capture-beat.v1", f.slice(0, -5)));
    expect(all.some((b) => b.transport === "rtmps"), "a valid beat on rtmps").toBe(true);
    expect(all.some((b) => b.claim === "resume"), "a valid resume claim").toBe(true);
  });

  it("R5/A21 beat answer: each state admits only its own fields — 6 states × 10 fields against the twin AND the file", () => {
    const states = Object.keys(ANSWER_MATRIX);
    const valid = Object.fromEntries(states.map((s) => [s, fixture("capture-beat.v1", `answer-valid-${s}`)]));
    const donors = [...Object.values(valid), fixture("capture-beat.v1", "answer-valid-replaced-device")];
    const twinCells = sweepTwin(ANSWER_MATRIX, ANSWER_FIELDS, valid, donors, S.CaptureBeatAnswer);
    expect(twinCells).toBe(60);
    const fileCells = sweepFile(ANSWER_MATRIX, ANSWER_FIELDS, branchesByState(defOf(contract(BEAT), "answer")));
    expect(fileCells).toBe(60);
  });

  it("R5/A21 descriptor: each state admits only its own fields — 6 states × 9 fields against the twin AND the file", () => {
    const states = Object.keys(DESCRIPTOR_MATRIX);
    const valid = Object.fromEntries(states.map((s) => [s, fixture("capture-descriptor.v1", `valid-${s}`)]));
    const twinCells = sweepTwin(DESCRIPTOR_MATRIX, DESCRIPTOR_FIELDS, valid, Object.values(valid), S.CaptureDescriptor);
    expect(twinCells).toBe(54);
    const fileCells = sweepFile(DESCRIPTOR_MATRIX, DESCRIPTOR_FIELDS, branchesByState(rootOf(contract(DESCRIPTOR))));
    expect(fileCells).toBe(54);
  });

  it("optional is not nullable: each optional-and-not-`| null` field set to null is refused, and the same fixture without it parses", () => {
    const owed: [dir: string, name: string, field: string, twin: Twin][] = [];
    // §4 / §6.3.1: `scheduledStart?` on the waiting and session shapes.
    for (const state of Object.keys(DESCRIPTOR_MATRIX)) owed.push(["capture-descriptor.v1", `invalid-null-${state}-scheduledStart`, "scheduledStart", S.CaptureDescriptor]);
    for (const [state, row] of Object.entries(DESCRIPTOR_MATRIX)) {
      for (const [field, cell] of Object.entries(row)) if (cell === OPT) owed.push(["capture-descriptor.v1", `invalid-null-${state}-${field}`, field, S.CaptureDescriptor]);
    }
    for (const [state, row] of Object.entries(ANSWER_MATRIX)) {
      for (const [field, cell] of Object.entries(row)) {
        if (cell === OPT && !COMMON_NULLABLE.has(field)) owed.push(["capture-beat.v1", `answer-invalid-null-${state}-${field}`, field, S.CaptureBeatAnswer]);
      }
    }
    let checked = 0;
    for (const [dir, name, field, twin] of owed) {
      const f = fixture(dir, name);
      expect(f[field], `${name}: premise — the field is null`).toBeNull();
      expect(parses(twin, f), `${name}: null must be refused`).toBe(false);
      expect(parses(twin, without(f, field)), `${name}: the same fixture without ${field} parses`).toBe(true);
      checked++;
    }
    // 6 scheduledStart + 3 cred (descriptor) + 2 × {device, label, autoAllowed, pollSeconds} (answer).
    expect(checked).toBe(17);
    // …and the `| null` common fields on replaced and taken DO admit null (the twin of the refusals above).
    let nullable = 0;
    for (const state of ["replaced", "taken"]) {
      const base = fixture("capture-beat.v1", `answer-valid-${state}`);
      for (const field of COMMON_NULLABLE) {
        expect(parses(S.CaptureBeatAnswer, { ...base, [field]: null }), `${state}.${field}: null`).toBe(true);
        nullable++;
      }
    }
    expect(nullable).toBe(6);
  });

  it("R5 `at`: an offset parses, a value with no zone is refused, and the phone's own beat carries Z", () => {
    const offset = fixture("capture-beat.v1", "beat-valid-at-offset");
    expect(offset.at).toBe("2026-10-01T15:30:00+05:30");
    expect(parses(S.CaptureBeat, offset)).toBe(true);
    const local = fixture("capture-beat.v1", "beat-invalid-at-local");
    expect(local.at).toBe("2026-10-01T10:00:00");
    expect(parses(S.CaptureBeat, local)).toBe(false);
    // The pair differs ONLY in `at`: so `at` is what the refusal is about.
    expect(without(local, "at")).toEqual(without(offset, "at"));
    const beat = fixture("capture-beat.v1", "beat-valid");
    expect(String(beat.at)).toMatch(/Z$/);
    expect(parses(S.CaptureBeat, beat)).toBe(true);
    // RFC 3339 `date-time` (the file's `format`) requires seconds: a minute-only value is refused by the twin AND by
    // the file with formats asserted. Before this pin zod admitted it while the vendored file refused it.
    const fileAdmits = fileValidator();
    const noSeconds = fixture("capture-beat.v1", "beat-invalid-at-no-seconds");
    expect(noSeconds.at).toBe("2026-10-01T13:40Z");
    expect(without(noSeconds, "at"), "premise: differs from beat-valid in `at` alone").toEqual(without(beat, "at"));
    expect(parses(S.CaptureBeat, noSeconds), "the twin refuses a minute-only at").toBe(false);
    expect(fileAdmits(BEAT, "", noSeconds), "the file refuses a minute-only at").toBe(false);
    // D11, capture's own probe value, on zod 4.4.3.
    expect(parses(S.CaptureBeat, { ...beat, at: "2026-10-01T12:34Z" }), "twin: 12:34Z").toBe(false);
    expect(fileAdmits(BEAT, "", { ...beat, at: "2026-10-01T12:34Z" }), "file: 12:34Z").toBe(false);
    // …while fractional seconds stay ADMITTED on both sides (RFC 3339 time-secfrac is optional, any length): the
    // vendored millisecond fixtures, with Z and with an offset, each differ from beat-valid in `at` alone.
    let fractions = 0;
    const millis: [name: string, at: string][] = [
      ["beat-valid-at-millis-z", "2026-10-01T13:40:00.123Z"], ["beat-valid-at-millis-offset", "2026-10-01T14:40:00.123+01:00"],
    ];
    for (const [name, at] of millis) {
      const f = fixture("capture-beat.v1", name);
      expect(f.at, `${name}: premise`).toBe(at);
      expect(without(f, "at"), `${name}: premise — only at differs`).toEqual(without(beat, "at"));
      expect(parses(S.CaptureBeat, f), `twin: ${name}`).toBe(true);
      expect(fileAdmits(BEAT, "", f), `file: ${name}`).toBe(true);
      fractions++;
    }
    expect(fractions).toBe(2);
    let admitted = 0;
    for (const at of ["2026-10-01T13:40:00Z", "2026-10-01T13:40:00.5Z", "2026-10-01T13:40:00.123456789Z", "2026-10-01T15:30:00+05:30"]) {
      expect(parses(S.CaptureBeat, { ...beat, at }), `twin: ${at}`).toBe(true);
      expect(fileAdmits(BEAT, "", { ...beat, at }), `file: ${at}`).toBe(true);
      admitted++;
    }
    expect(admitted).toBe(4);
  });

  it("strictness survives .extend()/.partial(): each answer branch refuses its one extra key, and parses without it", () => {
    let checked = 0;
    for (const state of Object.keys(ANSWER_MATRIX)) {
      const tampered = fixture("capture-beat.v1", `answer-tampered-${state}`);
      const valid = fixture("capture-beat.v1", `answer-valid-${state}`);
      const extra = Object.keys(tampered).filter((k) => !(k in valid));
      expect(extra, `${state}: exactly one extra key`).toHaveLength(1);
      expect(tampered.state).toBe(state);
      expect(parses(S.CaptureBeatAnswer, tampered), `${state}: the extra key must be refused`).toBe(false);
      expect(parses(S.CaptureBeatAnswer, without(tampered, extra[0]!)), `${state}: without it`).toBe(true);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("A18: cred.srt null with preferred rtmps parses (the RTMPS-only safety net)", () => {
    const f = fixture("capture-descriptor.v1", "valid-live-srt-null");
    expect((f.cred as Json).srt).toBeNull();
    expect(f.preferred).toBe("rtmps");
    expect(parses(S.CaptureDescriptor, f)).toBe(true);
    // …and cred absent altogether is the "claim first" shape (G0-d), a different thing.
    const noCred = fixture("capture-descriptor.v1", "valid-live-no-cred");
    expect("cred" in noCred).toBe(false);
    expect(parses(S.CaptureDescriptor, noCred)).toBe(true);
  });

  it("W21/G0-i hosts: SRT on Cloudflare's own host, RTMPS on the environment's live.*, and the file documents both SRT hosts", () => {
    const cred = fixture("capture-descriptor.v1", "valid-live").cred as { srt: Json; rtmps: Json };
    expect(cred.srt.url).toBe("srt://live.cloudflare.com:778");
    expect(cred.rtmps.url).toBe("rtmps://live.stg.seazn.club:443/live/");
    const descriptor = rootOf(contract(DESCRIPTOR));
    const srtUrls = nodesAt(descriptor, ["cred", "srt", "url"]);
    // cred appears in warming, live and ending (§17.5).
    expect(srtUrls, "cred.srt.url occurrences").toHaveLength(3);
    for (const node of srtUrls) {
      expect(node.description, "cred.srt.url").toContain("live.cloudflare.com");
      expect(node.description, "cred.srt.url").toContain("live.*");
    }
    const rtmpsUrls = nodesAt(descriptor, ["cred", "rtmps", "url"]);
    expect(rtmpsUrls).toHaveLength(3);
    for (const node of rtmpsUrls) expect(node.description, "cred.rtmps.url").toContain("live.*");
  });

  it("QR v2 `exp` (capture's A1, §1.2): optional, an integer ≥ 0 of epoch SECONDS; admitted when present, never sent by this server", () => {
    const dir = "capture-qr.v2";
    const valid = fixture(dir, "valid");
    expect("exp" in valid, "premise: the plain fixture carries no exp").toBe(false);
    const withExp = fixture(dir, "valid-exp");
    // v1's precedent: 2100-01-01T00:00:00Z in SECONDS (a milliseconds value would be ~1000× this).
    expect(withExp.exp).toBe(4102444800);
    expect(without(withExp, "exp"), "premise: valid-exp is valid plus exp").toEqual(valid);
    expect(parseCaptureQrV2(withExp)).toEqual({ ok: true, payload: withExp });
    // The boundary the ruling names: 0 is admitted.
    const zero = fixture(dir, "valid-exp-zero");
    expect(zero.exp).toBe(0);
    expect(parseCaptureQrV2(zero)).toEqual({ ok: true, payload: zero });
    // Each refusal differs from valid-exp in `exp` alone, and parseCaptureQrV2 calls it invalid (not wrong_version).
    const refused: [name: string, exp: unknown][] = [
      ["invalid-exp-string", "4102444800"], ["invalid-exp-negative", -1], ["invalid-exp-float", 4102444800.5], ["invalid-null-exp", null],
    ];
    let checked = 0;
    for (const [name, exp] of refused) {
      const f = fixture(dir, name);
      expect(f.exp, `${name}: premise`).toStrictEqual(exp);
      expect(without(f, "exp"), `${name}: premise — only exp differs`).toEqual(valid);
      expect(parseCaptureQrV2(f), name).toEqual({ ok: false, reason: "invalid" });
      checked++;
    }
    expect(checked).toBe(4);
    // The file: five properties, four required; `exp` an integer with minimum 0, null not admitted.
    const file = contract(QR);
    expect(Object.keys(file.properties as Json).sort()).toEqual(["code", "exp", "slot", "tok", "v"]);
    expect([...(file.required as string[])].sort()).toEqual(["code", "slot", "tok", "v"]);
    expect(file.additionalProperties).toBe(false);
    const exp = (file.properties as Record<string, Json>).exp!;
    expect(exp.type).toBe("integer");
    expect(exp.minimum).toBe(0);
    expect(exp.anyOf, "exp is not `| null`").toBeUndefined();
    // We never send it (§1.2 A1's web consequence, §6.2): handed a payload that carries exp, the text drops it.
    const text = captureQrV2Text(withExp as CaptureQrV2);
    expect(Object.keys(JSON.parse(text) as Json)).toEqual(["v", "code", "slot", "tok"]);
    expect(text).not.toContain("exp");
    expect(parseCaptureQrV2(JSON.parse(text))).toEqual({ ok: true, payload: valid });
  });

  it("QR v2: valid parses; tampered (a fifth key, cred) and wrong-version (v 1) refuse with their reasons; the text is exactly four keys", () => {
    const dir = "capture-qr.v2";
    const valid = fixture(dir, "valid");
    expect(parseCaptureQrV2(valid)).toEqual({ ok: true, payload: valid });
    const tampered = fixture(dir, "tampered");
    expect(Object.keys(tampered).sort(), "premise: valid plus cred").toEqual([...Object.keys(valid), "cred"].sort());
    expect(parseCaptureQrV2(tampered)).toEqual({ ok: false, reason: "invalid" });
    const wrong = fixture(dir, "wrong-version");
    expect(wrong.v).toBe(1);
    expect(parseCaptureQrV2(wrong)).toEqual({ ok: false, reason: "wrong_version" });
    // W3 / §6.2: the QR and the paste code carry exactly these four keys, in this order, and never credentials.
    const text = captureQrV2Text(valid as CaptureQrV2);
    expect(Object.keys(JSON.parse(text) as Json)).toEqual(["v", "code", "slot", "tok"]);
    expect(parseCaptureQrV2(JSON.parse(text))).toEqual({ ok: true, payload: valid });
    // Handed a wider object, the text still carries the four keys only (a structural type admits extras).
    const wide = { ...valid, cred: tampered.cred } as unknown as CaptureQrV2;
    expect(Object.keys(JSON.parse(captureQrV2Text(wide)) as Json)).toEqual(["v", "code", "slot", "tok"]);
    // The empty case: nothing that is not an object throws or parses.
    for (const input of [undefined, null, {}, [], "", 1, true, { v: 2 }]) {
      expect(parseCaptureQrV2(input), JSON.stringify(input) ?? "undefined").toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("the stream code is lowercase Crockford base32 × 12 (§6.1), one pattern across the QR, the descriptor and the beat", () => {
    let accepted = 0;
    for (const ch of CROCKFORD) {
      const code = ch.repeat(12);
      expect(S.CAPTURE_CODE_RE.test(code), code).toBe(true);
      expect(CaptureQrV2.shape.code.safeParse(code).success, code).toBe(true);
      accepted++;
    }
    expect(accepted).toBe(32);
    for (const code of ["i", "l", "o", "u", "A"].map((c) => c.repeat(12)).concat(["0".repeat(11), "0".repeat(13)])) {
      expect(S.CAPTURE_CODE_RE.test(code), code).toBe(false);
      expect(CaptureQrV2.shape.code.safeParse(code).success, code).toBe(false);
    }
    const patterns = [
      ...nodesAt(contract(QR), ["code"]),
      ...nodesAt(rootOf(contract(DESCRIPTOR)), ["code"]),
      ...nodesAt(rootOf(contract(BEAT)), ["code"]),
    ].map((n) => n.pattern);
    expect(patterns, "QR 1 + descriptor 6 + beat 1").toHaveLength(8);
    for (const p of patterns) expect(p).toBe(S.CAPTURE_CODE_RE.source);
  });

  it("end reasons (§6.8.4): the files carry exactly the seven wire values, and each one parses on `over` and on `completed`", () => {
    const overEnum = (branchesByState(defOf(contract(BEAT), "answer")).over!.properties as Record<string, Json>).endReason!.enum as string[];
    expect([...overEnum].sort()).toEqual([...WIRE_END_REASONS].sort());
    let checked = 0;
    for (const state of ["ending", "completed", "failed"]) {
      const e = (branchesByState(rootOf(contract(DESCRIPTOR)))[state]!.properties as Record<string, Json>).endReason!.enum as string[];
      expect([...e].sort(), state).toEqual([...WIRE_END_REASONS].sort());
    }
    const over = fixture("capture-beat.v1", "answer-valid-over");
    const completed = fixture("capture-descriptor.v1", "valid-completed");
    for (const r of WIRE_END_REASONS) {
      expect(parses(S.CaptureBeatAnswer, { ...over, endReason: r }), `over ${r}`).toBe(true);
      expect(parses(S.CaptureDescriptor, { ...completed, endReason: r }), `completed ${r}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(7);
    // The DB-only words never reach the wire (§6.8.4 maps them).
    for (const r of ["operator_stopped", "no_credits", "provision_timeout"]) {
      expect(parses(S.CaptureBeatAnswer, { ...over, endReason: r }), r).toBe(false);
    }
  });

  it("refusals: 409 already_live still carries {code, message, sid, startedBy}; every refusal code has a fixture; extras ride only on already_live", () => {
    const live = fixture("capture-start.v1", "valid-already_live");
    expect(Object.keys(live).sort()).toEqual(["code", "message", "sid", "startedBy"]);
    expect(parses(S.CaptureRefusal, live)).toBe(true);
    expect(parses(S.CaptureRefusal, without(live, "startedBy")), "already_live without startedBy").toBe(false);
    expect(parses(S.CaptureRefusal, without(live, "sid")), "already_live without sid").toBe(false);
    // The codes come from the spec's table (SPEC_REFUSALS), never the twin or the file; the enums test pins the files.
    const codes = Object.keys(SPEC_REFUSALS);
    expect(codes).toHaveLength(10);
    let checked = 0;
    for (const code of codes) {
      const f = fixture("capture-start.v1", `valid-${code}`);
      expect(f.code).toBe(code);
      expect(parses(S.CaptureRefusal, f), code).toBe(true);
      if (code !== "already_live") {
        expect(Object.keys(f).sort(), code).toEqual(["code", "message"]);
        expect(parses(S.CaptureRefusal, { ...f, sid: live.sid }), `${code} carrying sid`).toBe(false);
      }
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("descriptor refusals (§6.3.1, §6.14 one fixture per refusal per file): 401, 404, 422, 429 and 503 each have a vendored fixture; 503 is `unavailable`", () => {
    const fileAdmits = fileValidator();
    let checked = 0;
    for (const code of SPEC_DESCRIPTOR_REFUSALS) {
      const f = fixture("capture-descriptor.v1", `refusal-valid-${code}`);
      expect(f.code).toBe(code);
      expect(Object.keys(f).sort(), code).toEqual(["code", "message"]);
      expect(parses(S.CaptureRefusal, f), code).toBe(true);
      expect(fileAdmits(DESCRIPTOR, "#/$defs/refusal", f), code).toBe(true);
      checked++;
    }
    expect(checked).toBe(5);
    expect([...SPEC_DESCRIPTOR_REFUSALS].map((c) => SPEC_REFUSALS[c]).sort()).toEqual([401, 404, 422, 429, 503]);
    expect(SPEC_REFUSALS.unavailable).toBe(503);
    // The descriptor directory carries no start-only refusal (409, 402, 403 cannot come from GET).
    const present = readdirSync(resolve(FIXTURES, "capture-descriptor.v1")).filter((f) => f.startsWith("refusal-valid-"));
    expect(present.map((f) => f.slice("refusal-valid-".length, -5)).sort()).toEqual([...SPEC_DESCRIPTOR_REFUSALS].sort());
  });
});

/** Runs a field matrix against the twin. For each cell, from that state's valid fixture: forbidden → add the field
 *  (its value from a fixture of a state that allows it) and expect a refusal; required → delete it and expect a
 *  refusal; optional → the present and the absent forms both parse. Returns the cells checked. */
function sweepTwin<F extends string>(matrix: Record<string, Record<F, Cell>>, fields: readonly F[], valid: Record<string, Json>, donors: Json[], twin: Twin): number {
  let cells = 0;
  for (const [state, row] of Object.entries(matrix)) {
    const base = valid[state]!;
    expect(base.state, `${state}: premise — its fixture is that state`).toBe(state);
    expect(parses(twin, base), `${state}: premise — its valid fixture parses`).toBe(true);
    for (const field of fields) {
      const donor = (): unknown => {
        const d = donors.find((x) => x[field] !== undefined && matrix[x.state as string]![field] !== NO);
        expect(d, `${state}.${field}: no fixture of an allowing state carries it`).toBeDefined();
        return structuredClone(d![field]);
      };
      const cell = row[field];
      if (cell === NO) {
        expect(field in base, `${state}.${field}: premise — absent`).toBe(false);
        expect(parses(twin, { ...base, [field]: donor() }), `${state}.${field} is forbidden`).toBe(false);
      } else if (cell === REQ) {
        expect(field in base, `${state}.${field}: premise — present`).toBe(true);
        expect(parses(twin, without(base, field)), `${state}.${field} is required`).toBe(false);
      } else {
        const present = field in base ? base : { ...base, [field]: donor() };
        expect(parses(twin, present), `${state}.${field} present`).toBe(true);
        expect(parses(twin, without(present, field)), `${state}.${field} absent`).toBe(true);
      }
      cells++;
    }
  }
  return cells;
}

/** Runs a field matrix against the JSON file's branches: required → listed and required; optional → listed, not
 *  required; forbidden → not listed, and the branch is closed. Returns the cells checked. */
function sweepFile<F extends string>(matrix: Record<string, Record<F, Cell>>, fields: readonly F[], branches: Record<string, Json>): number {
  let cells = 0;
  for (const [state, row] of Object.entries(matrix)) {
    const b = branches[state]!;
    expect(b, `the file has no ${state} branch`).toBeDefined();
    expect(b.additionalProperties, `${state}: the branch is closed`).toBe(false);
    const props = Object.keys(b.properties as Json), required = (b.required as string[] | undefined) ?? [];
    for (const field of fields) {
      const cell = row[field];
      if (cell === NO) expect(props, `${state}.${field} is forbidden`).not.toContain(field);
      else {
        expect(props, `${state}.${field} is listed`).toContain(field);
        if (cell === REQ) expect(required, `${state}.${field} is required`).toContain(field);
        else expect(required, `${state}.${field} is optional`).not.toContain(field);
      }
      cells++;
    }
  }
  return cells;
}
