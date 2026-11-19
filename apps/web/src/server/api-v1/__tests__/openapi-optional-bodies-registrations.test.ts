// Registration defects fix round 2 M-2: `confirm` and `waive` accept NO body (the route reads an absent one as `{}`: `parseOptionalBody`,
// api-v1/http.ts), but the document declared `requestBody.required: true`, so a generated client refused to call them bare. The two are
// documented optional, and `approve` (whose body IS required) is the control that keeps this from being "everything optional".
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../openapi";
import { PutRegistrationSettings } from "../schemas";

type Op = { requestBody?: { required?: boolean } };
const doc = buildOpenApiDocument() as unknown as { paths: Record<string, Record<string, Op>> };

describe("openapi: registration confirm and waive bodies are optional (fix round 2 M-2)", () => {
  it("confirm and waive declare requestBody.required false", () => {
    const seen = ["confirm", "waive"].map((leaf) => doc.paths[`/api/v1/registrations/{id}/${leaf}`]?.post?.requestBody?.required);
    expect(seen.length, "anti-vacuity: two operations read").toBe(2);
    expect(seen).toEqual([false, false]);
  });

  it("control: an operation whose body is required still says so (a body-bearing registration write)", () => {
    const required = Object.entries(doc.paths)
      .filter(([p]) => p.startsWith("/api/v1/registrations/") || p.startsWith("/api/v1/divisions/"))
      .flatMap(([, ops]) => Object.values(ops))
      .filter((op) => op.requestBody?.required === true);
    expect(required.length, "at least one registration-area write still requires its body").toBeGreaterThan(0);
  });
});

// Fix round 3 item 6: the fr plural treats 0 as `one`, so "La seule place" would be wrong for a division of capacity 0. It cannot happen:
// the settings schema floors capacity at 1 (and the column has CHECK (capacity > 0), db/migration/v2-engine/tables/V223__registrations.sql).
describe("a division's capacity is at least 1 (so the singular 'only place' copy can never meet 0)", () => {
  it("PutRegistrationSettings refuses capacity 0 and accepts 1", () => {
    const base = { enabled: true, entrant_kind: "individual", fee_cents: 0, payment_method: "offline" } as const;
    expect(PutRegistrationSettings.safeParse({ ...base, capacity: 0 }).success).toBe(false);
    expect(PutRegistrationSettings.safeParse({ ...base, capacity: 1 }).success).toBe(true);
  });
});
