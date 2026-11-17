// The API map is behind the same per-organisation switch as the developer docs (owner, 2026-11-17). Before this it was
// open to anyone, so "docs off by default" still handed the full route list to whoever knew the address.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/developer-docs", () => ({ canSeeDeveloperDocs: async () => h.allowed }));

import { GET } from "../route";

const get = (query = "") => GET(new Request(`http://localhost/api/v1/openapi.json${query}`));

describe("GET /api/v1/openapi.json", () => {
  beforeEach(() => {
    h.allowed = false;
  });

  it.each(["", "?published=1"])("is not found without the switch (%s)", async (query) => {
    const res = await get(query);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("/api/v1/");
  });

  it("serves both documents with the switch on, and never lets a shared cache keep them", async () => {
    h.allowed = true;
    for (const query of ["", "?published=1"]) {
      const res = await get(query);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
      expect(doc.openapi).toBe("3.1.0");
      expect(Object.keys(doc.paths).length).toBeGreaterThan(10);
      // A `public` or `s-maxage` here would let the edge hand one organisation's 200 to everyone.
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("answers per request: on, then off again", async () => {
    h.allowed = true;
    expect((await get()).status).toBe(200);
    h.allowed = false;
    expect((await get()).status).toBe(404);
  });
});
