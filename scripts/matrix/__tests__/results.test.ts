import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_BASE, findLocalBases, findSecrets, redact, scrubLocalBase } from "../lib/redact.ts";
import { CASE_STATES, GLYPH, SecretInResults, decideState, parseResults, writeResults, type CaseResult, type CheckResult, type RunResults } from "../lib/results.ts";

const chk = (p: Partial<CheckResult>): CheckResult => ({ id: "c", kind: "invariant", verdict: "pass", checked: 1, reason: "", evidence: [], ...p });

describe("decideState — empty case first (R13, R25)", () => {
  it("no checks at all is red, not works", () => {
    const r = decideState({ checks: [], deferred: null, error: null });
    expect(r.state).toBe("red");
    // Its own reason, so the branch is not just "falls through to all-abstained".
    expect(r.reason).toMatch(/no checks ran/);
  });
  it("every check abstained is red: vacuous (Review Focus 1)", () => {
    const r = decideState({ checks: [chk({ verdict: "abstain", checked: 0 }), chk({ verdict: "abstain", checked: 0 })], deferred: null, error: null });
    expect(r).toEqual({ state: "red", reason: expect.stringMatching(/vacuous/) });
  });
  it("a passing check that checked zero items is red", () => {
    expect(decideState({ checks: [chk({ checked: 0 })], deferred: null, error: null }).state).toBe("red");
  });
});

describe("decideState", () => {
  it("one applied pass with items → works", () => {
    expect(decideState({ checks: [chk({}), chk({ verdict: "abstain", checked: 0 })], deferred: null, error: null }).state).toBe("works");
  });
  it("works reason counts APPLIED checks and their items, never the abstentions", () => {
    const r = decideState({ checks: [chk({ checked: 3 }), chk({ id: "b", checked: 2 }), chk({ id: "x", verdict: "abstain", checked: 0 })], deferred: null, error: null });
    expect(r).toEqual({ state: "works", reason: "2 checks, 5 items" });
  });
  it("any fail → red, naming the check", () => {
    const r = decideState({ checks: [chk({}), chk({ id: "i1", verdict: "fail", reason: "pair a-b met twice" })], deferred: null, error: null });
    expect(r.state).toBe("red");
    expect(r.reason).toContain("i1");
  });
  it("an error outranks everything; deferred → later with the wave", () => {
    expect(decideState({ checks: [chk({})], deferred: null, error: "boom" }).state).toBe("red");
    expect(decideState({ checks: [], deferred: { wave: "W1b", reason: "multi-stage" }, error: null })).toEqual({ state: "later", reason: "W1b: multi-stage" });
  });
  it("an error outranks a deferral too (a crash is never parked as ⏳)", () => {
    expect(decideState({ checks: [], deferred: { wave: "W1b", reason: "multi-stage" }, error: "boom" })).toEqual({ state: "red", reason: "error: boom" });
  });
});

// PF4: Task 9/11 separate an error-red (product/driver refusal — a finding)
// from a vacuous red by the `error:` prefix. So every error reason carries it,
// and no vacuous reason ever does.
describe("decideState — error reds vs vacuous reds (PF4)", () => {
  it("an error with zero checks is red with the `error:` reason, not vacuous", () => {
    const r = decideState({ checks: [], deferred: null, error: "RefusedCall: /api/v1/divisions/d1/stages → HTTP 400 VALIDATION: bad" });
    expect(r).toEqual({ state: "red", reason: "error: RefusedCall: /api/v1/divisions/d1/stages → HTTP 400 VALIDATION: bad" });
    expect(r.reason).not.toMatch(/vacuous/);
  });
  it("no vacuous or failed-check reason starts with `error:`", () => {
    const vacuous = [
      decideState({ checks: [], deferred: null, error: null }),
      decideState({ checks: [chk({ verdict: "abstain", checked: 0 })], deferred: null, error: null }),
      decideState({ checks: [chk({ checked: 0 })], deferred: null, error: null }),
      decideState({ checks: [chk({ id: "i1", verdict: "fail", reason: "x" })], deferred: null, error: null }),
    ];
    for (const r of vacuous) {
      expect(r.state).toBe("red");
      expect(r.reason.startsWith("error:")).toBe(false);
    }
  });
});

