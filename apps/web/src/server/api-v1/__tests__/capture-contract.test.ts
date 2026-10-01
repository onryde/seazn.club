// The capture QR v2 phone↔web contract (spec 2026-10-01 §4, §6.2, §6.3, §6.14, §17.5; PR-1 T1).
//
// docs/contracts/capture-*.json are the cross-repo authority: the capture app vendors them byte for byte. The zod
// twins (server/api-v1/capture-schemas.ts, and CaptureQrV2 in lib/capture-qr.ts) mirror them. This file pins:
//   * each contract's sha256 — a change is a deliberate bump that moves the constant in the same commit;
//   * structural parity, file ↔ z.toJSONSchema(twin), per union branch matched by `state`;
//   * every hand-written fixture: `valid*` parses, `invalid-*` / `tampered*` / `wrong-version` is refused;
//   * the per-state field matrices (R5 final, A21), TYPED HERE FROM THE SPEC'S TEXT (§6.3.1, §17.5) — the rulebook,
//     never read off the twin — run against BOTH the twin (through the fixtures) and the JSON file (structurally);
//   * optional-versus-null, `at`'s offset, strictness surviving .extend()/.partial(), W21's hosts, QR v2, and 409.
// Every sweep counts what it checked, and the counts are pinned: a skipped cell, branch or fixture fails the run.
//
// Pure — no DB. One "sport" on purpose: the contract reads no sport (the capture surface is sport-agnostic).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
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
  "capture-qr.v2.json": "1eca6c684ede6fa1b3cbf7063ad5c3eb0294e7c7247fd3adcfb762dd8a029a21",
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

// ---------------------------------------------------------------------------------------------------------------
// The file → twin map, and the fixture directories' routing.
// ---------------------------------------------------------------------------------------------------------------
const QR = "capture-qr.v2.json", DESCRIPTOR = "capture-descriptor.v1.json", BEAT = "capture-beat.v1.json", START = "capture-start.v1.json";
/** Each file's `$defs`, exactly. */
const DEFS: Record<string, string[]> = { [QR]: [], [DESCRIPTOR]: ["refusal"], [BEAT]: ["answer"], [START]: ["ok", "refusal"] };

/** Per directory: [file prefix, twin], first match wins; and the exact fixture count (never 0). */
const DIRS: Record<string, { routes: [string, Twin][]; count: number }> = {
  "capture-qr.v2": { routes: [["", CaptureQrV2]], count: 6 },
  "capture-descriptor.v1": { routes: [["refusal-", S.CaptureRefusal], ["", S.CaptureDescriptor]], count: 27 },
  "capture-beat.v1": { routes: [["beat-", S.CaptureBeat], ["answer-", S.CaptureBeatAnswer]], count: 28 },
  "capture-start.v1": { routes: [["request-", S.CaptureStartBody], ["ok-", S.CaptureStartOk], ["", S.CaptureRefusal]], count: 18 },
};

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

  it("fixtures: every valid* parses with its twin, every invalid-* / tampered* / wrong-version is refused — counted per directory", () => {
    let total = 0;
    for (const [dir, { routes, count }] of Object.entries(DIRS)) {
      const names = readdirSync(resolve(FIXTURES, dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
      let checked = 0;
      for (const name of names) {
        const route = routes.find(([prefix]) => name.startsWith(prefix));
        expect(route, `${dir}/${name}: no twin routes this fixture`).toBeDefined();
        const [prefix, twin] = route!;
        const kind = name.slice(prefix.length);
        const value = fixture(dir, name);
        if (/^valid(-.+)?$/.test(kind)) expect(parses(twin, value), `${dir}/${name} must parse`).toBe(true);
        else if (/^(invalid-.+|tampered(-.+)?|wrong-version)$/.test(kind)) expect(parses(twin, value), `${dir}/${name} must be refused`).toBe(false);
        else expect.fail(`${dir}/${name}: neither valid* nor invalid-*/tampered*/wrong-version`);
        checked++;
      }
      expect(checked, `${dir}: fixtures checked`).toBeGreaterThan(0);
      expect(checked, `${dir}: fixtures checked`).toBe(count);
      total += checked;
    }
    expect(total).toBe(6 + 27 + 28 + 18);
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
    // The contract file says the same: four properties, all required, nothing else.
    const file = contract(QR);
    expect(Object.keys(file.properties as Json).sort()).toEqual(["code", "slot", "tok", "v"]);
    expect([...(file.required as string[])].sort()).toEqual(["code", "slot", "tok", "v"]);
    expect(file.additionalProperties).toBe(false);
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
    // The codes come from the contract FILE (the cross-repo authority), not the twin.
    const branches = defOf(contract(START), "refusal").anyOf as Json[];
    const codes = branches.flatMap((b) => {
      const c = (b.properties as Record<string, Json>).code!;
      return c.const !== undefined ? [c.const as string] : (c.enum as string[]);
    });
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
