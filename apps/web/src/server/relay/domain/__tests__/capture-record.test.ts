// Capture record upload (spec 2026-10-12-capture-record-upload-design.md, approved by the owner 2026-10-12) — the pure
// half: domain/capture-record.ts. The line screen (§5: the allow-list, S1–S5 with the mask skip), the token tag (§0.1,
// Q8), attribution (§6: A1, A2, the cross-code rule, Q7's closing kinds) and the owner's ruling RL (2026-10-12): a bad
// line is DROPPED, never the body refused. Pure — no DB.
//
// Expected values come from the RULEBOOKS, never from the module:
//  - the contract's own fixtures and its `$defs` patterns, read from the vendored file and run under ajv;
//  - capture's `modules/capture-engine/src/wire/token-tag-vectors.json` (the spec names it the test's rulebook, Q8);
//  - §6's worked example and its rules, transcribed row for row; Q7's four closing kinds as capture answered them and
//    then corrected them (2026-10-12: `engine-error` is NOT fatal-only, so it closes nothing).
// Every sweep counts what it checked, and the counts are pinned: zero checked fails.
//
// ONE SPORT, on purpose: not applicable — the capture surface reads no sport (spec §13.2 "Another sport").
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { CaptureRecordLine } from "@/server/api-v1/capture-schemas";
import {
  attributeLines, hasDuplicateKey, keptLines, screenRecordLine, secretRulesOf, tokenTag, type AttributableLine, type ScreenedLine,
} from "../capture-record";

type Json = Record<string, unknown>;
const CONTRACTS = resolve(import.meta.dirname, "../../../../../../../docs/contracts");
const DIR = resolve(CONTRACTS, "fixtures/capture-record.v1");
const CONTRACT = JSON.parse(readFileSync(resolve(CONTRACTS, "capture-record.v1.json"), "utf8")) as Json;
const fixture = (name: string): Json => JSON.parse(readFileSync(resolve(DIR, `${name}.json`), "utf8")) as Json;
/** A fixture's bytes, as the wire carries them (a `line-server-*` fixture's rule is on its TEXT). */
const rawFixture = (name: string): string => readFileSync(resolve(DIR, `${name}.json`), "utf8");
const lineNames = readdirSync(DIR).filter((f) => f.startsWith("line-") && f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

/** The S1 vector's Bearer: `line-secret-sending-tok` carries it as a plain word (capture-contract.test.ts pins it). */
const SENDING_TOK = "fake-tok-0000000000000";
/** Any other Bearer, for the lines that must pass whoever sends them. */
const OTHER_TOK = "Zq9rT4mW2xK7pL1vN8cB3d";

/** The published `$defs.secretS<n>` patterns, under ajv (draft 2020-12, as a vendoring repo reads them). */
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);
const fileTrips = (s: string): string[] => (["S2", "S3", "S4", "S5"] as const).filter((r) =>
  ajv.getSchema(`https://seazn.club/contracts/capture-record.v1.json#/$defs/secret${r}`)!(s) as boolean);
/** The published line shape (the root) under ajv: the rulebook for "the server can read this line". */
const fileReads = (line: unknown): boolean => ajv.getSchema("https://seazn.club/contracts/capture-record.v1.json")!(line) as boolean;

describe("tokenTag (§0.1, Q8 — confirmed final by capture 2026-10-12): FNV-1a 32-bit over UTF-16 code units, eight lowercase hex digits", () => {
  /** capture's token-tag-vectors.json, verbatim (the spec's rulebook for this test). */
  const VECTORS: [token: string, tag: string][] = [
    ["", "811c9dc5"], ["a", "e40c292c"], ["foobar", "bf9cf968"], ["cfx", "0076912c"],
    ["tok-9f3c2a7e5b1d4680", "c980ff38"], ["tok-9f3c2a7e5b1d4680ab", "b24bb97b"],
    ["fake-token-b0000000000000000000", "2cc4e08d"], ["tök-ñ-日本", "fca8f070"], ["🏏-tok", "a44d061f"],
  ];
  it("matches every one of capture's vectors — the non-ASCII and the astral ones included", () => {
    let checked = 0;
    for (const [token, tag] of VECTORS) {
      expect(tokenTag(token), JSON.stringify(token)).toBe(tag);
      checked++;
    }
    expect(checked).toBe(9);
  });
});