// ⛔ (Task 9, ruling 24): `mandated` turns a green into `refused` and nothing
// else — every red and every deferral keeps its own state and reason.
describe("decideState — mandated refusal (⛔, Task 9)", () => {
  const pass = (id: string, checked = 1): CheckResult => ({ id, kind: "assertion", verdict: "pass", checked, reason: "", evidence: [] });
  it("empty case first: a mandated refusal with no checks is still vacuous red, never ⛔", () => {
    expect(decideState({ checks: [], deferred: null, error: null, mandated: "denied: formats.double_elim" }).state).toBe("red");
  });
  it("all checks pass → refused, carrying the mandate as the reason", () => {
    expect(decideState({ checks: [pass("a")], deferred: null, error: null, mandated: "denied: formats.double_elim" })).toEqual({ state: "refused", reason: "denied: formats.double_elim" });
  });
  it("a failed check beats the mandate: red", () => {
    const failed: CheckResult = { ...pass("b"), verdict: "fail", reason: "stages deleted" };
    expect(decideState({ checks: [pass("a"), failed], deferred: null, error: null, mandated: "x" }).state).toBe("red");
  });
  it("a zero-item applied check beats the mandate: vacuous red", () => {
    expect(decideState({ checks: [pass("a", 0)], deferred: null, error: null, mandated: "x" }).state).toBe("red");
  });
  it("every check abstaining beats the mandate: vacuous red", () => {
    const abstain: CheckResult = { ...pass("a", 0), verdict: "abstain", reason: "n/a" };
    expect(decideState({ checks: [abstain], deferred: null, error: null, mandated: "x" })).toEqual({ state: "red", reason: expect.stringMatching(/vacuous/) });
  });
  it("an abstention beside an applied pass does not block ⛔ (the applied check carries it)", () => {
    const abstain: CheckResult = { ...pass("z", 0), verdict: "abstain", reason: "n/a" };
    expect(decideState({ checks: [pass("a"), abstain], deferred: null, error: null, mandated: "x" }).state).toBe("refused");
  });
  it("an error and a deferral each beat the mandate", () => {
    expect(decideState({ checks: [pass("a")], deferred: null, error: "boom", mandated: "x" })).toEqual({ state: "red", reason: "error: boom" });
    expect(decideState({ checks: [pass("a")], deferred: { wave: "W9", reason: "later" }, error: null, mandated: "x" })).toEqual({ state: "later", reason: "W9: later" });
  });
  it("no mandate: unchanged — works", () => {
    expect(decideState({ checks: [pass("a")], deferred: null, error: null }).state).toBe("works");
    expect(decideState({ checks: [pass("a")], deferred: null, error: null, mandated: null }).state).toBe("works");
  });
});

