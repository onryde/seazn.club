// The bot check (Cloudflare Turnstile) is part of the public write contract: a client that does not know about the
// `cf-turnstile-response` header gets a 403 TURNSTILE_FAILED it cannot explain. So every /api/v1/public route whose handler asks
// for the check documents the header and the 403, and no other operation claims to take it.
//
// The set of gated routes is read from the route SOURCE (`requireTurnstile(req, "<action>")`), never typed here, so a route that
// gains the gate and not the documentation fails this test, and so does documentation for a route that has no gate.
// The wire literals (header name, code) are typed here on purpose: a rename on one side only is a red test, not silent drift.
//
// Sport: not applicable. A bot check is sport-agnostic.
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../openapi";

const PUBLIC_DIR = resolve(import.meta.dirname, "../../../app/api/v1/public");

type Param = { name: string; in: string; required: boolean; description?: string };
type Op = { parameters: Param[]; responses: Record<string, { description: string }> };
type Doc = { paths: Record<string, Record<string, Op>> };

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === "route.ts" ? [p] : [];
  });
}

/** `.../registrations/[id]/withdraw/route.ts` -> `/api/v1/public/registrations/{id}/withdraw` */
const openApiPath = (file: string) =>
  `/api/v1/public/${relative(PUBLIC_DIR, file).replace(/\/?route\.ts$/, "").replace(/\[(\w+)\]/g, "{$1}")}`;

const gated = routeFiles(PUBLIC_DIR)
  .filter((f) => /\brequireTurnstile\(\s*req\s*,\s*"[a-z]+"\s*\)/.test(readFileSync(f, "utf8")))
  .map(openApiPath)
  .sort();

describe("OpenAPI documents the bot check on exactly the routes that enforce it", () => {
  for (const [label, doc] of [
    ["full", buildOpenApiDocument() as unknown as Doc],
    ["published", buildOpenApiDocument({ published: true }) as unknown as Doc],
  ] as const) {
    it(`${label}: anti-vacuity, five gated public routes were read from source and each is a POST in the spec`, () => {
      expect(gated).toEqual([
        "/api/v1/public/orgs/{orgSlug}/competitions/{slug}/register",
        "/api/v1/public/orgs/{orgSlug}/competitions/{slug}/register/join",
        "/api/v1/public/registrations/by-ref/{ref}/withdraw",
        "/api/v1/public/registrations/groups/{id}/resend",
        "/api/v1/public/registrations/{id}/withdraw",
      ]);
      for (const path of gated) expect(doc.paths[path]?.post, `${path} is documented as a POST`).toBeDefined();
    });

    it(`${label}: each gated route has the cf-turnstile-response header (optional, a string) and a 403`, () => {
      let checked = 0;
      for (const path of gated) {
        const op = doc.paths[path]!.post!;
        const header = op.parameters.find((p) => p.in === "header" && p.name === "cf-turnstile-response");
        expect(header, `${path} documents the header`).toBeDefined();
        expect(header!.required, `${path}: optional, a developer's server and CI harnesses skip the check`).toBe(false);
        expect(header!.description, `${path}: the header says what refuses and with which code`).toContain("403 TURNSTILE_FAILED");
        // Not every route spends the shared public read budget first (register, join and by-ref have buckets of their own), so the
        // text names "the route's first per-IP rate limit" and never the read budget.
        expect(header!.description, `${path}: says which limit the refusal counts against, truthfully`).toContain("first per-IP rate limit");
        expect(header!.description).not.toContain("public read budget");
        expect(op.responses["403"], `${path} documents the 403`).toBeDefined();
        expect(op.responses["403"]!.description).toBe("Forbidden");
        checked++;
      }
      expect(checked).toBe(gated.length);
      expect(checked).toBeGreaterThan(0);
    });

    it(`${label}: no other operation claims the header, and the GET sibling of a gated path does not (the positive pair)`, () => {
      let swept = 0;
      let carrying = 0;
      for (const [path, methods] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(methods)) {
          swept++;
          const has = (op.parameters ?? []).some((p) => p.name === "cf-turnstile-response");
          if (has) carrying++;
          expect([`${method} ${path}`, has]).toEqual([`${method} ${path}`, method === "post" && gated.includes(path)]);
        }
      }
      expect(swept, "operations swept").toBeGreaterThan(100);
      expect(carrying).toBe(gated.length);
      // The join preview is a GET on a gated path: it must not claim a header the route never reads.
      const preview = doc.paths["/api/v1/public/orgs/{orgSlug}/competitions/{slug}/register/join"]!.get!;
      expect(preview.parameters.some((p) => p.in === "header")).toBe(false);
    });
  }
});
