// Scorer sheets §4.4 — the print route's OWN duties: the auth scope it asks
// for, the body, the limiter, the headers and the v1 envelope. What it prints
// is the use-case's (scorer-sheet-build.test.ts, against the DB) and the
// renderer's (scorer-sheet-pdf.test.ts); both are mocked here. The cross-origin
// refusal is proxy.ts's (src/__tests__/proxy-csrf.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/errors";
import { __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { baseUrl } from "@/lib/oauth";
import type { Locale } from "@/lib/i18n-constants";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import type { ScorerSheet } from "@/server/usecases/scorer-sheets";

const PDF = Buffer.from("%PDF-1.3 scorer sheets");
// One real-shaped card, so a capture that leaked the model (its QR URL IS the
// scoring credential) would be caught by the no-token assertion below.
const TOKEN = "dl_Q2hvb3NlIGEgcmVhbGx5IGxvbmcgcmFuZG9tIHRva2Vu_Ab-9";
const MODEL = {
  header: {},
  pages: [{ heading: {}, rows: [{ fixtureId: "f1", url: `https://print.example/score/${TOKEN}` }] }],
  labels: {},
  summary: { fixtureCount: 7, courtCount: 2, courtlessCount: 1 },
} as unknown as ScorerSheet;

const h = vi.hoisted(() => ({
  auth: vi.fn<(req: Request, kind: string, id: string, scope: string) => Promise<unknown>>(),
  build: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  render: vi.fn<(model: unknown) => Promise<Buffer>>(),
  locale: vi.fn<() => Promise<Locale>>(),
  capture: vi.fn<(args: unknown) => Promise<void>>(),
}));
vi.mock("@/server/api-v1/auth", async (orig) => ({ ...(await orig<object>()), requireResourceAuth: h.auth }));
vi.mock("@/server/usecases/scorer-sheets", () => ({ buildScorerSheet: h.build }));
vi.mock("@/server/scorer-sheet-pdf", () => ({ renderScorerSheetPdf: h.render }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: h.locale }));
vi.mock("@/lib/posthog-server", () => ({ captureServer: h.capture }));

import { POST } from "../route";

const AUTH = { orgId: "o1", userId: "u1", via: "session", role: "owner", keyId: null } as AuthCtx;
const ctx = { params: Promise.resolve({ id: "c1" }) };
const URL_ = "http://localhost:3000/api/v1/competitions/c1/exports/scorer-sheets";
// Behind Fly, req.url is the internal binding; the QR must carry the PUBLIC
// origin (baseUrl). The forwarded host makes the two differ in every env.
const req = (body: unknown) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-host": "print.example", "x-forwarded-proto": "https" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let limiterKeys: [string, number][] = [];
const counter = (n: number) => async (key: string, windowSeconds: number) => {
  limiterKeys.push([key, windowSeconds]);
  return { count: n, ttlMs: windowSeconds * 1000 };
};

beforeEach(() => {
  // mockReset, not mockClear: an unconsumed mockRejectedValueOnce must not
  // leak into the next test and turn one mutant into two kills.
  vi.resetAllMocks();
  limiterKeys = [];
  __setRateLimitCounterForTests(counter(1));
  h.auth.mockResolvedValue(AUTH);
  h.build.mockResolvedValue(MODEL);
  h.render.mockResolvedValue(PDF);
  h.locale.mockResolvedValue("fr");
  h.capture.mockResolvedValue(undefined);
});

