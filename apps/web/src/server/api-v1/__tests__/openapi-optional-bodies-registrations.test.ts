// Registration defects fix round 2 M-2: `confirm` and `waive` accept NO body (the route reads an absent one as `{}`: `parseOptionalBody`,
// api-v1/http.ts), but the document declared `requestBody.required: true`, so a generated client refused to call them bare. The two are
// documented optional, and `approve` (whose body IS required) is the control that keeps this from being "everything optional".
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../openapi";

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
