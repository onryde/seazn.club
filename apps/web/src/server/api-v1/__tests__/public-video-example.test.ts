// Phase 4 final review m1: the published example of GET /public/fixtures/{id}/video must be a body the route could answer. The generator's
// first-enum-value rule paired a live `src` with `session: { state: "requested", wentLive: true }`: a requested session has never gone live,
// and the route answers `live` only while the session is `live`. The expected pairing is the route's own rule (the `live` field's doc on
// the schema: "while the fixture's latest stream session is on air to Seazn"), not a value read back from the generator.
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../openapi";

type Body = { data: { live: unknown; replay: unknown[]; session: { state: string; wentLive: boolean } | null } };
const SPECS = [
  ["internal spec", () => buildOpenApiDocument()],
  ["published spec", () => buildOpenApiDocument({ published: true })],
] as const;

describe("OpenAPI — the public fixture video example is coherent", () => {
  for (const [name, build] of SPECS) {
    it(`${name}: a live src is paired with a session that is live and has gone live`, () => {
      const doc = build() as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { example?: Body }> }> }>> };
      const example = doc.paths["/api/v1/public/fixtures/{id}/video"]?.get?.responses["200"]?.content?.["application/json"]?.example;
      expect(example, "PREMISE: the route publishes a 200 example").toBeDefined();
      expect(example!.data.live, "PREMISE: the example carries a live src").not.toBeNull();
      expect(example!.data.session, "a live answer names its session").not.toBeNull();
      expect(example!.data.session!.state).toBe("live");
      expect(example!.data.session!.wentLive).toBe(true);
    });
  }
});
