// seed-demo leaves every competition it creates as a DRAFT (the create API
// ignores `status`). Since the owner decision of 2026-09-27 a draft is listed
// nowhere — not on the org home, the sitemap, Discover or another
// competition's player card — so a demo that never publishes shows an EMPTY
// org home. `publishDrafts` is the seed's last step.
//
// The fake `call` reproduces the two server rules the order depends on:
// starting a division promotes a PUBLISHED competition to `live`
// (schedule.ts), never a draft; and a PATCH to a status sets it.
import { describe, expect, it } from "vitest";
import { publishDrafts } from "../seed-publish.ts";
import type { ApiCall } from "../seed-resume.ts";

interface Row {
  id: string;
  name: string;
  status: string;
}

function fakeApi(rows: Row[], opts: { failWith?: string } = {}): { call: ApiCall; patches: string[] } {
  const patches: string[] = [];
  const call: ApiCall = async (path, method = "GET", body?: unknown) => {
    if (method === "GET" && path.startsWith("/api/v1/competitions?")) {
      return { items: rows.map((r) => ({ ...r })) };
    }
    const m = /^\/api\/v1\/competitions\/([^/]+)$/.exec(path);
    if (method === "PATCH" && m) {
      if (opts.failWith) throw new Error(opts.failWith);
      const row = rows.find((r) => r.id === m[1])!;
      row.status = (body as { status: string }).status;
      patches.push(row.name);
      return row;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { call, patches };
}

/** The server rule a division start applies to its competition. */
const startDivisionOf = (row: Row) => {
  if (row.status === "published") row.status = "live";
};

describe("publishDrafts", () => {
  it("EMPTY first: nothing named, nothing patched", async () => {
    const { call, patches } = fakeApi([{ id: "a", name: "Cup", status: "draft" }]);
    expect(await publishDrafts(call, [])).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("publishes each named DRAFT, so the org home lists it", async () => {
    const rows = [
      { id: "a", name: "Spring Football League", status: "draft" },
      { id: "b", name: "Racquet Masters", status: "draft" },
    ];
    const { call } = fakeApi(rows);
    expect(await publishDrafts(call, ["Spring Football League", "Racquet Masters"])).toEqual([
      "Spring Football League",
      "Racquet Masters",
    ]);
    expect(rows.map((r) => r.status)).toEqual(["published", "published"]);
  });

  it("leaves a competition it was not asked about a draft — the unlisted registration demo stays as seeded", async () => {
    const rows = [
      { id: "a", name: "Racquet Masters", status: "draft" },
      { id: "b", name: "Autumn Open Registration", status: "draft" },
    ];
    await publishDrafts(fakeApi(rows).call, ["Racquet Masters"]);
    expect(rows[1]!.status).toBe("draft");
  });

  it("never touches a status past draft: completed stays Finished, live stays live", async () => {
    const rows = [
      { id: "a", name: "Winter 2024 (finished)", status: "completed" },
      { id: "b", name: "Cricket Cup", status: "live" },
    ];
    const { call, patches } = fakeApi(rows);
    expect(await publishDrafts(call, ["Winter 2024 (finished)", "Cricket Cup"])).toEqual([]);
    expect(patches).toEqual([]);
    expect(rows.map((r) => r.status)).toEqual(["completed", "live"]);
  });

  it("is a no-op on a rerun, and skips a name the account does not have", async () => {
    const rows = [{ id: "a", name: "Racquet Masters", status: "draft" }];
    const { call, patches } = fakeApi(rows);
    await publishDrafts(call, ["Racquet Masters", "Never Created"]);
    await publishDrafts(call, ["Racquet Masters"]);
    expect(patches).toEqual(["Racquet Masters"]);
  });

  it("run AFTER the seed's division starts, a played competition reads published — the same chip the draft showed", async () => {
    const rows = [{ id: "a", name: "Chess Open 2026", status: "draft" }];
    startDivisionOf(rows[0]!); // the PLAN loop starts every division first
    await publishDrafts(fakeApi(rows).call, ["Chess Open 2026"]);
    expect(rows[0]!.status).toBe("published");
    // The ordering hazard this step's placement avoids: published FIRST, a
    // later start (seedAdvancedFormats, seedArchivedSlotHolder) promotes it.
    const early = { id: "b", name: "Padel & Ladder Club", status: "draft" };
    await publishDrafts(fakeApi([early]).call, ["Padel & Ladder Club"]);
    startDivisionOf(early);
    expect(early.status).toBe("live");
  });

  it("a plan cap is a skip, not an abort; anything else rethrows", async () => {
    const capped = fakeApi([{ id: "a", name: "Cup", status: "draft" }], {
      failWith: "PATCH /api/v1/competitions/a → 402 payment required",
    });
    await expect(publishDrafts(capped.call, ["Cup"])).resolves.toEqual([]);
    const broken = fakeApi([{ id: "a", name: "Cup", status: "draft" }], { failWith: "PATCH → 500 boom" });
    await expect(publishDrafts(broken.call, ["Cup"])).rejects.toThrow(/500 boom/);
  });
});
