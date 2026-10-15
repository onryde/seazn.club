// W2c Task 13b fix round 1 (review IMPORTANT) — every request example the generator publishes must parse against the
// request's OWN zod schema. `exampleOf` (openapi.ts) builds an object example from the first four properties, so when
// Task 13b spread the top-level decider refusals (`z.never`, emitted `{not: {}}`) at the head of StageConfig and
// PutStageRules, POST/PUT /divisions/{id}/stages and PUT /stages/{id}/rules published examples made only of refused
// keys — bodies their own routes answer 400. The expected verdict is each route's own schema, never the generator.
//
// A ratchet, not a blanket: at the time of writing 26 OTHER request examples already failed their schemas, for reasons
// unrelated to deciders (a generic "example" string where the schema wants an email, a URL, a minimum length, a
// timezone, or a cross-field refine). They are listed by name with their reason. The set of failing examples must equal
// that list EXACTLY: a new failure is red, and so is a listed example that starts to parse (remove it from the list).
import { describe, expect, it } from "vitest";
import { ROUTES, buildOpenApiDocument } from "../openapi";

type Op = { requestBody?: { content: Record<string, { example?: unknown }> } };

/** Request examples that failed their own schema BEFORE Task 13b, not caused by it (route key -> why). */
const PRE_EXISTING: Record<string, string> = {
  "POST /persons/{id}/claim-invites": "email format",
  "POST /stages/{id}/seed-proposal/confirm": "tiePicks order needs >= 2 items",
  "PUT /divisions/{id}/schedule-settings": "tz must be a known IANA zone",
  "PUT /fixtures/{id}/stream": "streamUrl must be a supported https stream link",
  "POST /capture/codes/{code}/beats": "code pattern, phone min length",
  "POST /capture/codes/{code}/start": "phone min length",
  "POST /capture/codes/{code}/scoring-link": "phone min length",
  "POST /orgs/{id}/sponsors": "url format",
  "PATCH /orgs/{id}/sponsors/{sponsorId}": "url format",
  "POST /orgs/{id}/sponsor-packages": "currency max length",
  "POST /orgs/{id}/sponsor-orders": "email format",
  "POST /orgs/{id}/stream-targets": "watchUrl must be a supported https stream link",
  "PATCH /orgs/{id}/stream-targets/{targetId}": "refine: exactly one of label or streamKey",
  "POST /orgs/{id}/connect": "return_path must be app-relative",
  "POST /public/orgs/{orgSlug}/competitions/{slug}/register": "email format",
  "POST /public/orgs/{orgSlug}/competitions/{slug}/register/join": "email format",
  "POST /public/registrations/{id}/withdraw": "token min length",
  "POST /public/registrations/{id}/checkout": "token min length",
  "POST /public/registrations/by-ref/{ref}/withdraw": "token min length",
  "POST /public/registrations/groups/{id}/resend": "token min length",
  "POST /clubs/{id}/contacts": "email format",
  "PATCH /clubs/{id}/contacts/{contactId}": "email format",
  "POST /officials": "email format",
  "PATCH /officials/{id}": "email format",
  "POST /officials/{id}/invite": "email format",
  "POST /competitions/{id}/exports/scorer-sheets": "refine: date and dateFrom/dateTo are exclusive",
};

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
    expect(withBody, "anti-vacuity: routes declare request bodies").toBeGreaterThan(50);
    expect(verdicts.length, "every body route publishes an example").toBeGreaterThanOrEqual(withBody);
  });

  it("the examples that fail are exactly the named pre-existing ones (a new failure is red; a fixed one leaves the list)", () => {
    const failing = verdicts.filter((v) => !v.ok);
    const detail = failing.filter((v) => !(v.key in PRE_EXISTING)).map((v) => `${v.key} ${JSON.stringify(v.example)} :: ${v.issues.join(" | ")}`);
    expect(detail, "a request example its own schema refuses").toEqual([]);
    expect(failing.map((v) => v.key).sort(), "a listed example now parses: remove it from PRE_EXISTING").toEqual(Object.keys(PRE_EXISTING).sort());
    expect(verdicts.filter((v) => v.ok).length, "anti-vacuity: examples that parse").toBeGreaterThan(50);
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
