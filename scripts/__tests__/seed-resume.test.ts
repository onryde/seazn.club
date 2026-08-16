// Regression for the INVERSE face of the slug pre-check defect.
//
// `POST /api/v1/competitions` without an explicit slug can never 409: the
// server generates the slug and suffixes any collision away. seed-demo's PLAN
// loop nonetheless resumed by CATCHING "already in use", so the catch was
// unreachable and every rerun minted a second competition with the same name
// and a "-2" slug — "Racquet Masters" was two rows after two runs.
//
// The fix is to resume by NAME, checked before creating. These tests drive a
// fake `call` that reproduces the server's actual contract (auto-suffix, never
// 409 on a generated slug), because a fake that DID 409 would make the old,
// broken catch-based version pass.
import { describe, expect, it } from "vitest";
import { findOrCreateCompetition, type ApiCall } from "../seed-resume.ts";

interface Row {
  id: string;
  name: string;
  slug: string;
}

function fakeApi(opts: { failWith?: string } = {}): { call: ApiCall; rows: Row[] } {
  const rows: Row[] = [];
  const call: ApiCall = async (path, method = "GET", body?: unknown) => {
    if (method === "GET" && path.startsWith("/api/v1/competitions?")) {
      return { items: rows.map((r) => ({ ...r })) };
    }
    if (method === "POST" && path === "/api/v1/competitions") {
      if (opts.failWith) throw new Error(opts.failWith);
      const name = (body as { name: string }).name;
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      // The server behaviour that made the old catch dead code: it suffixes
      // rather than rejecting, so a duplicate NAME always succeeds.
      let n = 1;
      while (rows.some((r) => r.slug === (n === 1 ? base : `${base}-${n}`))) n++;
      const row = { id: `id-${rows.length + 1}`, name, slug: n === 1 ? base : `${base}-${n}` };
      rows.push(row);
      return row;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, rows };
}

describe("findOrCreateCompetition", () => {
  it("creates once and resumes on the second run instead of duplicating", async () => {
    const { call, rows } = fakeApi();

    const first = await findOrCreateCompetition(call, "Racquet Masters", {
      ends_on: "2030-12-31",
    });
    const second = await findOrCreateCompetition(call, "Racquet Masters", {
      ends_on: "2030-12-31",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("racquet-masters"); // never "-2"
    expect(second?.id).toBe(first?.id);
  });

  it("still creates a genuinely new competition alongside an existing one", async () => {
    const { call, rows } = fakeApi();
    await findOrCreateCompetition(call, "Racquet Masters", { ends_on: "2030-12-31" });
    await findOrCreateCompetition(call, "Winter Cup", { ends_on: "2030-12-31" });
    expect(rows.map((r) => r.name)).toEqual(["Racquet Masters", "Winter Cup"]);
  });

  it("returns null on a plan cap so the seed skips rather than aborting", async () => {
    const { call } = fakeApi({ failWith: "POST /api/v1/competitions → 402 payment required" });
    await expect(
      findOrCreateCompetition(call, "Capped", { ends_on: "2030-12-31" }),
    ).resolves.toBeNull();
  });

  it("rethrows anything that is not a plan cap", async () => {
    const { call } = fakeApi({ failWith: "POST /api/v1/competitions → 500 boom" });
    await expect(
      findOrCreateCompetition(call, "Broken", { ends_on: "2030-12-31" }),
    ).rejects.toThrow(/500 boom/);
  });
});
