// Capture record upload (spec 2026-10-12-capture-record-upload-design.md, approved by the owner 2026-10-12) — the pure
// half: domain/capture-record.ts. Validation (§5: the allow-list, S1–S5 with the mask skip), the token tag (§0.1, Q8)
// and attribution (§6: A1, A2, the cross-code rule). Pure — no DB.
//
// Expected values come from the RULEBOOKS, never from the module:
//  - the contract's own fixtures and its `$defs` patterns, read from the vendored file and run under ajv;
//  - capture's `modules/capture-engine/src/wire/token-tag-vectors.json` (the spec names it the test's rulebook, Q8);
//  - §6's worked example and its rules, transcribed row for row.
// Every sweep counts what it checked, and the counts are pinned: zero checked fails.
//
// ONE SPORT, on purpose: not applicable — the capture surface reads no sport (spec §13.2 "Another sport").
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { attributeLines, secretRulesOf, tokenTag, validateRecordLines, type AttributableLine } from "../capture-record";

type Json = Record<string, unknown>;
const CONTRACTS = resolve(import.meta.dirname, "../../../../../../../docs/contracts");
const DIR = resolve(CONTRACTS, "fixtures/capture-record.v1");
const CONTRACT = JSON.parse(readFileSync(resolve(CONTRACTS, "capture-record.v1.json"), "utf8")) as Json;
const fixture = (name: string): Json => JSON.parse(readFileSync(resolve(DIR, `${name}.json`), "utf8")) as Json;
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