describe("POST /competitions/{id}/exports/scorer-sheets", () => {
  it("asks for WRITE on the competition (printing mints scoring links) and builds the day in the viewer's language, for this origin, stamped now", async () => {
    const before = Date.now();
    const res = await POST(req({ date: "2026-09-23" }), ctx);
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(h.auth).toHaveBeenCalledWith(expect.any(Request), "competition", "c1", "write");
    // baseUrl() prefers OAUTH_BASE_URL / NEXT_PUBLIC_BASE_URL, and vitest loads
    // the root .env.local: derive the expected origin, never pin it.
    const origin = new URL(baseUrl(req({ date: "2026-09-23" }))).origin;
    expect(origin).not.toBe(new URL(URL_).origin); // premise: the mutant (req.url) is distinguishable
    expect(h.build).toHaveBeenCalledTimes(1);
    const [auth, id, day, gotOrigin, locale, opts] = h.build.mock.calls[0]!;
    expect([auth, id, day, gotOrigin, locale]).toEqual([AUTH, "c1", "2026-09-23", origin, "fr"]);
    // The request's instant as ISO; the builder puts it on the org clock.
    const printedAt = (opts as { printedAt: string }).printedAt;
    expect(new Date(printedAt).toISOString()).toBe(printedAt);
    expect(Date.parse(printedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(printedAt)).toBeLessThanOrEqual(after);
  });

  it("serves the renderer's bytes of the built model as a private, uncached attachment named for the day", async () => {
    const res = await POST(req({ date: "2026-09-23" }), ctx);
    expect(h.render).toHaveBeenCalledWith(MODEL);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="scorer-sheets-2026-09-23.pdf"');
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("passes divisionId to the builder and rejects a non-uuid one", async () => {
    const division = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
    const ok = await POST(req({ date: "2026-09-23", divisionId: division }), ctx);
    expect(ok.status).toBe(200);
    expect((h.build.mock.calls[0]![5] as { divisionId?: string }).divisionId).toBe(division);
    h.build.mockClear();
    const bad = await POST(req({ date: "2026-09-23", divisionId: "nope" }), ctx);
    expect(bad.status).toBe(400);
    expect(h.build).not.toHaveBeenCalled();
  });

  it("groupBy division needs no date and reaches the builder; an unknown groupBy is 400", async () => {
    const ok = await POST(req({ groupBy: "division" }), ctx);
    expect(ok.status).toBe(200);
    expect((h.build.mock.calls[0]![5] as { groupBy?: string }).groupBy).toBe("division");
    h.build.mockClear();
    expect((await POST(req({ groupBy: "venue", date: "2026-09-23" }), ctx)).status).toBe(400);
    expect(h.build).not.toHaveBeenCalled();
  });

  it("auth runs before the body is read: a 403 wins over a body that is not even JSON", async () => {
    h.auth.mockRejectedValueOnce(new HttpError(403, "Insufficient permissions"));
    const res = await POST(req("not json"), ctx);
    expect(res.status).toBe(403);
    expect(h.build).not.toHaveBeenCalled();
  });

  it.each([
    ["a day in the wrong format", { date: "23/09/2026" }],
    ["a day that does not exist", { date: "2026-02-30" }],
    ["no day at all", {}],
    ["a body that is not JSON", "not json"],
  ])("%s → 400 VALIDATION, and nothing is built", async (_name, body) => {
    const res = await POST(req(body), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION");
    expect(h.build).not.toHaveBeenCalled();
  });

  it("the use-case's refusals come back in the v1 envelope with their code and message intact, never as a file", async () => {
    h.build.mockRejectedValueOnce(new HttpError(422, "No fixtures to print on that day", "NO_FIXTURES_ON_DAY"));
    const r422 = await POST(req({ date: "2026-10-01" }), ctx);
    expect(r422.status).toBe(422);
    expect(await r422.json()).toMatchObject({ ok: false, error: { code: "NO_FIXTURES_ON_DAY" } });

    // A 500 is v1's to log (api-v1/http.ts); captured here so the expected
    // refusal does not print a level-50 line into the run.
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    const incomplete = "Certains liens de score n'ont pas pu être préparés. Réessayez.";
    h.build.mockRejectedValueOnce(new HttpError(500, incomplete, "SHEET_LINKS_INCOMPLETE"));
    const r500 = await POST(req({ date: "2026-09-23" }), ctx);
    expect(r500.status).toBe(500);
    expect(r500.headers.get("content-disposition")).toBeNull();
    expect(await r500.json()).toMatchObject({ ok: false, error: { code: "SHEET_LINKS_INCOMPLETE", message: incomplete } });
    expect(h.render).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ code: "SHEET_LINKS_INCOMPLETE" }), "v1: HttpError reached 500");
  });

  it("a card whose QR cannot be encoded refuses the whole sheet: 500, no PDF", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    h.render.mockRejectedValueOnce(new Error("QR generation failed for fixture f1"));
    const res = await POST(req({ date: "2026-09-23" }), ctx);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).not.toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(logged).toHaveBeenCalledWith({ err: expect.objectContaining({ message: "QR generation failed for fixture f1" }) }, "v1: unhandled error");
  });

  it("one bucket per user, `sheets:<userId>`, six prints a minute: the sixth prints, the seventh is 429 and builds nothing", async () => {
    __setRateLimitCounterForTests(counter(6));
    expect((await POST(req({ date: "2026-09-23" }), ctx)).status).toBe(200);
    __setRateLimitCounterForTests(counter(7));
    expect((await POST(req({ date: "2026-09-23" }), ctx)).status).toBe(429);
    expect(h.build).toHaveBeenCalledTimes(1);
    expect(limiterKeys).toEqual([
      ["rl:sheets:u1", 60],
      ["rl:sheets:u1", 60],
    ]);
  });
});