describe("glyphs and schema", () => {
  it("every state has a distinct glyph", () => {
    expect(new Set(CASE_STATES.map((s) => GLYPH[s])).size).toBe(CASE_STATES.length);
    expect(GLYPH.works).toBe("✅");
    expect(GLYPH.not_run).toBe("░");
  });
  it("parseResults refuses a wrong schemaVersion, an unknown state, and a missing or malformed grid", () => {
    const ok: RunResults = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [] };
    expect(parseResults(ok)).toEqual(ok);
    // T11 review M4: the grid MATRIX.md renders from is part of the file, and a malformed one is refused.
    expect(() => parseResults((({ grid: _g, ...rest }) => rest)(ok))).toThrow();
    expect(() => parseResults({ ...ok, grid: { rows: [], sports: ["generic"] } })).toThrow();
    expect(() => parseResults({ ...ok, grid: { rows: ["league"], sports: [] } })).toThrow();
    expect(() => parseResults({ ...ok, grid: { rows: ["league", "league"], sports: ["generic"] } })).toThrow(/grid rows repeat a key/);
    expect(() => parseResults({ ...ok, grid: { rows: ["league"], sports: ["generic", "generic"] } })).toThrow(/grid sports repeat a key/);
    expect(() => parseResults({ ...ok, grid: { rows: [""], sports: ["generic"] } })).toThrow();
    expect(() => parseResults({ ...ok, grid: { rows: ["league"], sports: ["generic"], extra: 1 } })).toThrow();
    // v1 had no case notes (m-5): its files are refused, not read with notes missing.
    expect(() => parseResults({ ...ok, schemaVersion: 1 })).toThrow();
    expect(() => parseResults({ ...ok, schemaVersion: 3 })).toThrow();
    expect(() => parseResults({ ...ok, cases: [{ state: "green" }] })).toThrow();
  });

  const FULL: CaseResult = {
    caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false,
    state: "works", reason: "2 checks, 5 items",
    checks: [
      { id: "I1", kind: "invariant", verdict: "pass", checked: 3, reason: "every pair meets once", evidence: ["a~b met 1"] },
      { id: "lifecycle-complete", kind: "assertion", verdict: "abstain", checked: 0, reason: "", evidence: ["abstain: no bracket"] },
    ],
    counts: { calls: 12, fixtures: 6, events: 30 }, durationMs: 1234.5,
    notes: ["stage league status after start: active", "complete refused 409 STAGE_INCOMPLETE"],
  };
  const withCase = (c: unknown) => ({ schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [c] });

  it("a fully populated case round-trips unchanged (the schema carries every interface field)", () => {
    expect(parseResults(withCase(FULL))).toEqual(withCase(FULL));
  });
  it("an error-red with zero checks is representable (PF4)", () => {
    const err = { ...FULL, state: "red", reason: "error: RefusedCall: HTTP 400 VALIDATION", checks: [], counts: { calls: 1, fixtures: 0, events: 0 } };
    expect(parseResults(withCase(err)).cases[0]).toEqual(err);
  });
  it.each<[string, unknown]>([
    ["unknown case key", { ...FULL, extra: 1 }],
    ["unknown check key", { ...FULL, checks: [{ ...FULL.checks[0], extra: 1 }] }],
    ["unknown check kind", { ...FULL, checks: [{ ...FULL.checks[0], kind: "probe" }] }],
    ["unknown verdict", { ...FULL, checks: [{ ...FULL.checks[0], verdict: "maybe" }] }],
    ["negative checked", { ...FULL, checks: [{ ...FULL.checks[0], checked: -1 }] }],
    ["fractional checked", { ...FULL, checks: [{ ...FULL.checks[0], checked: 1.5 }] }],
    ["empty check id", { ...FULL, checks: [{ ...FULL.checks[0], id: "" }] }],
    ["empty caseId", { ...FULL, caseId: "" }],
    ["missing counts.events", { ...FULL, counts: { calls: 1, fixtures: 1 } }],
    ["negative durationMs", { ...FULL, durationMs: -1 }],
    ["canary not boolean", { ...FULL, canary: "no" }],
    ["missing notes (m-5)", (({ notes: _n, ...rest }) => rest)(FULL)],
    ["a note that is not a string", { ...FULL, notes: [1] }],
  ])("parseResults refuses %s", (_name, bad) => {
    expect(() => parseResults(withCase(bad))).toThrow();
  });
});

describe("redaction (R14a)", () => {
  it("scrubs tokens, JWTs, device-link secrets, DB URLs, stripe keys", () => {
    const dirty = 'token=abc123def cookie: sb-access=xyz eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl dl_ABCDEFGH12345 postgres://u:p@h/db sk_test_ABCDEFGHIJ';
    const clean = redact(dirty);
    expect(findSecrets(clean)).toEqual([]);
    expect(findSecrets(dirty).length).toBeGreaterThanOrEqual(5);
    expect(redact("plain words stay")).toBe("plain words stay");
    // The count alone survives losing any one pattern (six shapes, floor five):
    // pin every payload. Found by mutation — dropping the JWT or the short
    // dl_ pattern left this test green.
    for (const payload of ["abc123def", "sb-access=xyz", "c2lnbmF0dXJl", "ABCDEFGH12345", "u:p@h", "ABCDEFGHIJ"]) expect(clean).not.toContain(payload);
  });
  it("writeResults refuses to write a secret and writes a clean file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const base: RunResults = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [] };
    const bad = { ...base, runId: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl" };
    expect(() => writeResults(dir, bad)).toThrow(SecretInResults);
    const path = writeResults(dir, base);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(base);
  });
});

