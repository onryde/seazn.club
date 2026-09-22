// Swiss round-1 pairing (spec 2026-09-22), Task 3 fix round 1 — an OPTIONAL
// request body must be documented as optional. `POST /stages/{id}/generate`
// reads its `{ pairing }` body as text and treats an absent one as `{}` (an
// API-key caller written before the body existed sends none). The generator
// used to emit `requestBody.required: true` for every route with `request:`,
// so the published spec told client generators the body was mandatory.
// `requestOptional` on the RouteSpec is the opt-out; it is set on generate
// ONLY, so every other body route must still be required. The promote route
// is the control: it also reads text, and it is deliberately left unchanged
// here (follow-up).
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../openapi";

type Op = {
  requestBody?: { required?: boolean; content: Record<string, unknown> };
  responses: Record<string, { description: string }>;
};

function op(doc: Record<string, unknown>, path: string, method: string): Op {
  const found = (doc.paths as Record<string, Record<string, Op>>)[path]?.[method];
  if (!found) throw new Error(`${method.toUpperCase()} ${path} is not in the document`);
  return found;
}

const GENERATE = "/api/v1/stages/{id}/generate";
const PROMOTE = "/api/v1/registrations/{id}/promote";

describe("OpenAPI — an optional request body is documented as optional", () => {
  for (const [label, doc] of [
    ["full", buildOpenApiDocument()],
    ["published", buildOpenApiDocument({ published: true })],
  ] as const) {
    it(`${label}: POST /stages/{id}/generate has a body schema that is NOT required`, () => {
      const generate = op(doc, GENERATE, "post");
      expect(generate.requestBody).toBeDefined();
      expect(generate.requestBody!.content["application/json"]).toBeDefined();
      expect(generate.requestBody!.required).toBe(false);
    });
  }

  it("a body route without the opt-out is still required (control)", () => {
    const promote = op(buildOpenApiDocument(), PROMOTE, "post");
    expect(promote.requestBody?.required).toBe(true);
  });

  it("generate keeps the default 400 description rather than a generic one", () => {
    expect(op(buildOpenApiDocument(), GENERATE, "post").responses["400"]!.description).toBe(
      "Validation error",
    );
  });
});
