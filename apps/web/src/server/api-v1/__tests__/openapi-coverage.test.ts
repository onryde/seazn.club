// Spec ⇄ implementation drift gate (PROMPT-11 acceptance: "OpenAPI spec
// validates and matches implemented routes"). Walks src/app/api/v1/**/route.ts
// and asserts an exact 1:1 with the ROUTES registry the spec is built from.
// Combined with CI's openapi:gen diff check, neither the spec file nor the
// route tree can drift from the other.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildOpenApiDocument, ROUTES } from "../openapi";

const API_ROOT = join(__dirname, "..", "..", "..", "app", "api", "v1");
const METHOD_RE = /export async function (GET|POST|PUT|PATCH|DELETE)/g;

function walk(dir: string, segments: string[] = []): { path: string; method: string }[] {
  const found: { path: string; method: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full, [...segments, entry]));
    } else if (entry === "route.ts") {
      const path = "/" + segments.map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/");
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(METHOD_RE)) {
        found.push({ path, method: (match[1] as string).toLowerCase() });
      }
    }
  }
  return found;
}

describe("openapi coverage", () => {
  it("ROUTES registry matches the route files on disk exactly", () => {
    const implemented = walk(API_ROOT)
      .filter((r) => r.path !== "/openapi.json") // the spec endpoint itself
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const declared = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(implemented).toEqual(declared);
  });

  it("builds a structurally sound 3.1 document", () => {
    const doc = buildOpenApiDocument() as {
      openapi: string;
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(20);
    for (const [path, ops] of Object.entries(doc.paths)) {
      expect(path.startsWith("/api/v1/")).toBe(true);
      for (const op of Object.values(ops)) {
        expect(Object.keys(op.responses).length).toBeGreaterThan(0);
      }
    }
    // Serialisable (what the route + gen script emit).
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  // #386: the joint-restore entry shipped with `request:` and `errors:` but no
  // `response:`, so the spec advertised an untyped `{}` for `data` while the
  // route really returns restored/failed/ok. `openapi:gen` cannot catch that —
  // it regenerates the untyped shape happily — so the gate is here.
  it("types the joint schedule restore's response body", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses: Record<
              string,
              {
                content: {
                  "application/json": {
                    schema: { properties: { data: { properties?: Record<string, unknown> } } };
                  };
                };
              }
            >;
          }
        >
      >;
    };
    const op = doc.paths["/api/v1/competitions/{id}/schedule/restore"]!.post!;
    const data = op.responses["200"]!.content["application/json"].schema.properties.data;
    expect(Object.keys(data.properties ?? {}).sort()).toEqual(["failed", "ok", "restored"]);
  });

  // P4 review (2026-08-13) finding 8: the 409 `live_version` and 422
  // `{divisionIndex, stageIndex, cause}` extras (design doc's error table)
  // are real wire fields (templates.ts's HttpError `extra`) that were
  // undocumented in the spec. Registered per-route (ERROR_SCHEMA_OVERRIDES),
  // never folded into the shared ERROR_ENVELOPE — see
  // BASE_ERROR_PROPERTIES's own comment for why a shared addition is the
  // wrong fix (a prior one roughly doubled every route x error status in
  // the served spec). This test pins both the presence AND the scoping.
  it("documents the from-template route's 409/422 extras, scoped to that route only", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses: Record<
              string,
              {
                content: {
                  "application/json": {
                    schema: { properties: { error: { properties?: Record<string, unknown> } } };
                  };
                };
              }
            >;
          }
        >
      >;
    };
    const fromTemplate = doc.paths["/api/v1/competitions/from-template"]!.post!;
    const err409 = fromTemplate.responses["409"]!.content["application/json"].schema.properties.error;
    expect(Object.keys(err409.properties ?? {}).sort()).toEqual(
      ["code", "current_seq", "live_version", "message"].sort(),
    );
    const err422 = fromTemplate.responses["422"]!.content["application/json"].schema.properties.error;
    expect(Object.keys(err422.properties ?? {}).sort()).toEqual(
      ["cause", "code", "current_seq", "divisionIndex", "message", "stageIndex"].sort(),
    );
    // Scoped, not global: an unrelated route's 409 must NOT pick up
    // `live_version` (the #386-shaped mistake this override pattern exists
    // to prevent — see ERROR_SCHEMA_OVERRIDES's own comment).
    const otherRoute = doc.paths["/api/v1/competitions"]!.post!;
    const otherErr409 = otherRoute.responses["409"]!.content["application/json"].schema.properties.error;
    expect(Object.keys(otherErr409.properties ?? {})).not.toContain("live_version");
  });
});
