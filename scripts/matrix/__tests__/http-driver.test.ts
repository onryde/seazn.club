import { describe, expect, it } from "vitest";
import type { RawResult, Session } from "../../bench/lib/http.ts";
import { HttpDriver, type Transport } from "../lib/driver/http-driver.ts";
import { DriverMisuse, OrgMismatch, RefusedCall, VisibilityDegraded } from "../lib/driver/types.ts";
import { START } from "../lib/streams/types.ts";

interface Call { path: string; method: string; body: unknown; cookies: number }
function fake(replies: ((c: Call) => RawResult | undefined)[]): { t: Transport; calls: Call[] } {
  const calls: Call[] = [];
  const t: Transport = {
    async raw(_b: string, s: Session, path: string, method = "GET", body?: unknown) {
      const c = { path, method, body, cookies: Object.keys(s.cookies).length };
      calls.push(c);
      for (const r of replies) { const out = r(c); if (out) return out; }
      throw new Error(`fake: no reply for ${method} ${path}`);
    },
  };
  return { t, calls };
}
const ok = (data: unknown, status = 200): RawResult => ({ status, json: { ok: true, data } as never });
const err = (status: number, code: string, extra: Record<string, unknown> = {}): RawResult => ({ status, json: { ok: false, error: { code, message: `${code} token=abc123secret`, ...extra } } as never });
const session: Session = { cookies: { sid: "x" } };
const drv = (t: Transport) => new HttpDriver({ base: "http://localhost:3999", session, expectedOrgId: "org-1", transport: t });
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

// POST /competitions answers the row plus, on a degrade, a NOTE OBJECT
// (apps/web/src/server/usecases/competitions.ts createCompetition,
// api-v1/schemas.ts PublicQuotaDegraded) — never a bare `true`. The row's own
// `visibility` is the applied one.
const created = (over: Record<string, unknown> = {}) => ({ id: "c1", slug: "m-1", org_id: "org-1", visibility: "unlisted", ...over });

describe("HttpDriver — org pinning (Review Focus 4)", () => {
  it("createCompetition sends unlisted + ends_on and refuses a competition in another org", async () => {
    const { t, calls } = fake([(c) => (c.path === "/api/v1/competitions" ? ok(created({ org_id: "org-2" }), 201) : undefined)]);
    await expect(drv(t).createCompetition({ name: "M", slug: "m-1" })).rejects.toBeInstanceOf(OrgMismatch);
    expect(calls[0]!.body).toMatchObject({ visibility: "unlisted", ends_on: "2030-12-31", slug: "m-1" });
  });
  it("a silently degraded visibility is an error, not a later public-read 404 (the product's real note shape)", async () => {
    const note = { feature_key: "dashboard.public.max", requested_visibility: "unlisted", applied_visibility: "private", limit: 2, reason: "Free includes 2 public dashboards." };
    const { t } = fake([() => ok(created({ visibility: "private", public_quota_degraded: note }), 201)]);
    await expect(drv(t).createCompetition({ name: "M", slug: "m-1" })).rejects.toBeInstanceOf(VisibilityDegraded);
  });
  it("the row's applied visibility is the authority: private with no note is still degraded", async () => {
    const { t } = fake([() => ok(created({ visibility: "private" }), 201)]);
    await expect(drv(t).createCompetition({ name: "M", slug: "m-1" })).rejects.toBeInstanceOf(VisibilityDegraded);
  });
  it("the happy path returns the ref", async () => {
    const { t } = fake([() => ok(created(), 201)]);
    expect(await drv(t).createCompetition({ name: "M", slug: "m-1" })).toEqual({ id: "c1", slug: "m-1", orgId: "org-1" });
  });
});

