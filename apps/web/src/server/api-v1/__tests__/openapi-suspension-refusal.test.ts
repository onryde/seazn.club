// Discipline fix wave (2026-10-27): confirming a ban for a player on no entrant of the division is refused 422
// SUSPENSION_NO_ENTRANT (`decideSuspension`, usecases/discipline.ts) — a ban that could never be served. The PATCH that
// confirms it must DOCUMENT that refusal: an API-key client generated from the spec otherwise has no 422 to handle. The
// code is read from the shared constant the usecase throws, never retyped here.
import { describe, expect, it } from "vitest";
import { SUSPENSION_NO_ENTRANT_CODE } from "@/lib/suspension-no-entrant";
import { buildOpenApiDocument, ROUTES } from "../openapi";

type Op = { summary?: string; responses: Record<string, { description: string }> };

const PATH = "/suspensions/{id}";

describe("OpenAPI — PATCH /suspensions/{id} documents the no-entrant refusal", () => {
  it("the route declares 422 and names the code its summary", () => {
    const route = ROUTES.find((r) => r.path === PATH && r.method === "patch");
    expect(route, "rig: the route is registered").toBeDefined();
    expect(route!.errors).toContain(422);
    expect(route!.summary).toContain(SUSPENSION_NO_ENTRANT_CODE);
  });

  it("the built document carries the 422 response (every document the route is in)", () => {
    const docs = [buildOpenApiDocument(), buildOpenApiDocument({ published: true })];
    const ops = docs
      .map((doc) => (doc.paths as Record<string, Record<string, Op>>)[`/api/v1${PATH}`]?.patch)
      .filter((op): op is Op => op !== undefined);
    expect(ops.length, "documents checked").toBeGreaterThan(0);
    for (const op of ops) {
      expect(Object.keys(op.responses)).toContain("422");
      expect(op.summary).toContain(SUSPENSION_NO_ENTRANT_CODE);
    }
  });
});
