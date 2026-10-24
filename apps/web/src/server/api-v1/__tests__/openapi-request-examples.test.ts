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
import { REQUEST_EXAMPLE_PATCHES, ROUTES, buildOpenApiDocument, exampleOf, requestExampleOf } from "../openapi";

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
    let removed = 0;
    for (const key of Object.keys(REQUEST_EXAMPLE_PATCHES)) {
      const route = ROUTES.find((r) => `${r.method.toUpperCase()} ${r.path}` === key);
      expect(route?.request, `${key}: a route with a request body`).toBeDefined();
      const alone = route!.request!.safeParse(requestExampleOf(route!, { patched: false }));
      expect(alone.success, `${key}: the generated example needs its patch`).toBe(false);
      const patched = requestExampleOf(route!) as Record<string, unknown>;
      expect(route!.request!.safeParse(patched).success, `${key}: and the patched one parses`).toBe(true);
      // A property a patch removes is absent from the example, not present as `undefined` (what a consumer of the object sees).
      for (const [prop, value] of Object.entries(REQUEST_EXAMPLE_PATCHES[key]!)) {
        if (value !== undefined) continue;
        expect(Object.hasOwn(patched, prop), `${key}: ${prop} is removed, not set to undefined`).toBe(false);
        removed++;
      }
      checked++;
    }
    expect(checked, "anti-vacuity: patches checked").toBe(Object.keys(REQUEST_EXAMPLE_PATCHES).length);
    expect(checked).toBeGreaterThan(0);
    expect(removed, "anti-vacuity: properties a patch removes were checked").toBeGreaterThan(0);
  });

  // The per-route test above holds a patch of several properties to one standard: the generator alone is refused. A property
  // the schema no longer needs would ride along unseen as long as another property of the same patch still did the work, so
  // each property is held to it on its own: the patched example with ONLY that property handed back to the generator is refused.
  it("every property of a patch is load-bearing on its own: handing just that one back to the generator is refused (counted)", () => {
    let props = 0;
    let multi = 0;
    for (const [key, patch] of Object.entries(REQUEST_EXAMPLE_PATCHES)) {
      const route = ROUTES.find((r) => `${r.method.toUpperCase()} ${r.path}` === key)!;
      const generated = requestExampleOf(route, { patched: false }) as Record<string, unknown>;
      const patched = requestExampleOf(route) as Record<string, unknown>;
      if (Object.keys(patch).length > 1) multi++;
      for (const prop of Object.keys(patch)) {
        const mixed = { ...patched };
        if (Object.hasOwn(generated, prop)) mixed[prop] = generated[prop];
        else delete mixed[prop];
        expect(route.request!.safeParse(mixed).success, `${key}: ${prop} is not needed (the patched example parses without it)`).toBe(false);
        props++;
      }
    }
    expect(props, "anti-vacuity: every property of every patch was checked").toBe(
      Object.values(REQUEST_EXAMPLE_PATCHES).reduce((n, p) => n + Object.keys(p).length, 0),
    );
    expect(multi, "anti-vacuity: a patch of several properties was among them").toBeGreaterThan(0);
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

// The generator's constraint handling, directly, on synthetic JSON Schemas: the routes above exercise only the constraints
// today's request bodies happen to carry, so a handler no route needs would be unproven (a maxLength cut, a uri). Each
// expectation is the constraint itself, never a string typed from the generator's output.
describe("exampleOf honours what the JSON Schema says of a value", () => {
  const str = (extra: Record<string, unknown>) => exampleOf({ type: "string", ...extra }) as string;

  it("formats: an email is an address, a uri is a URL, a uuid is a uuid, a date is a date", () => {
    expect(str({ format: "email" })).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    expect(() => new URL(str({ format: "uri" }))).not.toThrow();
    expect(() => new URL(str({ format: "url" }))).not.toThrow();
    expect(str({ format: "uuid" })).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Number.isNaN(Date.parse(str({ format: "date" })))).toBe(false);
  });

  it("length bounds: padded up to minLength, cut down to maxLength, an exact length met, and always non-empty", () => {
    let checked = 0;
    for (const [min, max] of [[16, 64], [10, undefined], [undefined, 3], [1, 1], [3, 3], [40, 40], [0, 0]] as const) {
      const out = str({ ...(min === undefined ? {} : { minLength: min }), ...(max === undefined ? {} : { maxLength: max }) });
      expect(out.length, `min ${min} max ${max}`).toBeGreaterThanOrEqual(min ?? 0);
      expect(out.length, `min ${min} max ${max}`).toBeLessThanOrEqual(max ?? Number.POSITIVE_INFINITY);
      if (max !== 0) expect(out.length, "an example is never empty unless the bound says so").toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("a pattern or an exact length takes the schema's declared default (valid by construction); a loose string keeps the stock word", () => {
    expect(str({ pattern: "^/", default: "/settings/billing" })).toBe("/settings/billing");
    expect(str({ minLength: 3, maxLength: 3, default: "gbp" })).toBe("gbp");
    // A default beside a LOOSE bound is not preferred: an empty default would publish an empty example.
    expect(str({ maxLength: 500, default: "" }).length).toBeGreaterThan(0);
    expect(str({ default: "x" })).not.toBe("");
  });

  it("minItems: a list of scalars gets that many DISTINCT items; a list of objects keeps one sample", () => {
    const ids = exampleOf({ type: "array", minItems: 3, items: { type: "string", format: "uuid" } }) as string[];
    expect(ids.length).toBe(3);
    expect(new Set(ids).size, "distinct").toBe(3);
    expect(exampleOf({ type: "array", items: { type: "string" } })).toHaveLength(1);
    expect(exampleOf({ type: "array", minItems: 3, items: { type: "object", properties: { a: { type: "string" } } } })).toHaveLength(1);
  });
});