describe("HttpDriver — postStream (Review Focus 5)", () => {
  it("empty stream posts nothing and reads nothing", async () => {
    const { t, calls } = fake([]);
    expect(await drv(t).postStream("f1", [], "k")).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("reads last_seq first (a server cascade left it at 2) and chains the returned seq", async () => {
    let seq = 2;
    const { t, calls } = fake([
      (c) => (c.path === "/api/v1/fixtures/f1/state" ? ok({ status: "in_play", last_seq: 2, outcome: null }) : undefined),
      (c) => (c.path === "/api/v1/fixtures/f1/events" ? ok({ seq: ++seq, status: "in_play", outcome: null, event_id: `e${seq}` }, 201) : undefined),
    ]);
    const out = await drv(t).postStream("f1", [START, { type: "generic.result", payload: { p1Score: 1, p2Score: 0 } }], "run:f1");
    expect(out.map((e) => e.seq)).toEqual([3, 4]);
    const bodies = posts(calls).map((c) => c.body as { expected_seq: number; idempotency_key: string });
    expect(bodies.map((p) => p.expected_seq)).toEqual([2, 3]);
    // m-2: keyed on the expected seq, so the key names this (fixture, event) — not the index in this call.
    expect(bodies.map((p) => p.idempotency_key)).toEqual(["run:f1:s2", "run:f1:s3"]);
    expect(out.every((e) => e.retried === undefined)).toBe(true);
  });
  it("retries a SEQ_CONFLICT exactly once from current_seq with a fresh key", async () => {
    let n = 0;
    const { t, calls } = fake([
      (c) => (c.path.endsWith("/state") ? ok({ status: "scheduled", last_seq: 0, outcome: null }) : undefined),
      () => (n++ === 0 ? err(409, "SEQ_CONFLICT", { current_seq: 1 }) : ok({ seq: 2, status: "in_play", outcome: null, event_id: "e2" }, 201)),
    ]);
    const out = await drv(t).postStream("f1", [START], "k");
    expect(out[0]!.seq).toBe(2);
    const bodies = posts(calls).map((c) => c.body as { expected_seq: number; idempotency_key: string });
    expect(bodies).toEqual([expect.objectContaining({ expected_seq: 0, idempotency_key: "k:s0" }), expect.objectContaining({ expected_seq: 1, idempotency_key: "k:s0:retry" })]);
    expect(out[0]!.retried).toBe(true); // parked Task 6 (b): the retry is visible to a parity trace
  });
  it("m-2: a second call to the same fixture under the same prefix sends NEW keys (the product would replay a repeated one)", async () => {
    let seq = 0;
    const { t, calls } = fake([
      (c) => (c.path.endsWith("/state") ? ok({ status: seq === 0 ? "scheduled" : "in_play", last_seq: seq, outcome: null }) : undefined),
      () => ok({ seq: ++seq, status: "in_play", outcome: null, event_id: `e${seq}` }, 201),
    ]);
    const d = drv(t);
    await d.postStream("f1", [START], "run-1:f1");
    await d.forfeit("f1", "ent-b", "retired hurt", "run-1:f1");
    const keys = posts(calls).map((c) => (c.body as { idempotency_key: string }).idempotency_key);
    expect(keys).toEqual(["run-1:f1:s0", "run-1:f1:s1"]);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("a SEQ_CONFLICT that carries no current_seq re-reads /state for the retry", async () => {
    const tips = [0, 5];
    let n = 0;
    const { t, calls } = fake([
      (c) => (c.path.endsWith("/state") ? ok({ status: "in_play", last_seq: tips.shift(), outcome: null }) : undefined),
      () => (n++ === 0 ? err(409, "SEQ_CONFLICT") : ok({ seq: 6, status: "in_play", outcome: null, event_id: "e6" }, 201)),
    ]);
    expect((await drv(t).postStream("f1", [START], "k"))[0]!.seq).toBe(6);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/fixtures/f1/state", "POST /api/v1/fixtures/f1/events", "GET /api/v1/fixtures/f1/state", "POST /api/v1/fixtures/f1/events",
    ]);
    expect(posts(calls).map((c) => (c.body as { expected_seq: number }).expected_seq)).toEqual([0, 5]);
  });
  it("a second conflict surfaces as RefusedCall with its code, redacted — after exactly ONE retry", async () => {
    const { t, calls } = fake([(c) => (c.path.endsWith("/state") ? ok({ status: "scheduled", last_seq: 0, outcome: null }) : undefined), () => err(409, "SEQ_CONFLICT", { current_seq: 1 })]);
    const e = await drv(t).postStream("f1", [START], "k").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RefusedCall);
    expect((e as RefusedCall).code).toBe("SEQ_CONFLICT");
    expect((e as RefusedCall).message).not.toContain("abc123secret");
    expect(posts(calls)).toHaveLength(2);
  });
  it("a 409 with any other code is refused at once, never retried", async () => {
    const { t, calls } = fake([(c) => (c.path.endsWith("/state") ? ok({ status: "in_play", last_seq: 3, outcome: null }) : undefined), () => err(409, "UNDO_TARGET_MISSING")]);
    const e = await drv(t).postStream("f1", [START], "k").catch((x: unknown) => x);
    expect([(e as RefusedCall).status, (e as RefusedCall).code]).toEqual([409, "UNDO_TARGET_MISSING"]);
    expect(posts(calls)).toHaveLength(1);
  });
  it("forfeit on a scheduled fixture posts exactly the composed [core.start, core.forfeit]", async () => {
    let seq = 0;
    const { t, calls } = fake([
      (c) => (c.path.endsWith("/state") ? ok({ status: "scheduled", last_seq: 0, outcome: null }) : undefined),
      () => ok({ seq: ++seq, status: seq === 2 ? "forfeited" : "in_play", outcome: null, event_id: `e${seq}` }, 201),
    ]);
    await drv(t).forfeit("f1", "ent-b", "walkover", "k");
    const types = posts(calls).map((c) => c.body as { type: string; payload: unknown });
    expect(types).toEqual([
      expect.objectContaining({ type: "core.start", payload: {} }),
      expect.objectContaining({ type: "core.forfeit", payload: { by: "ent-b", reason: "walkover" } }),
    ]);
  });
  it("forfeit on a live fixture posts only core.forfeit (no second start)", async () => {
    const { t, calls } = fake([
      (c) => (c.path.endsWith("/state") ? ok({ status: "in_play", last_seq: 4, outcome: null }) : undefined),
      () => ok({ seq: 5, status: "forfeited", outcome: null, event_id: "e5" }, 201),
    ]);
    await drv(t).forfeit("f1", "ent-a", "retired hurt", "k");
    expect(posts(calls).map((c) => c.body)).toEqual([{ expected_seq: 4, type: "core.forfeit", payload: { by: "ent-a", reason: "retired hurt" }, idempotency_key: "k:s4" }]);
  });
});

describe("HttpDriver — completeStage is never repeated after completion (design §6.4)", () => {
  it("completed:false may be retried; after completed:true a second call is DriverMisuse with no HTTP", async () => {
    let done = false;
    const { t, calls } = fake([() => { const r = ok({ completed: done, events: done ? [{ type: "stage_completed", finalRanks: ["a"] }] : [] }); done = true; return r; }]);
    const d = drv(t);
    expect((await d.completeStage("s1")).completed).toBe(false);
    expect((await d.completeStage("s1")).completed).toBe(true);
    await expect(d.completeStage("s1")).rejects.toBeInstanceOf(DriverMisuse);
    expect(calls.length).toBe(2);
  });
  it("parked Task 6 (a): after a 5xx or no answer the outcome is unknown (it may have committed), so a repeat is DriverMisuse with no HTTP", async () => {
    for (const fail of [() => err(500, "INTERNAL"), () => err(503, "UNAVAILABLE"), () => { throw new Error("socket hang up"); }]) {
      const { t, calls } = fake([fail]);
      const d = drv(t);
      await expect(d.completeStage("s1")).rejects.toThrow();
      await expect(d.completeStage("s1")).rejects.toBeInstanceOf(DriverMisuse);
      expect(calls.length).toBe(1);
    }
  });
  it("parked Task 6 (a): a named 4xx refusal committed nothing and stays retryable", async () => {
    let n = 0;
    const { t, calls } = fake([() => (n++ === 0 ? err(409, "STAGE_INCOMPLETE") : ok({ completed: true, events: [] }))]);
    const d = drv(t);
    await expect(d.completeStage("s1")).rejects.toBeInstanceOf(RefusedCall);
    expect((await d.completeStage("s1")).completed).toBe(true);
    expect(calls.length).toBe(2);
  });
  it("the guard is per stage: completing s1 does not block s2", async () => {
    const { t, calls } = fake([() => ok({ completed: true, events: [] })]);
    const d = drv(t);
    await d.completeStage("s1");
    await d.completeStage("s2");
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/stages/s1/complete", "/api/v1/stages/s2/complete"]);
  });
});

describe("HttpDriver — reads and probes", () => {
  const ref = { orgSlug: "o", competitionSlug: "c", divisionSlug: "d" };
  it("public standings go out with NO cookies (anonymous) and the public path", async () => {
    const { t, calls } = fake([() => ok({ division_id: "d1", standings: [] })]);
    await drv(t).publicStandings(ref);
    expect(calls[0]).toMatchObject({ path: "/api/v1/public/orgs/o/competitions/c/divisions/d/standings", cookies: 0 });
  });
  it("each public read is a fresh anonymous session: a cookie the first read was handed is not sent on the second", async () => {
    const seen: number[] = [];
    const t: Transport = { async raw(_b, s) { seen.push(Object.keys(s.cookies).length); s.cookies.pub = "1"; return ok({ division_id: "d1", standings: [] }); } };
    const d = drv(t);
    await d.publicStandings(ref);
    await d.publicStandings(ref);
    expect(seen).toEqual([0, 0]);
  });
  it("patchDivisionConfig returns a refusal instead of throwing", async () => {
    const { t } = fake([() => err(409, "FORMAT_LOCKED")]);
    expect(await drv(t).patchDivisionConfig("d1", { setTo: 15 })).toEqual({ status: 409, code: "FORMAT_LOCKED" });
  });
  it("patchDivisionConfig PATCHes {config} and reports an accepted save as {200, null}", async () => {
    const { t, calls } = fake([() => ok({ id: "d1", config: { entrants: { kinds: ["individual"] } } })]);
    expect(await drv(t).patchDivisionConfig("d1", { entrants: { kinds: ["individual"] } })).toEqual({ status: 200, code: null });
    expect(calls).toEqual([{ path: "/api/v1/divisions/d1", method: "PATCH", body: { config: { entrants: { kinds: ["individual"] } } }, cookies: 1 }]);
  });
  it("start always acknowledges warnings; standings pass pool_id only when set", async () => {
    const { t, calls } = fake([
      (c) => (c.path.includes("/start") ? ok({ division_id: "d1", status: "active", started: true, generated: 6 }) : undefined),
      () => ok({ stage_id: "s1", pool_id: null, rows: [] }),
    ]);
    const d = drv(t);
    await d.start("d1");
    await d.standings("s1", null);
    await d.standings("s1", "p1");
    expect(calls[0]!.body).toEqual({ acknowledge_warnings: true });
    expect(calls.slice(1).map((c) => c.path)).toEqual(["/api/v1/stages/s1/standings", "/api/v1/stages/s1/standings?pool_id=p1"]);
  });
  it("any other non-2xx is RefusedCall carrying status, code, method and path", async () => {
    const { t } = fake([() => err(422, "STAGE_NOT_READY")]);
    const e = (await drv(t).generate("s1").catch((x: unknown) => x)) as RefusedCall;
    expect([e.status, e.code, e.method, e.path]).toEqual([422, "STAGE_NOT_READY", "POST", "/api/v1/stages/s1/generate"]);
  });
  it("a non-JSON answer (bench raw() reports it as a string error) is a RefusedCall with no code that still says why", async () => {
    const { t } = fake([() => ({ status: 502, json: { ok: false, error: "no json" } })]);
    const e = (await drv(t).listFixtures("d1").catch((x: unknown) => x)) as RefusedCall;
    expect([e.status, e.code]).toEqual([502, null]);
    expect(e.message).toContain("no json");
  });
  it("a 2xx that carries no data is a RefusedCall, never a silent undefined", async () => {
    const { t } = fake([() => ({ status: 200, json: { ok: true } as never })]);
    const e = (await drv(t).listStages("d1").catch((x: unknown) => x)) as RefusedCall;
    expect(e).toBeInstanceOf(RefusedCall);
    expect([e.status, e.code, e.method]).toEqual([200, "NO_DATA", "GET"]);
  });
  it("createDivision and addEntrants send the api-v1 snake_case bodies and map the rows back", async () => {
    const { t, calls } = fake([
      (c) => (c.path.endsWith("/divisions") ? ok({ id: "d1", slug: "m", sport_key: "generic", variant_key: "score", config: null }, 201) : undefined),
      () => ok([{ id: "e1", display_name: "Matrix Player 1", seed: 1, status: "registered" }], 201),
    ]);
    const d = drv(t);
    expect(await d.createDivision("c1", { name: "M", slug: "m", sportKey: "generic", variantKey: "score" }))
      .toEqual({ id: "d1", slug: "m", sportKey: "generic", variantKey: "score", config: {} });
    await d.addEntrants("d1", [{ displayName: "Matrix Player 1", seed: 1, kind: "individual" }]);
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/v1/competitions/c1/divisions", { name: "M", slug: "m", sport_key: "generic", variant_key: "score", config: {} }],
      ["POST", "/api/v1/divisions/d1/entrants", [{ kind: "individual", display_name: "Matrix Player 1", seed: 1 }]],
    ]);
  });
  it("listEntrants GETs the division's stored entrants (the I-2 read-back, not the add answer)", async () => {
    const rows = [{ id: "e1", display_name: "Matrix Player 1", seed: 1, status: "active" }];
    const { t, calls } = fake([(c) => (c.method === "GET" && c.path === "/api/v1/divisions/d1/entrants" ? ok(rows) : undefined)]);
    expect(await drv(t).listEntrants("d1")).toEqual(rows);
    expect(calls).toEqual([{ path: "/api/v1/divisions/d1/entrants", method: "GET", body: undefined, cookies: 1 }]);
  });
  it("counts every HTTP call", async () => {
    const { t } = fake([() => ok({ created: 0, existing: 1, fixtures: [] })]);
    const d = drv(t);
    await d.generate("s1");
    await d.generate("s1");
    expect(d.callCount).toBe(2);
  });
});