describe("tokenTag (§0.1, Q8): FNV-1a 32-bit over UTF-16 code units, eight lowercase hex digits", () => {
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

describe("validateRecordLines (§5): the allow-list, then S1–S5, whole body or nothing", () => {
  it("the empty case first: no lines is a refusal (P10: 0 lines is 422), never an empty success", () => {
    const r = validateRecordLines([], OTHER_TOK);
    expect(r.ok).toBe(false);
  });

  it("every contract line fixture: valid* admitted, invalid*/tampered refused, each secret vector refused on its OWN rule — counted per kind", () => {
    const SECRET_RULE: Record<string, string> = {
      "line-secret-sending-tok": "S1", "line-secret-ingest-url": "S2", "line-secret-srt-streamid": "S3",
      "line-secret-streamid-space": "S3", "line-secret-userinfo": "S4", "line-secret-bearer": "S5",
    };
    let valid = 0, invalid = 0, secret = 0;
    for (const name of lineNames) {
      const text = JSON.stringify(fixture(name));
      const r = validateRecordLines([text], SENDING_TOK);
      if (/^line-valid/.test(name)) {
        expect(r.ok, `${name}: admitted`).toBe(true);
        valid++;
      } else if (/^line-(invalid-.+|tampered)$/.test(name)) {
        expect(r.ok, `${name}: refused`).toBe(false);
        if (!r.ok) expect(r.message, name).toMatch(/^line 1: /);
        invalid++;
      } else if (/^line-secret-/.test(name)) {
        expect(r.ok, `${name}: refused`).toBe(false);
        if (!r.ok) expect(r.message, name).toMatch(new RegExp(`^line 1: \\w+ is secret-shaped \\(${SECRET_RULE[name]}\\)$`));
        secret++;
      } else expect.fail(`${name}: an unrouted line fixture`);
    }
    expect(valid).toBe(19);
    expect(invalid).toBe(13);
    expect(secret).toBe(6);
    expect(valid + invalid + secret).toBe(38);
  });

  it("S1 is the SENDING Bearer: its vector passes under another Bearer (a plain word), and is refused under its own", () => {
    const text = JSON.stringify(fixture("line-secret-sending-tok"));
    expect(validateRecordLines([text], OTHER_TOK).ok).toBe(true);
    expect(validateRecordLines([text], SENDING_TOK)).toEqual({ ok: false, message: "line 1: state is secret-shaped (S1)" });
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

  it("every near miss — capture's own scrubbed output — is ADMITTED whole (review fix 1, re-review fixes 1–2)", () => {
    const near = lineNames.filter((n) => n.startsWith("line-valid-scrubbed-"));
    const r = validateRecordLines(near.map((n) => JSON.stringify(fixture(n))), OTHER_TOK);
    expect(r.ok).toBe(true);
    expect(near).toHaveLength(10);   // the nine near misses and capture's cases 21/24 (`-vectors`)
  });

  it("one bad line refuses the WHOLE body; the message names the line number, the key and the rule — never the value", () => {
    const good = JSON.stringify(fixture("line-valid"));
    const bad = fixture("line-secret-ingest-url");
    const r = validateRecordLines([good, good, JSON.stringify(bad), good], OTHER_TOK);
    expect(r).toEqual({ ok: false, message: "line 3: message is secret-shaped (S2)" });
    expect(r.ok ? "" : r.message).not.toContain("FAKE-STREAM-KEY");
    // Shape before secrets: a body with a shape error on line 4 and a secret on line 2 answers the shape error.
    const both = validateRecordLines([good, JSON.stringify(bad), good, JSON.stringify({ ...fixture("line-valid"), cred: "x" })], OTHER_TOK);
    expect(both).toEqual({ ok: false, message: "line 4: key cred is not on the allow-list" });
  });

  it("a line that is not JSON, or JSON that is not an object, is refused by line number; a value is never quoted", () => {
    const good = JSON.stringify(fixture("line-valid"));
    const cases: [string, string][] = [
      ["{not json", "line 2: not JSON"],
      ["[1,2]", "line 2: not a JSON object"],
      ["null", "line 2: not a JSON object"],
      ["\"FAKE-SECRET\"", "line 2: not a JSON object"],
    ];
    let checked = 0;
    for (const [text, message] of cases) {
      expect(validateRecordLines([good, text], OTHER_TOK), text).toEqual({ ok: false, message });
      checked++;
    }
    expect(checked).toBe(4);
    // Off-class and missing keys name the key only.
    expect(validateRecordLines([JSON.stringify({ ...fixture("line-valid"), transport: "two words FAKE" })], OTHER_TOK))
      .toEqual({ ok: false, message: "line 1: key transport is off its class" });
    expect(validateRecordLines([JSON.stringify({ at: "2026-10-11T21:19:03.123Z" })], OTHER_TOK))
      .toEqual({ ok: false, message: "line 1: key kind is missing" });
  });

  it("the contract's own 422 example (`valid-invalid`: an unlisted `battery` on line 3) is the message the server writes", () => {
    const want = fixture("valid-invalid");
    const good = JSON.stringify(fixture("line-valid"));
    const r = validateRecordLines([good, good, JSON.stringify(fixture("line-invalid-unlisted-scalar"))], OTHER_TOK);
    expect(want.code).toBe("invalid");
    expect(r).toEqual({ ok: false, message: want.message });
    // A key that does not look like a key is not echoed either: the refusal says only that a key is unlisted.
    const odd = validateRecordLines([JSON.stringify({ ...fixture("line-valid"), "Bearer FAKE-0123456789abcdef": 1 })], OTHER_TOK);
    expect(odd).toEqual({ ok: false, message: "line 1: a key is not on the allow-list" });
  });

  it("§0.1's premise, as capture's writers write: an ISO `at` with ms, no `level` for info, field_kind, a masked plain value — admitted; an epoch `at` refused", () => {
    const line = { at: "2026-10-11T21:19:03.123Z", kind: "code.error", field_kind: "surface.unavailable", failure: "***", status: 503 };
    expect(validateRecordLines([JSON.stringify(line)], OTHER_TOK).ok).toBe(true);
    expect(validateRecordLines([JSON.stringify({ ...line, at: 1791797943123 })], OTHER_TOK)).toEqual({ ok: false, message: "line 1: key at is off its class" });
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

  it("CROSS-CODE (the regression): club X's whole record sent under club Y's token keeps NOTHING", () => {
    const xRecord = [device(), pair(TAG_X), device(), sidLine(S_X), { kind: "live", sid: S_X, level: "warn" }, unpaired(), device()];
    const kept = attributeLines(xRecord, asY);
    expect(kept).toHaveLength(7);
    expect(kept.every((k) => !k)).toBe(true);
    // Positive pair: the same record under X's own token keeps its window and its session.
    expect(attributeLines(xRecord, asX).filter(Boolean)).toHaveLength(5);
  });
});

describe("attributeLines — model-based sequences (TEST-STRATEGY rule 10)", () => {
  /** Three codes, each a toke from capture's vectors with its known tag (never computed here), two sessions each. */
  const CODES = [
    { tag: "c980ff38", sessions: ["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002"] },
    { tag: "b24bb97b", sessions: ["b0000000-0000-4000-8000-000000000001", "b0000000-0000-4000-8000-000000000002"] },
    { tag: "2cc4e08d", sessions: ["c0000000-0000-4000-8000-000000000001", "c0000000-0000-4000-8000-000000000002"] },
  ];
  type Owned = { line: AttributableLine; owner: number | null };
  /** An item the phone logs, its owner decided by the generator: a device line belongs to the window it falls in (or
   *  none), a sid line to its session's code (a null-pairing or masked sid to none). */
  const item = fc.oneof(
    fc.constant({ t: "device" as const }),
    fc.record({ t: fc.constant("sid" as const), code: fc.integer({ min: 0, max: 2 }), i: fc.integer({ min: 0, max: 1 }) }),
    fc.constant({ t: "null-pairing" as const }),
    fc.constant({ t: "masked" as const }),
  );
  const segment = fc.record({
    code: fc.integer({ min: 0, max: 2 }),
    body: fc.array(item, { maxLength: 4 }),
    close: fc.constantFrom("unpaired", "ended", "none"),
    after: fc.array(item, { maxLength: 3 }),
  });
  const phone = fc.record({ pre: fc.array(item, { maxLength: 3 }), segments: fc.array(segment, { maxLength: 4 }), sender: fc.integer({ min: 0, max: 2 }) });

  type ValueOf<A> = A extends fc.Arbitrary<infer T> ? T : never;
  type Item = ValueOf<typeof item>;
  type Phone = ValueOf<typeof phone>;

  function build(p: Phone): Owned[] {
    const out: Owned[] = [];
    const emit = (it: Item, windowOwner: number | null) => {
      if (it.t === "device") out.push({ line: { kind: "thermal" }, owner: windowOwner });
      else if (it.t === "sid") out.push({ line: { kind: "live", sid: CODES[it.code]!.sessions[it.i]! }, owner: it.code });
      else if (it.t === "null-pairing") out.push({ line: { kind: "live", sid: S_NULL_PAIRING }, owner: null });
      else out.push({ line: { kind: "live", sid: "***" }, owner: null });
    };
    for (const it of p.pre) emit(it, null);
    for (const s of p.segments) {
      out.push({ line: { kind: "pair", tokenTag: CODES[s.code]!.tag }, owner: s.code });
      for (const it of s.body) emit(it, s.code);
      if (s.close === "none") continue;   // an open window runs to the next pair: no "after" lines outside it
      out.push({ line: { kind: s.close }, owner: s.code });
      for (const it of s.after) emit(it, null);
    }
    return out;
  }

  it("after EVERY step: kept lines are all the sender's, every sender's line is kept, kept + dropped = received; runs with kept > 0 and with dropped > 0 both seen", () => {
    let runs = 0, keptRuns = 0, droppedRuns = 0, steps = 0;
    fc.assert(fc.property(phone, (p) => {
      const lines = build(p);
      const ctx = { sessionsOfCode: new Set(CODES[p.sender]!.sessions), tagsOfCode: new Set([CODES[p.sender]!.tag]) };
      let lastKept = 0, lastDropped = 0;
      for (let n = 0; n <= lines.length; n++) {
        const prefix = lines.slice(0, n);
        const kept = attributeLines(prefix.map((o) => o.line), ctx);
        expect(kept).toHaveLength(n);
        prefix.forEach((o, i) => expect(kept[i], `line ${i + 1} (${o.line.kind}) owner ${o.owner} sender ${p.sender}`).toBe(o.owner === p.sender));
        lastKept = kept.filter(Boolean).length;
        lastDropped = kept.filter((k) => !k).length;
        expect(lastKept + lastDropped).toBe(n);
        steps++;
      }
      runs++;
      if (lastKept > 0) keptRuns++;
      if (lastDropped > 0) droppedRuns++;
    }), { numRuns: 400, seed: 20261012 });
    expect(runs).toBe(400);
    expect(keptRuns, "runs with kept > 0").toBeGreaterThan(0);
    expect(droppedRuns, "runs with dropped > 0").toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(runs);
  });
});
