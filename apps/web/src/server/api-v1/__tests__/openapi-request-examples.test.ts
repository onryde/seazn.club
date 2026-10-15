// Every request example the generator publishes must parse against the request's OWN zod schema, so a client that copies
// one is not answered 400. The expected verdict is each route's own schema, never the generator.
//
// History: W2c Task 13b fix round 1 (review IMPORTANT) found POST/PUT /divisions/{id}/stages and PUT /stages/{id}/rules
// publishing examples made only of refused keys (`z.never`, emitted `{not: {}}`), and left 26 OTHER examples failing for
// reasons unrelated to deciders (a generic "example" string where the schema wants an email, a URL, a minimum length, a
// timezone, or a cross-field refine) as a named ratchet. W2c batch 4 (ruling: fix inline, not deferred) cleared all 26:
// `exampleOf` honours the JSON Schema's formats, lengths, item counts and declared defaults, and the few refines JSON Schema
// cannot express (a timezone, a stream host, an exclusive pair) are patched by name in `REQUEST_EXAMPLE_PATCHES`. The ratchet
// is therefore ZERO: any example its own schema refuses is red, naming the route and the schema's reasons, and a new route
// whose example fails owes a patch.
import { describe, expect, it } from "vitest";
import { REQUEST_EXAMPLE_PATCHES, ROUTES, buildOpenApiDocument, requestExampleOf } from "../openapi";

type Op = { requestBody?: { content: Record<string, { example?: unknown }> } };

describe("OpenAPI — every published request example parses against its own schema", () => {
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, Op>> };
  const verdicts = ROUTES.filter((r) => r.request !== undefined).flatMap((r) => {
    const key = `${r.method.toUpperCase()} ${r.path}`;
    const content = doc.paths[`/api/v1${r.path}`]?.[r.method]?.requestBody?.content ?? {};
    return Object.entries(content).map(([type, c]) => {
      const parsed = r.request!.safeParse(c.example);
      const issues = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      return { key, type, example: c.example, ok: parsed.success, issues };
    });
  });

  it("checks every route that takes a body, one example per content type (counted; zero is a failure)", () => {
    const withBody = ROUTES.filter((r) => r.request !== undefined).length;
    // The floors are the real counts today (114 body routes, each publishing one example): a route that drops its body or
    // its example is a smaller number, and a new route only raises them.
    expect(withBody, "anti-vacuity: routes declare request bodies").toBeGreaterThanOrEqual(114);
    expect(verdicts.length, "every body route publishes an example").toBeGreaterThanOrEqual(withBody);
  });

  it("every published request example parses against its own schema (the ratchet is zero)", () => {
    const failing = verdicts.filter((v) => !v.ok);
    const detail = failing.map((v) => `${v.key} ${JSON.stringify(v.example)} :: ${v.issues.join(" | ")}`);
    expect(detail, "a request example its own schema refuses").toEqual([]);
    expect(verdicts.filter((v) => v.ok).length, "anti-vacuity: examples that parse").toBeGreaterThanOrEqual(114);
  });

  // A patch is for a refine JSON Schema cannot express. One the generated example does not need is a stale entry (the schema
  // or the generator moved), and one that names no route is a typo: both are caught here, with the generator alone as witness.
  it("every patch names a route with a body, and each is load-bearing: the generator alone is refused by that route's schema (counted)", () => {
    let checked = 0;
    for (const key of Object.keys(REQUEST_EXAMPLE_PATCHES)) {
      const route = ROUTES.find((r) => `${r.method.toUpperCase()} ${r.path}` === key);
      expect(route?.request, `${key}: a route with a request body`).toBeDefined();
      const alone = route!.request!.safeParse(requestExampleOf(route!, { patched: false }));
      expect(alone.success, `${key}: the generated example needs its patch`).toBe(false);
      expect(route!.request!.safeParse(requestExampleOf(route!)).success, `${key}: and the patched one parses`).toBe(true);
      checked++;
    }
    expect(checked, "anti-vacuity: patches checked").toBe(Object.keys(REQUEST_EXAMPLE_PATCHES).length);
    expect(checked).toBeGreaterThan(0);
  });

  // `minItems` asks for several places: a tie-break order of two entrants is two DIFFERENT entrants, never one repeated.
  it("an array the schema asks several items of is several distinct items (a tie-break order)", () => {
    const route = ROUTES.find((r) => r.method === "post" && r.path === "/stages/{id}/seed-proposal/confirm")!;
    const example = requestExampleOf(route) as { tiePicks: { order: string[] }[] };
    const order = example.tiePicks[0]!.order;
    expect(order.length).toBeGreaterThanOrEqual(2);
    expect(new Set(order).size, "distinct entrants").toBe(order.length);
  });

  it("the stage routes' examples are real stage bodies: no refused top-level decider, and a config key with a reader", () => {
    let checked = 0;
    for (const key of ["POST /divisions/{id}/stages", "PUT /divisions/{id}/stages", "PUT /stages/{id}/rules"]) {
      const v = verdicts.find((x) => x.key === key);
      expect(v, key).toBeDefined();
      expect(v!.issues, key).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
    const create = verdicts.find((x) => x.key === "POST /divisions/{id}/stages")!.example as { config: Record<string, unknown> };
    expect(Object.keys(create.config).length, "the config example is not empty").toBeGreaterThan(0);
    const put = verdicts.find((x) => x.key === "PUT /stages/{id}/rules")!.example as Record<string, unknown>;
    expect(Object.keys(put).sort(), "the rules PUT shows its two arms").toEqual(["points", "rules"]);
  });
});