// Fix batch item 6a (owner-approved 2026-09-25): `scorer_sheets_printed`, sent
// server-side once a PDF has been BUILT. Counts and ids only: a card's QR URL
// is a live scoring credential, so no token, URL or link id is ever sent.
describe("POST /competitions/{id}/exports/scorer-sheets: the scorer_sheets_printed event", () => {
  it("a built sheet is counted once, after the PDF exists: the acting user, the org, and the print's counts", async () => {
    const res = await POST(req({ date: "2026-09-23" }), ctx);
    expect(res.status).toBe(200);
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.capture).toHaveBeenCalledWith({
      event: "scorer_sheets_printed",
      distinctId: "u1",
      orgId: "o1",
      properties: { competition_id: "c1", date: "2026-09-23", fixture_count: 7, court_count: 2, courtless_count: 1 },
    });
    expect(h.capture.mock.invocationCallOrder[0]!).toBeGreaterThan(h.render.mock.invocationCallOrder[0]!);
    const sent = JSON.stringify(h.capture.mock.calls[0]);
    expect(sent).not.toContain("dl_");
    expect(sent).not.toContain("/score/");
    expect(sent, "no fixture/link id either").not.toContain("f1");
  });

  it("the download never waits on PostHog (fire-and-forget)", async () => {
    h.capture.mockReturnValue(new Promise<void>(() => {}));
    const hung = Symbol("hung");
    const outcome = await Promise.race([
      POST(req({ date: "2026-09-23" }), ctx),
      new Promise<typeof hung>((resolve) => setTimeout(() => resolve(hung), 1000)),
    ]);
    expect(outcome, "the PDF came back while PostHog never answered").not.toBe(hung);
    expect((outcome as Response).status).toBe(200);
  });

  it.each([
    ["403: auth refuses", () => h.auth.mockRejectedValueOnce(new HttpError(403, "Insufficient permissions")), 403],
    ["400: the body is invalid", null, 400],
    ["429: the limiter refuses", () => __setRateLimitCounterForTests(counter(7)), 429],
    ["402: the build refuses on plan", () => h.build.mockRejectedValueOnce(new HttpError(402, "Upgrade", "PLAN_REQUIRED")), 402],
    ["422: nothing to print", () => h.build.mockRejectedValueOnce(new HttpError(422, "No fixtures", "NO_FIXTURES_ON_DAY")), 422],
    ["500: links not proven", () => h.build.mockRejectedValueOnce(new HttpError(500, "incomplete", "SHEET_LINKS_INCOMPLETE")), 500],
    ["500: a QR cannot be encoded", () => h.render.mockRejectedValueOnce(new Error("QR generation failed")), 500],
  ] as const)("%s → nothing is counted", async (_name, arrange, status) => {
    vi.spyOn(log, "error").mockImplementation(() => undefined as never);
    arrange?.();
    const res = await POST(req(status === 400 ? { date: "23/09/2026" } : { date: "2026-09-23" }), ctx);
    expect(res.status).toBe(status);
    expect(h.capture).not.toHaveBeenCalled();
  });
});