// PF6: Task 9 maps every reason and evidence string through redact() before
// writeResults scans each RAW string, so findSecrets must (a) catch every
// credential shape this harness can meet, (b) leave ordinary evidence alone,
// and (c) find nothing in redact()'s own output. Each row is also driven
// through writeResults itself: refused raw, written once redacted (positives);
// written as-is (negatives). A negative needs its positive pair.
const TOKEN43 = "Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFu_Ab-9xYzQwE"; // synthetic; 43 base64url chars, the shape of randomBytes(32)
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEiLCJhdWQiOiJzZWF6biJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

/** [label, text, the secret payload that must not survive redact()] */
const SECRETS: readonly [string, string, string][] = [
  ["session cookie header (opaque value)", "cookie: seazn_session=Zm9vYmFyYmF6cXV4; seazn_org=3f2b8c1e", "Zm9vYmFyYmF6cXV4"],
  ["session cookie pair alone", "sent seazn_session=Zm9vYmFyYmF6cXV4 with the call", "Zm9vYmFyYmF6cXV4"],
  ["session cookie carrying a JWT", `Cookie: seazn_session=${JWT}`, JWT],
  ["set-cookie of a supabase token", "set-cookie: sb-abcd-auth-token=base64-Zm9vYmFyYmF6; Path=/; HttpOnly", "base64-Zm9vYmFyYmF6"],
  ["cookie header whose name is no key word", "Cookie: __Host-auth=Zm9vYmFyYmF6cXV4", "Zm9vYmFyYmF6cXV4"],
  ["chunked supabase cookie pair alone", "sb-abcd-auth-token.0=base64-Zm9vYmFyYmF6", "base64-Zm9vYmFyYmF6"],
  ["supabase cookie pair (brief shape) alone", "sb-access=Zm9vYmFyYmF6cXV4", "Zm9vYmFyYmF6cXV4"],
  ["authorization bearer header", "Authorization: Bearer Zm9vYmFyYmF6cXV4cXV1eA", "Zm9vYmFyYmF6cXV4cXV1eA"],
  ["authorization basic header", "authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
  ["bare bearer token", "retried with Bearer Zm9vYmFyYmF6cXV4cXV1eA after 401", "Zm9vYmFyYmF6cXV4cXV1eA"],
  ["magic-link login_url", `{"login_url":"http://localhost:3000/magic-link?token=${TOKEN43}&next=%2Fo%2Fm-1"}`, TOKEN43],
  ["magic-link consume body", `POST /api/auth/magic-link/consume {"token":"${TOKEN43}"}`, TOKEN43],
  ["access_token query param", `callback?access_token=${TOKEN43}&type=magiclink`, TOKEN43],
  ["refresh_token json field", `{"refresh_token": "${TOKEN43}"}`, TOKEN43],
  ["token_hash param", `/auth/confirm?token_hash=${TOKEN43}&type=email`, TOKEN43],
  ["device-link secret", `Authorization: Bearer dl_${TOKEN43}`, TOKEN43],
  ["device-link secret glued to a word", `x_dl_${TOKEN43}`, TOKEN43],
  ["device-link secret, short or truncated", "scoring with dl_ABCDEFGH12345", "ABCDEFGH12345"],
  ["device-link score URL", `http://localhost:3000/score/dl_${TOKEN43}`, TOKEN43],
  ["postgres URL", "could not connect to postgres://bench:hunter22@localhost:55432/seazn_fm", "hunter22"],
  ["postgres URL with no credentials", "could not connect to postgres://localhost:55432/seazn_fm", "localhost:55432/seazn_fm"],
  ["postgresql URL", "postgresql://bench:hunter22@localhost/seazn_fm?sslmode=disable", "hunter22"],
  ["DATABASE_URL assignment", "DATABASE_URL=postgres://bench:hunter22@localhost:55432/seazn_fm", "hunter22"],
  ["DATABASE_URL non-postgres value", 'DATABASE_URL="mysql://bench:hunter22@db.internal/app"', "hunter22"],
  ["DATABASE_URL with no password in it", "DATABASE_URL=mysql://db.internal:3306/app", "db.internal:3306/app"],
  ["URL with password userinfo", "fetch https://svc:hunter22@api.example.test/v1 failed", "hunter22"],
  ["PGPASSWORD", "PGPASSWORD=hunter22 psql -h localhost", "hunter22"],
  ["JWT alone", `jwt ${JWT} expired`, JWT],
  ["stripe secret key", "sk_live_51HxYzAbCdEfGhIjKl", "51HxYzAbCdEfGhIjKl"],
  // Review I1: a secret at the start of a line or after a tab. JSON escaping
  // turns the newline into `\n`, erasing the \b these patterns anchor on.
  ["JWT at the start of a line", `line1\n${JWT}`, JWT],
  ["stripe key after a tab", "a\tsk_live_51HxYzAbCdEfGhIjKl", "51HxYzAbCdEfGhIjKl"],
  ["short dl_ secret after a newline", "x\ndl_ABCDEFGH12345", "ABCDEFGH12345"],
  ["postgres URL at the start of a line", "connect failed:\npostgres://localhost:55432/seazn_fm", "localhost:55432/seazn_fm"],
  // Review M3: a quoted value is redacted whole, spaces included.
  ["single-quoted password with a space", "password: 'hunter 22'", " 22"],
  ["double-quoted password with a space", '{"password": "hunter 22"}', " 22"],
  // Parked Task 4: an UNCLOSED quote (a truncated message) must not leave the tail.
  ["unclosed single-quoted password with a space", "password: 'hunter 22", " 22"],
  ["unclosed double-quoted password with a space", 'password: "hunter 22', " 22"],
  ["unclosed quoted password, text after it on the line", "refused: password: 'hunter 22 at login", " 22"],
  // Review M4's positive pairs: the word test must not cost these.
  ["plain-word password", "PGPASSWORD=hunter", "hunter"],
  ["short numeric token", "token=123456", "123456"],
  ["long all-letter api key", "api_key=abcdefghijklmnopqrstuvwxyz", "abcdefghijklmnopqrstuvwxyz"],
];

/** Ordinary evidence the harness writes on every run (PF6). */
const EVIDENCE: readonly [string, string][] = [
  ["uuid", "fixture 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b: completed/home"],
  ["org slug", "m-fm-w1a-a-3"],
  ["org name", "Matrix fm-w1a-a 3"],
  ["synthetic email", "delivered+matrix-fm-w1a-a@resend.dev"],
  ["synthetic person", "Matrix Player 7"],
  ["seq numbers", "HTTP 409 SEQ_CONFLICT: expected_seq 3, current_seq 4"],
  ["idempotency key", "idempotency_key: fm-w1a-a-3:0:retry"],
  ["harness commit", "888e054a5c3b2f1d0e9a8b7c6d5e4f3a2b1c0d9e"],
  ["case id", "league|generic|score|LIFECYCLE"],
  ["invariant evidence", "a~d met 0, expected 1; stage 2: generate refused 400 with no code"],
  ["api path", "http://localhost:3000/api/v1/divisions/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b/stages → HTTP 400 VALIDATION: stage kind"],
  ["localhost with port", "SMOKE_BASE http://localhost:3123 answered 200"],
  ["notes", "stage league status after start: in_progress; config knockout: 400 FORMAT_LOCKED; loop cap 64 reached"],
  ["variant names", "doubles-noad-mtb10 bwf score"],
  // Review M4: an ordinary word under a key whose real values are minted.
  ["authorization: none", "request sent with authorization: none"],
  ["token_count", "token_count=abc"],
  ["cookie consent", "cookie_consent=granted; cookie_consent=accepted"],
  ["quoted consent flag", '{"cookie_consent": "granted"}'],
  ["single-quoted authorization word", "authorization: 'none'"],
  // …and the unclosed form keeps the word test: a truncated `'none` is still a word.
  ["unclosed single-quoted authorization word", "authorization: 'none"],
  ["unclosed double-quoted consent flag", 'cookie_consent: "granted'],
];

const base: RunResults = { schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "x", finishedAt: "y", grid: { rows: ["league"], sports: ["generic"] }, cases: [] };
const withEvidence = (evidence: string[]): RunResults => ({
  ...base,
  cases: [{
    caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false,
    state: "works", reason: "1 checks, 1 items", checks: [{ id: "I1", kind: "invariant", verdict: "pass", checked: 1, reason: "", evidence }],
    counts: { calls: 1, fixtures: 1, events: 1 }, durationMs: 1, notes: [],
  }],
});
/** writeResults into a fresh dir: the thrown value (or null) and whether a file landed. */
const tryWrite = (r: RunResults): { error: unknown; wrote: boolean } => {
  const dir = mkdtempSync(join(tmpdir(), "fm-"));
  try { writeResults(dir, r); return { error: null, wrote: existsSync(join(dir, "results.json")) }; }
  catch (e) { return { error: e, wrote: existsSync(join(dir, "results.json")) }; }
};

describe("findSecrets / redact — positives (PF6)", () => {
  it("discovery guard: the tables are not empty", () => {
    expect(SECRETS.length).toBeGreaterThan(0);
    expect(EVIDENCE.length).toBeGreaterThan(0);
  });
  it.each(SECRETS)("%s is found, and redact() removes its payload", (_label, text, payload) => {
    expect(text).toContain(payload);
    expect(findSecrets(text).length).toBeGreaterThan(0);
    const clean = redact(text);
    expect(clean).not.toContain(payload);
    expect(clean).toContain("[redacted]");
  });
  it.each(SECRETS)("%s: redact() is a fixpoint", (_label, text) => {
    const clean = redact(text);
    expect(findSecrets(clean)).toEqual([]);
    expect(redact(clean)).toBe(clean);
  });
  it.each(SECRETS)("%s: writeResults refuses it raw (writing nothing) and writes it redacted", (_label, text) => {
    const raw = tryWrite(withEvidence([text]));
    expect(raw.error).toBeInstanceOf(SecretInResults);
    expect(raw.wrote).toBe(false);
    expect(tryWrite(withEvidence([redact(text)]))).toEqual({ error: null, wrote: true });
  });
});

describe("findSecrets / redact — negatives (PF6)", () => {
  it.each(EVIDENCE)("%s is not a secret, survives redact() unchanged, and writes", (_label, text) => {
    expect(findSecrets(text)).toEqual([]);
    expect(redact(text)).toBe(text);
    expect(tryWrite(withEvidence([text]))).toEqual({ error: null, wrote: true });
  });
  it("text that only LOOKS secret once JSON-escaped is written (the scan reads raw strings)", () => {
    // Raw, `token=ab` is under the 3-char floor and the URL's userinfo is cut
    // by a newline. Serialised, `\n` is `\` + `n` and would stretch both into
    // matches, so a body scan would throw the run away.
    for (const text of ["token=ab\ncd", "https://u:pa\nss@h/x"]) {
      expect(findSecrets(text)).toEqual([]);
      expect(tryWrite(withEvidence([text]))).toEqual({ error: null, wrote: true });
    }
  });
});

describe("findSecrets / redact — cost", () => {
  it("long repetitive input stays cheap (unanchored or unbounded runs took 1–23 s here)", () => {
    const inputs = [
      "token_".repeat(700), "x".repeat(20_000), "m-fm-w1a-a-".repeat(2_000), `sb-${"a-".repeat(2_000)}!`,
      // Review M1: an uncapped key suffix and an unanchored JWT start.
      "token.".repeat(10_000), "sb-a.".repeat(5_000), "eyJ-".repeat(10_000),
    ];
    const t0 = performance.now();
    for (const s of inputs) { findSecrets(s); redact(s); }
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe("writeResults", () => {
  it("review I1: a secret after a newline or tab is refused, though JSON-escaping hides it from a body scan", () => {
    for (const secret of [`line1\n${JWT}`, "a\tsk_live_51HxYzAbCdEfGhIjKl", "x\ndl_ABCDEFGH12345"]) {
      const r = tryWrite(withEvidence([secret]));
      expect(r.error, secret).toBeInstanceOf(SecretInResults);
      expect(r.wrote).toBe(false);
    }
  });
  it("refuses a secret nested in check evidence, writes NOTHING, and does not echo the secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const e = (() => { try { writeResults(dir, withEvidence([`cookie: seazn_session=${TOKEN43}`])); } catch (x) { return x; } return null; })();
    expect(e).toBeInstanceOf(SecretInResults);
    expect((e as Error).message).not.toContain(TOKEN43);
    expect(existsSync(join(dir, "results.json"))).toBe(false);
  });
  it("writes evidence that went through redact() (the Task 9 path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const clean = withEvidence([redact(`cookie: seazn_session=${TOKEN43}`), "Matrix Player 3", "delivered+matrix-r@resend.dev"]);
    expect(JSON.parse(readFileSync(writeResults(dir, clean), "utf8"))).toEqual(clean);
  });
  it("refuses results the schema refuses, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    expect(() => writeResults(dir, { ...base, schemaVersion: 1 } as unknown as RunResults)).toThrow();
    expect(existsSync(join(dir, "results.json"))).toBe(false);
  });
});

// T15 fix round 3, M-7: a run drives a server on this machine, and its address
// is noise in a public repo. Every committed writer emits LOCAL_BASE in its
// place; the secret semantics (findSecrets, redact) do not move.
describe("local base (T15 fix round 3, M-7)", () => {
  it("empty case first: text with no loopback origin is unchanged — lookalikes included", () => {
    let checked = 0;
    for (const text of ["", "Matrix Player 3", "delivered+matrix-r@resend.dev", "POST /api/v1/fixtures/f1/events → HTTP 409", "localhostname", "mylocalhost", "127.0.0.10", "https://seazn.club/c/x", "[local-base]"]) {
      expect(findLocalBases(text), text).toEqual([]);
      expect(scrubLocalBase(text), text).toBe(text);
      checked++;
    }
    expect(checked).toBe(9);
  });
  it("every loopback origin — scheme and port optional, either spelling — becomes LOCAL_BASE, the path kept", () => {
    const cases: [string, string][] = [
      ["http://localhost:3313", LOCAL_BASE],
      ["https://127.0.0.1:8080/api/v1/x", `${LOCAL_BASE}/api/v1/x`],
      ["localhost:5433", LOCAL_BASE],
      ["LOCALHOST", LOCAL_BASE],
      ["GET http://localhost:3999/a then http://127.0.0.1:4000/b", `GET ${LOCAL_BASE}/a then ${LOCAL_BASE}/b`],
      ['{"base": "http://localhost:3313"}', `{"base": "${LOCAL_BASE}"}`],
    ];
    let checked = 0;
    for (const [dirty, clean] of cases) {
      expect(findLocalBases(dirty).length, dirty).toBeGreaterThan(0);
      expect(scrubLocalBase(dirty), dirty).toBe(clean);
      expect(findLocalBases(scrubLocalBase(dirty)), `${dirty}: a fixpoint`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
  it("the secret semantics do not move: a loopback origin is no secret, redact leaves it, and the placeholder is none either", () => {
    expect(findSecrets("http://localhost:3313/api")).toEqual([]);
    expect(redact("http://localhost:3313/api")).toBe("http://localhost:3313/api");
    expect(findSecrets(LOCAL_BASE)).toEqual([]);
    expect(findLocalBases(LOCAL_BASE)).toEqual([]);
  });
  it("writeResults writes LOCAL_BASE for a loopback origin in any string, and nothing else changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const r = withEvidence(["GET http://localhost:3313/api/v1/x → 500", "Matrix Player 3"]);
    const text = readFileSync(writeResults(dir, r), "utf8");
    expect(findLocalBases(text)).toEqual([]);
    expect(JSON.parse(text)).toEqual(withEvidence([`GET ${LOCAL_BASE}/api/v1/x → 500`, "Matrix Player 3"]));
  });
  it("…and a secret on a loopback origin is still REFUSED, never laundered by the scrub", () => {
    const r = tryWrite(withEvidence(["row from postgres://bench:hunter22@localhost:5433/seazn"]));
    expect(r.error).toBeInstanceOf(SecretInResults);
    expect(r.wrote).toBe(false);
  });
});