// ⛔ (Task 9): a 402 is named only by its feature_key — api-v1/http.ts's
// PaymentRequiredError branch answers the generic PAYMENT_REQUIRED code, so the
// key is the one field that says WHICH gate refused.
describe("HttpDriver — denied stages (Task 9)", () => {
  const body = [{ seq: 1, kind: "double_elim", config: {}, progression: null }] as never;
  it("postStages on a 402 throws a RefusedCall carrying feature_key", async () => {
    const { t } = fake([(c) => (c.method === "POST" ? err(402, "PAYMENT_REQUIRED", { feature_key: "formats.double_elim" }) : undefined)]);
    const e = await drv(t).postStages("d1", body).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RefusedCall);
    expect((e as RefusedCall).status).toBe(402);
    expect((e as RefusedCall).code).toBe("PAYMENT_REQUIRED");
    expect((e as RefusedCall).featureKey).toBe("formats.double_elim");
  });
  it("a refusal without feature_key carries null (empty case)", async () => {
    const { t } = fake([() => err(422, "INVALID_STAGE")]);
    const e = await drv(t).postStages("d1", body).catch((x: unknown) => x);
    expect((e as RefusedCall).featureKey).toBeNull();
  });
  it("a RefusedCall built with the five original arguments carries a null featureKey", () => {
    expect(new RefusedCall("GET", "/x", 400, "X", "m").featureKey).toBeNull();
  });
  it("replaceStagesProbe PUTs the body and returns the refusal without throwing", async () => {
    const { t, calls } = fake([(c) => (c.method === "PUT" ? err(402, "PAYMENT_REQUIRED", { feature_key: "formats.advanced" }) : undefined)]);
    expect(await drv(t).replaceStagesProbe("d1", body)).toEqual({ status: 402, code: "PAYMENT_REQUIRED", featureKey: "formats.advanced" });
    expect(calls).toMatchObject([{ path: "/api/v1/divisions/d1/stages", method: "PUT", body }]);
  });
  it("replaceStagesProbe on 2xx returns status with null code and key", async () => {
    const { t } = fake([() => ok([{ id: "s1" }])]);
    expect(await drv(t).replaceStagesProbe("d1", body)).toEqual({ status: 200, code: null, featureKey: null });
  });
  it("replaceStagesProbe reports a 5xx or a keyless 4xx as it came, and counts each call", async () => {
    const { t } = fake([(c) => (c.method === "PUT" && c.path.includes("/d1/") ? err(500, "INTERNAL") : undefined), () => err(409, "FORMAT_LOCKED")]);
    const d = drv(t);
    expect(await d.replaceStagesProbe("d1", body)).toEqual({ status: 500, code: "INTERNAL", featureKey: null });
    expect(await d.replaceStagesProbe("d2", body)).toEqual({ status: 409, code: "FORMAT_LOCKED", featureKey: null });
    expect(d.callCount).toBe(2);
  });
});

describe("driver errors are redacted (R14a — public repo)", () => {
  it("every driver error redacts its message, and RefusedCall its path", () => {
    const secret = "token=abc123secret";
    const errors: Error[] = [
      new RefusedCall("GET", `/api/v1/x?${secret}`, 400, "X", secret),
      new OrgMismatch("org-1", secret),
      new VisibilityDegraded(secret),
      new DriverMisuse(secret),
    ];
    for (const e of errors) expect(e.message, e.name).not.toContain("abc123secret");
    expect((errors[0] as RefusedCall).path).not.toContain("abc123secret");
  });
});