describe("screenRecordLine (§5 under owner ruling RL): the allow-list, then S1–S5 — one verdict per line, never a value", () => {
  it("the empty cases first: a line that is not UTF-8 (null) and an empty string are unreadable, never ok", () => {
    expect(screenRecordLine(null, OTHER_TOK)).toEqual({ ok: false, why: "shape" });
    expect(screenRecordLine("", OTHER_TOK)).toEqual({ ok: false, why: "shape" });
  });

  it("every contract line fixture: valid* ok, invalid*/tampered unreadable (dropped), each secret vector dropped on its OWN rule, each line-server-* (its raw TEXT) unreadable — the verdict agrees with the file's shape, counted per kind", () => {
    const SECRET_RULE: Record<string, string> = {
      "line-secret-sending-tok": "S1", "line-secret-ingest-url": "S2", "line-secret-srt-streamid": "S3",
      "line-secret-streamid-space": "S3", "line-secret-userinfo": "S4", "line-secret-bearer": "S5",
    };
    let valid = 0, invalid = 0, secret = 0, server = 0;
    for (const name of lineNames) {
      const value = fixture(name);
      const r = screenRecordLine(JSON.stringify(value), SENDING_TOK);
      if (/^line-valid/.test(name)) {
        expect(r.ok, `${name}: ok`).toBe(true);
        expect(fileReads(value), `${name}: premise — the file reads it`).toBe(true);
        valid++;
      } else if (/^line-(invalid-.+|tampered)$/.test(name)) {
        expect(r, `${name}: unreadable, dropped`).toEqual({ ok: false, why: "shape" });
        expect(fileReads(value), `${name}: premise — the file refuses it`).toBe(false);
        invalid++;
      } else if (/^line-secret-/.test(name)) {
        expect(r.ok, `${name}: dropped`).toBe(false);
        expect(r.ok ? null : r.why === "secret" ? r.rule : r.why, name).toBe(SECRET_RULE[name]);
        expect(fileReads(value), `${name}: premise — the file's shape admits it`).toBe(true);
        secret++;
      } else if (/^line-server-/.test(name)) {
        // Review fix 1: the parsed value is a good line (the file reads it); its TEXT names a key twice, and the
        // server screens the text, so the line is unreadable and dropped.
        expect(screenRecordLine(rawFixture(name), SENDING_TOK), `${name}: unreadable, dropped`).toEqual({ ok: false, why: "shape" });
        expect(fileReads(value), `${name}: premise — the file's shape admits the parsed value`).toBe(true);
        expect(r.ok, `${name}: premise — re-serialised, the duplicate is gone and the line reads ok`).toBe(true);
        server++;
      } else expect.fail(`${name}: an unrouted line fixture`);
    }
    expect(valid).toBe(25);
    expect(invalid).toBe(17);
    expect(secret).toBe(6);
    expect(server).toBe(1);
    expect(valid + invalid + secret + server).toBe(49);
  });

  it("S1 is the SENDING Bearer: its vector is ok under another Bearer (a plain word), and dropped as S1 under its own", () => {
    const text = JSON.stringify(fixture("line-secret-sending-tok"));
    expect(screenRecordLine(text, OTHER_TOK).ok).toBe(true);
    const own = screenRecordLine(text, SENDING_TOK);
    expect(own.ok === false && own.why === "secret" ? own.rule : null).toBe("S1");
  });

  it("S1 in all three of capture's forms (formsOf), worked by hand: raw, percent-encoded and form-encoded", () => {
    const bearer = "tok with space!(x)~";
    // encodeURIComponent leaves ! ( ) ~ alone; the form encoding writes a space as + and escapes ! ' ( ) ~.
    const forms = ["tok with space!(x)~", "tok%20with%20space!(x)~", "tok+with+space%21%28x%29%7E"];
    let checked = 0;
    for (const form of forms) {
      expect(secretRulesOf(`prefix ${form} suffix`, bearer), form).toEqual(["S1"]);
      checked++;
    }
    expect(checked).toBe(3);
    // Negative twin: a different word of the same length trips nothing.
    expect(secretRulesOf("prefix tok with spacx!(x)~ suffix", bearer)).toEqual([]);
  });

  it("the server's S2–S5 ARE the published $defs: on every string of every line fixture, every near miss unmasked and the partial masks, the rules each trips are the file's — counted", () => {
    const strings: string[] = [];
    for (const name of lineNames) for (const v of Object.values(fixture(name))) if (typeof v === "string") strings.push(v);
    // Each near miss with its mask replaced by a credential, and the three partial masks (*** then a letter or digit).
    for (const name of lineNames.filter((n) => n.startsWith("line-valid-scrubbed-"))) strings.push(String(fixture(name).message).replaceAll("***", "FAKE0123456789ABCDEF"));
    strings.push("rtmps://live.cloudflare.com:443/live/***K3Y", "passphrase=***x1", "(streamid=***0)");
    let compared = 0, tripping = 0;
    for (const s of strings) {
      const server = secretRulesOf(s, OTHER_TOK);
      expect(server, s).toEqual(fileTrips(s));
      compared++;
      if (server.length > 0) tripping++;
    }
    expect(compared).toBeGreaterThan(100);
    // Anti-vacuity: the comparison saw strings that trip (5 vectors + 9 unmasked near misses + 3 partials, at least).
    expect(tripping).toBeGreaterThanOrEqual(17);
  });

  it("every near miss — capture's own scrubbed output — is ok (review fix 1, re-review fixes 1–2), counted", () => {
    const near = lineNames.filter((n) => n.startsWith("line-valid-scrubbed-"));
    let ok = 0;
    for (const n of near) if (screenRecordLine(JSON.stringify(fixture(n)), OTHER_TOK).ok) ok++;
    expect(near).toHaveLength(10);   // the nine near misses and capture's cases 21/24 (`-vectors`)
    expect(ok).toBe(10);
  });

  it("not JSON, JSON that is not an object, an off-class value, a missing key and an unlisted key are each unreadable — and the verdict carries no value and no key name, counted", () => {
    const valid = fixture("line-valid");
    const cases: string[] = [
      "{not json FAKE-SECRET", "[1,2]", "null", "\"FAKE-SECRET\"",
      JSON.stringify({ ...valid, transport: "two words FAKE-SECRET" }),
      JSON.stringify({ at: "2026-10-11T21:19:03.123Z" }),
      JSON.stringify(fixture("line-invalid-unlisted-scalar")),
      JSON.stringify({ ...valid, "Bearer FAKE-SECRET-0123456789abcdef": 1 }),
    ];
    let checked = 0;
    for (const text of cases) {
      const r = screenRecordLine(text, OTHER_TOK);
      expect(r, text).toEqual({ ok: false, why: "shape" });
      expect(JSON.stringify(r)).not.toMatch(/FAKE-SECRET|battery|transport/);
      checked++;
    }
    expect(checked).toBe(8);
    // A secret verdict carries the parsed line (attribution reads it) but no rule ever names the value.
    const secret = screenRecordLine(JSON.stringify(fixture("line-secret-ingest-url")), OTHER_TOK);
    expect(secret.ok === false && secret.why === "secret" ? secret.rule : null).toBe("S2");
  });

  it("§0.1's premise, as capture's writers write: an ISO `at` with ms, no `level` for info, field_kind, a masked plain value — ok; an epoch `at` unreadable", () => {
    const line = { at: "2026-10-11T21:19:03.123Z", kind: "code.error", field_kind: "surface.unavailable", failure: "***", status: 503 };
    expect(screenRecordLine(JSON.stringify(line), OTHER_TOK).ok).toBe(true);
    expect(screenRecordLine(JSON.stringify({ ...line, at: 1791797943123 }), OTHER_TOK)).toEqual({ ok: false, why: "shape" });
  });

  it("the five fields capture added (ebac190): each is read in its class — rejoin-retry, preview-size and record.send ok as capture writes them; a negative wait, a fractional size and a numeric 16:9 flag unreadable", () => {
    const written: [Json, boolean][] = [
      [fixture("line-valid-rejoin-retry"), true],
      [fixture("line-valid-preview-size"), true],
      [fixture("line-valid-record-send"), true],
      [{ ...fixture("line-valid-preview-size"), pickSource: "vendor" }, true],
      [{ ...fixture("line-valid-preview-size"), pickSource: "***" }, true],
      [{ ...fixture("line-valid-record-send"), bytes: 0, status: null }, true],
      [fixture("line-invalid-retryMs-negative"), false],
      [fixture("line-invalid-bytes-fraction"), false],
      [fixture("line-invalid-pickAspect16x9-number"), false],
      [{ ...fixture("line-valid-rejoin-retry"), failures: null }, false],
      [{ ...fixture("line-valid-preview-size"), pickSource: "ours vendor" }, false],
    ];
    let checked = 0;
    for (const [line, ok] of written) {
      expect(screenRecordLine(JSON.stringify(line), OTHER_TOK).ok, JSON.stringify(line)).toBe(ok);
      expect(fileReads(line), `the file agrees: ${JSON.stringify(line)}`).toBe(ok);
      checked++;
    }
    expect(checked).toBe(11);
  });

  it("the seven scalars capture added (R-990P, 2b4df80): a `bitrate` and a `bitrate-held` line as capture writes them are ok, each key reads as the contract's generic scalar class (a number, a boolean or null — a negative sendBufferMs too) and a string, the mask, an object or an array is unreadable, counted", () => {
    // Capture's allow-list keys tagged R-990P, typed from it; the class they read in is the contract's, off gapMs.
    const KEYS = ["bandwidthBps", "dropped", "egressBps", "gateBps", "lost", "sendBufferMs", "target"];
    const props = CONTRACT.properties as Record<string, Json>;
    const classTypes = (props.gapMs.anyOf as Json[]).map((b) => b.type as string);
    expect(classTypes).toEqual(["number", "boolean", "null"]);
    const BY_TYPE: Record<string, unknown[]> = {
      number: [0, 4000000, 0.4, -1, -336], boolean: [true, false], null: [null],
      string: ["word", "***", "-336"], object: [{}], array: [[]],
    };
    const base = { at: "2026-10-11T21:42:17.350Z", kind: "bitrate-held" };
    let checked = 0, ok = 0, unreadable = 0;
    for (const k of KEYS) {
      expect(props[k], `${k}: the contract lists it`).toEqual(props.gapMs);
      for (const [type, values] of Object.entries(BY_TYPE)) {
        const want = classTypes.includes(type);
        for (const v of values) {
          const line = { ...base, [k]: v };
          const r = screenRecordLine(JSON.stringify(line), OTHER_TOK);
          expect(r.ok, `${k} = ${JSON.stringify(v)}`).toBe(want);
          if (!r.ok) expect(r, `${k} = ${JSON.stringify(v)}`).toEqual({ ok: false, why: "shape" });
          expect(fileReads(line), `the file agrees: ${k} = ${JSON.stringify(v)}`).toBe(want);
          checked++;
          if (want) ok++; else unreadable++;
        }
      }
    }
    expect(checked).toBe(7 * (5 + 2 + 1 + 3 + 1 + 1));
    expect(ok).toBe(7 * 8);
    expect(unreadable).toBe(7 * 5);
    // Still closed: a key near one of the seven is unreadable, as is a bitrate key capture does not send.
    for (const k of ["bandwidth", "sendBuffer", "targetBps", "egressbps"]) {
      expect(screenRecordLine(JSON.stringify({ ...base, [k]: 3 }), OTHER_TOK), k).toEqual({ ok: false, why: "shape" });
    }
    // The lines as capture writes them, through the real screen: the kept line is the parsed object, key for key.
    let lines = 0;
    for (const name of ["line-valid-bitrate", "line-valid-bitrate-rtmps", "line-valid-bitrate-held"]) {
      const value = fixture(name);
      const r = screenRecordLine(JSON.stringify(value), OTHER_TOK);
      expect(r.ok, name).toBe(true);
      if (r.ok) {
        expect(r.line, `${name}: kept whole, no key stripped`).toEqual(value);
        expect(JSON.parse(r.text), `${name}: and stored whole`).toEqual(value);
      }
      lines++;
    }
    expect(lines).toBe(3);
  });

  it("review fix 1 (PR #943): a key named twice is unreadable — JSON.parse keeps the LAST value, so a first, secret-shaped value would pass a screen of the parsed object; escaped key spellings are the same key — counted", () => {
    const bearer = "request headers: Authorization: Bearer FAKE-BEARER-VALUE";
    const cases = [
      `{"at":"2026-10-11T21:19:03.123Z","kind":"command-failed","message":"${bearer}","message":"ok"}`,
      // \u0061 is "a": the same key, spelled two ways.
      `{"at":"2026-10-11T21:19:03.123Z","kind":"command-failed","message":"${bearer}","mess\\u0061ge":"ok"}`,
      // A reserved key twice, the second a good value.
      `{"at":"2026-10-11T21:19:03.123Z","kind":"x","kind":"command-failed"}`,
    ];
    let checked = 0;
    for (const text of cases) {
      expect(JSON.parse(text), `premise — JSON.parse admits it: ${text}`).toBeTypeOf("object");
      const r = screenRecordLine(text, OTHER_TOK);
      expect(r, text).toEqual({ ok: false, why: "shape" });
      expect(JSON.stringify(r)).not.toContain("FAKE-BEARER-VALUE");
      checked++;
    }
    expect(checked).toBe(3);
    // Its positive pair: the same line with the key once, and a value that merely QUOTES a key, read ok.
    expect(screenRecordLine(`{"at":"2026-10-11T21:19:03.123Z","kind":"command-failed","message":"ok"}`, OTHER_TOK).ok).toBe(true);
    expect(screenRecordLine(`{"at":"2026-10-11T21:19:03.123Z","kind":"command-failed","message":"\\"message\\": twice"}`, OTHER_TOK).ok).toBe(true);
  });

  it("review fix 2 (PR #943): an own __proto__ key is unreadable whatever its value — the nested secret never reaches the string-only scan; constructor and prototype (off the list) too — counted", () => {
    const cases = [
      rawFixture("line-invalid-proto-key"),
      `{"at":"2026-10-11T21:19:03.123Z","kind":"thermal","__proto__":"ok"}`,
      `{"at":"2026-10-11T21:19:03.123Z","kind":"thermal","__proto__":null}`,
      `{"at":"2026-10-11T21:19:03.123Z","kind":"thermal","constructor":"Bearer FAKE-BEARER-VALUE"}`,
      `{"at":"2026-10-11T21:19:03.123Z","kind":"thermal","prototype":"Bearer FAKE-BEARER-VALUE"}`,
    ];
    let checked = 0;
    for (const text of cases) {
      expect(screenRecordLine(text, OTHER_TOK), text).toEqual({ ok: false, why: "shape" });
      expect(fileReads(JSON.parse(text)), `the file agrees: ${text}`).toBe(false);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("review fix 1 (PR #943): an ok verdict carries the text the server STORES — the object it screened, re-serialised, never the bytes sent", () => {
    const sent = `{ "at" : "2026-10-11T21:19:03.123Z", "kind":"thermal", "st\\u0061tus" : 3 , "headroom":0.40 }`;
    const r = screenRecordLine(sent, OTHER_TOK);
    expect(r.ok).toBe(true);
    // Typed from JSON's own rules: the escape decoded, the whitespace gone, 0.40 written 0.4.
    expect(r.ok ? r.text : null).toBe(`{"at":"2026-10-11T21:19:03.123Z","kind":"thermal","status":3,"headroom":0.4}`);
  });
});

describe("hasDuplicateKey (review fix 1): whether a JSON text names one key twice in any object, keys compared decoded", () => {
  it("the empty cases first: an empty object, an empty array and a bare scalar name no key", () => {
    expect(hasDuplicateKey("{}")).toBe(false);
    expect(hasDuplicateKey("[]")).toBe(false);
    expect(hasDuplicateKey("3")).toBe(false);
  });

  it("a table typed from RFC 8259 §4 (names SHOULD be unique; a parser keeps the last) — counted", () => {
    const TABLE: [text: string, dup: boolean][] = [
      ['{"a":1,"b":2}', false],
      ['{"a":1,"a":2}', true],
      ['{"a":1,"\\u0061":2}', true],
      ['{"a":{"a":1}}', false],                        // the same name in two objects is two keys
      ['{"a":{"b":1,"b":2}}', true],                   // nested
      ['[{"a":1},{"a":2}]', false],                    // two objects in an array
      ['[{"a":1,"a":2}]', true],
      ['{"a":"\\"a\\":1","b":"a"}', false],        // a key's spelling inside a string VALUE is not a key
      ['{"a":["a","a"],"b":1}', false],                // strings in an array are values
      ['{"a\\\\":1,"a":2}', false],                // "a\\" is a backslash after a: another key
    ];
    let checked = 0;
    for (const [text, dup] of TABLE) {
      expect(JSON.parse(text), `premise — valid JSON: ${text}`).not.toBeUndefined();
      expect(hasDuplicateKey(text), text).toBe(dup);
      checked++;
    }
    expect(checked).toBe(10);
  });

  it("an assumption made a guard: it is only ever handed text JSON.parse accepted — an unterminated string is a named refusal, never a hang", () => {
    expect(() => hasDuplicateKey('{"a')).toThrow(/hasDuplicateKey: not JSON/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Attribution (§6). Expected verdicts are §6's table and rules, never the function's.
// ---------------------------------------------------------------------------------------------------------------
const TAG_X = "c980ff38", TAG_Y = "b24bb97b";   // the worked example's tags (capture's vectors for X's and Y's toks)
const S_X = "11111111-1111-4111-8111-111111111111", S_Y = "22222222-2222-4222-8222-222222222222";
const S_NULL_PAIRING = "33333333-3333-4333-8333-333333333333";   // an organiser's start with no phone (Q9)
const AT = "2026-10-11T21:19:03.123Z";
const pair = (tag: string): AttributableLine => ({ kind: "pair", tokenTag: tag });
const device = (kind = "thermal"): AttributableLine => ({ kind });
const sidLine = (sid: string | null): AttributableLine => ({ kind: "live", sid });
const unpaired = (): AttributableLine => ({ kind: "unpaired" });
const ended = (): AttributableLine => ({ kind: "ended" });
/** Q7, as capture answered it and then corrected it (2026-10-12): the four kinds that end a pairing window. Typed here,
 *  never read off the module. `engine-error` is not one: native also writes it on non-fatal paths (Engine.kt:136;
 *  BridgeCore.kt:608) plus an error raised while already Ended (Engine.kt:138; capture's feat/s1-d3-fixes), and both
 *  fatal paths write `ended {reason: "fatal-error", wasLive}`, which closes the window as `ended`. */
const CLOSING_KINDS = ["unpaired", "ended", "pair-refused", "reset"] as const;
/** Q7 corrected: a kind native writes INSIDE a pairing that goes on. It closes nothing. */
const ENGINE_ERROR = "engine-error";
/** The sending code's context: Y unless named. `sessionsOfCode` is what A1 reads at upload time (pairing-based, Q9). */
const asY = { sessionsOfCode: new Set([S_Y]), tagsOfCode: new Set([TAG_Y]) };
const asX = { sessionsOfCode: new Set([S_X]), tagsOfCode: new Set([TAG_X]) };

describe("attributeLines (§6: A1 by session, A2 by pairing window)", () => {
  it("the empty case first: no lines keeps nothing and drops nothing", () => {
    expect(attributeLines([], asY)).toEqual([]);
  });

  it("§6's worked example, row for row: kept 3, dropped 5", () => {
    const rows: [AttributableLine, boolean][] = [
      [device("thermal"), false],     // 1 before the first pair
      [pair(TAG_X), false],           // 2 opens X's window
      [sidLine(S_X), false],          // 3 A1: X's session
      [device("network"), false],     // 4 inside X's window
      [unpaired(), false],            // 5 closes X's window
      [pair(TAG_Y), true],            // 6 opens Y's window
      [device("thermal"), true],      // 7 inside Y's window
      [sidLine(S_Y), true],           // 8 A1: Y's session
    ];
    const kept = attributeLines(rows.map(([l]) => l), asY);
    expect(kept).toEqual(rows.map(([, k]) => k));
    expect(kept.filter(Boolean)).toHaveLength(3);
    expect(kept.filter((k) => !k)).toHaveLength(5);
  });

  // [name, lines, sender, expected keep flags] — each from §6's rules.
  const TABLE: [string, AttributableLine[], typeof asY, boolean[]][] = [
    ["X→Y under Y: only Y's window", [pair(TAG_X), device(), unpaired(), pair(TAG_Y), device()], asY, [false, false, false, true, true]],
    ["Y→X under Y: Y's window closes at X's pair (just before it)", [pair(TAG_Y), device(), pair(TAG_X), device()], asY, [true, true, false, false]],
    ["X→Y→X under X: both X windows, not Y's", [pair(TAG_X), device(), ended(), pair(TAG_Y), device(), unpaired(), pair(TAG_X), device()], asX,
      [true, true, true, false, false, false, true, true]],
    ["a truncated first window (Q6): lines before the first pair are dropped, even the sender's", [device(), sidLine(null), pair(TAG_Y), device()], asY, [false, false, true, true]],
    ["X's sid inside Y's window, sent by X: kept (A1 decides on its own)", [pair(TAG_Y), sidLine(S_X)], asX, [false, true]],
    ["Y's sid inside X's window, sent by X: dropped", [pair(TAG_X), sidLine(S_Y)], asX, [true, false]],
    ["a masked sid is dropped, even inside the sender's window", [pair(TAG_Y), { kind: "live", sid: "***" }], asY, [true, false]],
    ["a null-pairing session's sid is dropped (Q9: no pairing leads to any code)", [pair(TAG_Y), sidLine(S_NULL_PAIRING)], asY, [true, false]],
    ["an unknown sid is dropped", [pair(TAG_Y), sidLine("44444444-4444-4444-8444-444444444444")], asY, [true, false]],
    ["closed by `unpaired`: the unpaired line is the window's, the next line is in none", [pair(TAG_Y), unpaired(), device()], asY, [true, true, false]],
    ["closed by `ended`: the ended line is the window's, the next line is in none", [pair(TAG_Y), ended(), device()], asY, [true, true, false]],
    ["closed by a foreign `pair`: the foreign pair opens the foreign window", [pair(TAG_Y), device(), pair(TAG_X), device(), sidLine(S_Y)], asY, [true, true, false, false, true]],
    ["a sid null line is a window line (A2), like an absent sid", [pair(TAG_Y), sidLine(null)], asY, [true, true]],
    ["the sender's uuid sid, outside any window, is still kept (A1)", [sidLine(S_Y), device()], asY, [true, false]],
    ["a sid compared case-insensitively (the uuid is the server's, either case on the wire)", [sidLine(S_Y.toUpperCase())], asY, [true]],
  ];
  it("table-driven from §6's rules — every row's verdicts, counted", () => {
    let rows = 0, lines = 0;
    for (const [name, ls, ctx, want] of TABLE) {
      expect(attributeLines(ls, ctx), name).toEqual(want);
      rows++;
      lines += ls.length;
    }
    expect(rows).toBe(TABLE.length);
    expect(rows).toBe(15);
    expect(lines).toBeGreaterThan(40);
  });

  it("Q7 (capture's answer, 2026-10-12): a no-sid line after `pair-refused` or `reset` is DROPPED — the closing line is the window's; a uuid sid line after it is still A1's", () => {
    let checked = 0;
    for (const kind of ["pair-refused", "reset"]) {
      expect(attributeLines([pair(TAG_Y), device(), { kind }, device("network")], asY), kind).toEqual([true, true, true, false]);
      expect(attributeLines([pair(TAG_Y), { kind }, sidLine(null)], asY), `${kind}, then a null sid`).toEqual([true, true, false]);
      expect(attributeLines([pair(TAG_Y), { kind }, sidLine(S_Y)], asY), `${kind}, then the sender's sid`).toEqual([true, true, true]);
      // The window is closed, not poisoned: the sender's next pair opens a new one.
      expect(attributeLines([pair(TAG_Y), { kind }, device(), pair(TAG_Y), device()], asY), `${kind}, then a new pair`).toEqual([true, true, false, true, true]);
      checked++;
    }
    expect(checked).toBe(2);
    // The same holds for all four of Q7's kinds — the two the spec named first and the two capture added.
    let all = 0;
    for (const kind of CLOSING_KINDS) {
      expect(attributeLines([pair(TAG_Y), { kind }, device()], asY), kind).toEqual([true, true, false]);
      all++;
    }
    expect(all).toBe(4);
    // Positive pair: a kind that closes nothing (a vendor log line) keeps the window open.
    expect(attributeLines([pair(TAG_Y), { kind: "vendor-log" }, device()], asY)).toEqual([true, true, true]);
  });

  it("Q7 CORRECTED by capture (2026-10-12): a non-fatal `engine-error` closes nothing — a no-sid line after it is KEPT; after `engine-error` then the fatal path's `ended` it is DROPPED", () => {
    // Non-fatal: the pairing goes on, so the sender's no-sid lines after it are the sender's — once, and on a second
    // and third error in a row (each of native's non-fatal paths can write one, and a path can write one again).
    expect(attributeLines([pair(TAG_Y), device(), { kind: ENGINE_ERROR }, device("network")], asY)).toEqual([true, true, true, true]);
    expect(attributeLines([pair(TAG_Y), { kind: ENGINE_ERROR }, sidLine(null)], asY), "then a null sid").toEqual([true, true, true]);
    expect(attributeLines([pair(TAG_Y), { kind: ENGINE_ERROR }, { kind: ENGINE_ERROR }, { kind: ENGINE_ERROR }, device()], asY), "three in a row")
      .toEqual([true, true, true, true, true]);
    // Fatal: native writes `ended {reason: "fatal-error", wasLive}` after the error; `ended` closes through itself.
    expect(attributeLines([pair(TAG_Y), device(), { kind: ENGINE_ERROR }, ended(), device("network"), sidLine(null)], asY), "fatal")
      .toEqual([true, true, true, true, false, false]);
    // It opens nothing either: before the first pair, and inside another code's window, it is no window of the sender's.
    expect(attributeLines([{ kind: ENGINE_ERROR }, device()], asY), "before any pair").toEqual([false, false]);
    expect(attributeLines([pair(TAG_X), { kind: ENGINE_ERROR }, device()], asY), "inside X's window, sent by Y").toEqual([false, false, false]);
    // And it does not carry a window past a foreign pair: X's pair still closes Y's window just before it.
    expect(attributeLines([pair(TAG_Y), { kind: ENGINE_ERROR }, pair(TAG_X), device()], asY), "then a foreign pair").toEqual([true, true, false, false]);
  });

  it("Q7 CORRECTED, through the REAL screen: the lines as native writes them (engine-error's `message`, ended's `reason: \"fatal-error\"` and `wasLive`) are admitted by the published contract and its twin, then attributed — the line after the error kept, the line after `ended` dropped", () => {
    const tag = tokenTag(OTHER_TOK);
    const native: [object, boolean][] = [
      [{ at: AT, kind: "pair", claim: "new", slot: 0, tokenTag: tag }, true],
      [{ at: AT, kind: ENGINE_ERROR, message: "java.lang.IllegalStateException: snapshot not whole", suppressed: 0 }, true],
      [{ at: AT, kind: "thermal", level: "warn", status: 3 }, true],                       // after a non-fatal error: kept
      [{ at: AT, kind: ENGINE_ERROR, message: "java.lang.IllegalStateException: machine failed" }, true],
      [{ at: AT, kind: "ended", reason: "fatal-error", wasLive: true }, true],              // the fatal path's own line
      [{ at: AT, kind: "thermal", level: "warn", status: 3 }, false],                      // after `ended`: dropped
    ];
    const ctx = { sessionsOfCode: new Set<string>(), tagsOfCode: new Set([tag]) };
    let admitted = 0;
    const screened = native.map(([line]) => {
      expect(fileReads(line), `the contract reads ${JSON.stringify(line)}`).toBe(true);
      const s = screenRecordLine(JSON.stringify(line), OTHER_TOK);
      expect(s.ok, `the twin admits ${JSON.stringify(line)}`).toBe(true);
      admitted++;
      return s;
    });
    expect(admitted).toBe(6);
    // `wasLive` false is the same class: a fatal error before the broadcast went live.
    expect(screenRecordLine(JSON.stringify({ at: AT, kind: "ended", reason: "fatal-error", wasLive: false }), OTHER_TOK).ok).toBe(true);
    expect(keptLines(screened, ctx)).toEqual(native.map(([, kept]) => kept));
  });

  it("an UNREADABLE line (null) is dropped and closes the window before it — it may be another code's pair — while A1 still judges uuid sids after it", () => {
    expect(attributeLines([null], asY)).toEqual([false]);
    expect(attributeLines([pair(TAG_Y), device(), null, device()], asY)).toEqual([true, true, false, false]);
    expect(attributeLines([pair(TAG_Y), null, sidLine(S_Y), sidLine(null)], asY)).toEqual([true, false, true, false]);
    // The leak it guards: Y's window, then X's pair arrives MALFORMED, then X's device lines — none of X's are kept.
    expect(attributeLines([pair(TAG_Y), device(), null, device(), device("network")], asY)).toEqual([true, true, false, false, false]);
    // Not a poison pill: Y's next readable pair opens a window again.
    expect(attributeLines([pair(TAG_Y), null, pair(TAG_Y), device()], asY)).toEqual([true, false, true, true]);
  });

  it("CROSS-CODE (the regression): club X's whole record sent under club Y's token keeps NOTHING", () => {
    const xRecord = [device(), pair(TAG_X), device(), sidLine(S_X), { kind: "live", sid: S_X, level: "warn" }, unpaired(), device()];
    const kept = attributeLines(xRecord, asY);
    expect(kept).toHaveLength(7);
    expect(kept.every((k) => !k)).toBe(true);
    // Positive pair: the same record under X's own token keeps its window and its session.
    expect(attributeLines(xRecord, asX).filter(Boolean)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// keptLines — the owner's ruling RL (2026-10-12): a bad line is dropped, never the body refused.
// ---------------------------------------------------------------------------------------------------------------
const asLine = (l: AttributableLine): CaptureRecordLine => ({ at: AT, ...l }) as CaptureRecordLine;
const ok = (l: AttributableLine): ScreenedLine => ({ ok: true, line: asLine(l), text: JSON.stringify(asLine(l)) });
const secretOf = (l: AttributableLine): ScreenedLine => ({ ok: false, why: "secret", rule: "S2", line: asLine(l) });
const unreadable: ScreenedLine = { ok: false, why: "shape" };

describe("keptLines (owner ruling RL): attribution, then every bad line dropped — and nothing else changes", () => {
  it("the empty case first, then all-bad: nothing kept, no throw", () => {
    expect(keptLines([], asY)).toEqual([]);
    expect(keptLines([unreadable, secretOf(pair(TAG_Y)), unreadable], asY)).toEqual([false, false, false]);
  });

  it("a SECRET line is read like any other and then dropped: it neither breaks the sender's window nor is kept", () => {
    expect(keptLines([ok(pair(TAG_Y)), ok(device()), secretOf(device("vendor-log")), ok(device())], asY)).toEqual([true, true, false, true]);
    // The sender's own pair, secret-shaped elsewhere in it, still opens the window — the pair line itself is dropped.
    expect(keptLines([secretOf(pair(TAG_Y)), ok(device())], asY)).toEqual([false, true]);
    // A foreign pair, secret-shaped, still closes the sender's window.
    expect(keptLines([ok(pair(TAG_Y)), secretOf(pair(TAG_X)), ok(device())], asY)).toEqual([true, false, false]);
    // A secret line carrying the sender's own sid: A1 would keep it, the ruling drops it.
    expect(keptLines([secretOf(sidLine(S_Y))], asY)).toEqual([false]);
  });

  it("an UNREADABLE line is dropped and is a boundary; the lines around it are judged as usual", () => {
    expect(keptLines([ok(pair(TAG_Y)), ok(device()), unreadable, ok(device()), ok(sidLine(S_Y))], asY)).toEqual([true, true, false, false, true]);
  });

  it("the drop is the ONLY effect: with every bad line removed, the good lines' verdicts are attribution's on the readable sequence", () => {
    const seq: ScreenedLine[] = [ok(pair(TAG_Y)), ok(device()), secretOf(device()), ok(sidLine(S_Y)), ok(sidLine(S_X)), ok(unpaired()), ok(device())];
    const kept = keptLines(seq, asY);
    const plain = attributeLines(seq.map((s) => (s.ok || s.why === "secret" ? s.line : null)), asY);
    let compared = 0;
    seq.forEach((s, i) => {
      expect(kept[i], `line ${i + 1}`).toBe(s.ok ? plain[i] : false);
      compared++;
    });
    expect(compared).toBe(7);
    expect(kept.filter(Boolean)).toHaveLength(4);
  });
});

describe("keptLines — model-based sequences (TEST-STRATEGY rule 10)", () => {
  /** Three codes, each a tok from capture's vectors with its known tag (never computed here), two sessions each. */
  const CODES = [
    { tag: "c980ff38", sessions: ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002"] },
    { tag: "b24bb97b", sessions: ["b0000000-0000-4000-8000-000000000001", "b0000000-0000-4000-8000-000000000002"] },
    { tag: "2cc4e08d", sessions: ["c0000000-0000-4000-8000-000000000001", "c0000000-0000-4000-8000-000000000002"] },
  ];
  /** `owner` is the code whose record the line belongs in, decided by the generator; null = no record keeps it.
   *  `afterEngineError`: a no-sid line that follows an `engine-error` inside the same window (the generator knows). */
  type Owned = { line: ScreenedLine; owner: number | null; afterEngineError?: true };
  const item = fc.oneof(
    fc.constant({ t: "device" as const }),
    fc.record({ t: fc.constant("sid" as const), code: fc.integer({ min: 0, max: 2 }), i: fc.integer({ min: 0, max: 1 }) }),
    fc.constant({ t: "null-pairing" as const }),
    fc.constant({ t: "masked" as const }),
    fc.constant({ t: "unreadable" as const }),
    fc.constant({ t: "secret" as const }),
    // Q7 corrected (capture, 2026-10-12): a NON-closing kind — a window line, owned like a device line.
    fc.constant({ t: "engine-error" as const }),
  );
  const segment = fc.record({
    code: fc.integer({ min: 0, max: 2 }),
    secretPair: fc.boolean(),
    body: fc.array(item, { maxLength: 4 }),
    close: fc.constantFrom(...CLOSING_KINDS, "none"),
    after: fc.array(item, { maxLength: 3 }),
  });
  const phone = fc.record({ pre: fc.array(item, { maxLength: 3 }), segments: fc.array(segment, { maxLength: 4 }), sender: fc.integer({ min: 0, max: 2 }) });

  type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;
  type Item = ValueOf<typeof item>;
  type Phone = ValueOf<typeof phone>;

  function build(p: Phone): Owned[] {
    const out: Owned[] = [];
    /** Whether an `engine-error` fell earlier in the current window (reset whenever the window ends or a new opens). */
    let errored = false;
    /** Emits one item inside the window owned by `w` (null: no window); returns the window owner after it. */
    const emit = (it: Item, w: number | null): number | null => {
      if (it.t === "device") out.push({ line: ok({ kind: "thermal" }), owner: w, ...(errored && w !== null ? { afterEngineError: true as const } : {}) });
      else if (it.t === "engine-error") {
        out.push({ line: ok({ kind: "engine-error" }), owner: w });   // the model's reading of Q7 corrected: closes nothing
        errored = w !== null;
      } else if (it.t === "sid") out.push({ line: ok({ kind: "live", sid: CODES[it.code]!.sessions[it.i]! }), owner: it.code });
      else if (it.t === "null-pairing") out.push({ line: ok({ kind: "live", sid: S_NULL_PAIRING }), owner: null });
      else if (it.t === "masked") out.push({ line: ok({ kind: "live", sid: "***" }), owner: null });
      else if (it.t === "secret") out.push({ line: secretOf({ kind: "vendor-log" }), owner: null });
      else {
        out.push({ line: unreadable, owner: null });
        errored = false;
        return null;   // the model's own reading of the rule: an unreadable line ends the window it falls in
      }
      return w;
    };
    let w: number | null = null;
    for (const it of p.pre) w = emit(it, w);
    for (const s of p.segments) {
      const pairLine = { kind: "pair", tokenTag: CODES[s.code]!.tag };
      out.push({ line: s.secretPair ? secretOf(pairLine) : ok(pairLine), owner: s.secretPair ? null : s.code });
      w = s.code;
      errored = false;
      for (const it of s.body) w = emit(it, w);
      if (s.close === "none") continue;   // an open window runs to the next pair: no "after" lines outside it
      out.push({ line: ok({ kind: s.close }), owner: w });
      w = null;
      errored = false;
      for (const it of s.after) w = emit(it, w);
    }
    return out;
  }

  it("after EVERY step: kept lines are all the sender's and none is bad, every good sender's line is kept, kept + dropped = received; runs with kept, dropped, unreadable, secret, every closing kind and a no-sid line KEPT after a non-fatal engine-error all seen", () => {
    let runs = 0, keptRuns = 0, droppedRuns = 0, steps = 0, unreadableRuns = 0, secretRuns = 0, engineErrorRuns = 0, keptAfterErrorRuns = 0;
    const closers = new Set<string>();
    fc.assert(fc.property(phone, (p) => {
      const lines = build(p);
      const ctx = { sessionsOfCode: new Set(CODES[p.sender]!.sessions), tagsOfCode: new Set([CODES[p.sender]!.tag]) };
      let lastKept = 0, lastDropped = 0;
      for (let n = 0; n <= lines.length; n++) {
        const prefix = lines.slice(0, n);
        const kept = keptLines(prefix.map((o) => o.line), ctx);
        expect(kept).toHaveLength(n);
        prefix.forEach((o, i) => {
          expect(kept[i], `line ${i + 1} owner ${o.owner} sender ${p.sender}`).toBe(o.owner === p.sender);
          if (kept[i]) expect(o.line.ok, `line ${i + 1}: a kept line is never a bad one`).toBe(true);
        });
        lastKept = kept.filter(Boolean).length;
        lastDropped = kept.filter((k) => !k).length;
        expect(lastKept + lastDropped).toBe(n);
        steps++;
      }
      runs++;
      if (lastKept > 0) keptRuns++;
      if (lastDropped > 0) droppedRuns++;
      if (lines.some((o) => !o.line.ok && o.line.why === "shape")) unreadableRuns++;
      if (lines.some((o) => !o.line.ok && o.line.why === "secret")) secretRuns++;
      for (const o of lines) if (o.line.ok && CLOSING_KINDS.includes(o.line.line.kind as (typeof CLOSING_KINDS)[number])) closers.add(o.line.line.kind);
      if (lines.some((o) => o.line.ok && o.line.line.kind === ENGINE_ERROR)) engineErrorRuns++;
      // The witness for Q7 corrected: the sender's no-sid line after an engine-error in the sender's window, kept.
      if (lines.some((o) => o.afterEngineError && o.owner === p.sender)) keptAfterErrorRuns++;
    }), { numRuns: 400, seed: 20261012 });
    expect(runs).toBe(400);
    expect(keptRuns, "runs with kept > 0").toBeGreaterThan(0);
    expect(droppedRuns, "runs with dropped > 0").toBeGreaterThan(0);
    expect(unreadableRuns, "runs with an unreadable line").toBeGreaterThan(0);
    expect(secretRuns, "runs with a secret line").toBeGreaterThan(0);
    expect([...closers].sort(), "every closing kind generated").toEqual([...CLOSING_KINDS].sort());
    expect(engineErrorRuns, "runs with an engine-error line").toBeGreaterThan(0);
    expect(keptAfterErrorRuns, "runs keeping the sender's no-sid line after an engine-error").toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(runs);
  });
});
