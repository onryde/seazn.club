// RS005 W2b — the row-expand detail's data layer (`fetchRegistrantDetails`,
// task 3). `@/lib/db`'s `withTenant` is mocked here so this file can prove
// the QUERY COUNT precisely (exactly 2, regardless of row count — "assert,
// don't merely claim", per this task's acceptance criteria) and the
// grouping/self-inclusion logic, all without a database. Real-Postgres
// correctness (actual roster ordering, sibling exclusion, LEFT JOIN
// defaulting) is fetch-registrant-details-db.test.ts's job — same split as
// fetch-registrant-rows.test.ts / fetch-registrant-rows-db.test.ts.
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { AuthCtx } from "@/server/api-v1/auth";

const playersResult = { value: [] as unknown[] };
const siblingsResult = { value: [] as unknown[] };
const txCalls = { count: 0, firsts: [] as string[] };

vi.mock("@/lib/db", () => ({
  withTenant: async (_orgId: string, fn: (tx: unknown) => unknown) => {
    const tx = (strings: unknown, ..._values: unknown[]) => {
      // A fragment-builder call (`${tx(idsArray)}`) — a plain array, no
      // `.raw` — same split page.test.tsx's own @/lib/db fake already uses.
      if (!Array.isArray(strings) || !("raw" in (strings as object))) {
        return { __fragment: strings };
      }
      const first = String((strings as string[])[0] ?? "").trim();
      txCalls.count += 1;
      txCalls.firsts.push(first);
      if (first.startsWith("select registration_id")) return Promise.resolve(playersResult.value);
      if (first.startsWith("select r.id")) return Promise.resolve(siblingsResult.value);
      throw new Error("fetch-registrant-details.test.ts: unrecognised query shape: " + first);
    };
    return fn(tx);
  },
}));

import { fetchRegistrantDetails } from "../data";

const AUTH: AuthCtx = { orgId: "org-1", via: "session", userId: "user-1", role: "owner", keyId: null };

beforeEach(() => {
  playersResult.value = [];
  siblingsResult.value = [];
  txCalls.count = 0;
  txCalls.firsts = [];
});

describe("fetchRegistrantDetails — query count (task 3: batched, never per-row)", () => {
  it("issues exactly 2 queries for a 5-row page spanning 3 distinct groups", async () => {
    const rows = [
      { id: "r1", group_id: "g1" },
      { id: "r2", group_id: "g1" },
      { id: "r3", group_id: "g2" },
      { id: "r4", group_id: "g2" },
      { id: "r5", group_id: "g3" },
    ];
    await fetchRegistrantDetails(AUTH, rows);
    expect(txCalls.count).toBe(2);
  });

  it("issues exactly 2 queries for a single-row page too — proves the count is fixed, not merely 'small'", async () => {
    await fetchRegistrantDetails(AUTH, [{ id: "r1", group_id: "g1" }]);
    expect(txCalls.count).toBe(2);
  });

  it("issues ZERO queries for an empty row list, rather than 2 wasted round trips", async () => {
    await fetchRegistrantDetails(AUTH, []);
    expect(txCalls.count).toBe(0);
  });

  it("one query reads registration_players, the other reads registrations — never the same shape twice", async () => {
    await fetchRegistrantDetails(AUTH, [{ id: "r1", group_id: "g1" }]);
    expect(txCalls.firsts).toHaveLength(2);
    expect(txCalls.firsts.some((f) => f.includes("registration_id"))).toBe(true);
    expect(txCalls.firsts.some((f) => f.startsWith("select r.id"))).toBe(true);
  });
});

describe("fetchRegistrantDetails — roster grouping", () => {
  it("groups players by registration_id, dropping the grouping column off the value", async () => {
    playersResult.value = [
      {
        registration_id: "r1",
        id: "p1",
        full_name: "Alex",
        squad_number: 7,
        is_captain: true,
        consent_status: "granted",
      },
      {
        registration_id: "r1",
        id: "p2",
        full_name: "Sam",
        squad_number: 4,
        is_captain: false,
        consent_status: "pending",
      },
      {
        registration_id: "r2",
        id: "p3",
        full_name: "Jordan",
        squad_number: null,
        is_captain: false,
        consent_status: "guardian",
      },
    ];
    const result = await fetchRegistrantDetails(AUTH, [
      { id: "r1", group_id: "g1" },
      { id: "r2", group_id: "g2" },
    ]);
    expect(result.rosterByRegistration.get("r1")).toEqual([
      { id: "p1", full_name: "Alex", squad_number: 7, is_captain: true, consent_status: "granted" },
      { id: "p2", full_name: "Sam", squad_number: 4, is_captain: false, consent_status: "pending" },
    ]);
    expect(result.rosterByRegistration.get("r2")).toHaveLength(1);
  });

  it("an entry with no player rows at all has no entry in the map (caller defaults with ??)", async () => {
    playersResult.value = [];
    const result = await fetchRegistrantDetails(AUTH, [{ id: "r1", group_id: "g1" }]);
    expect(result.rosterByRegistration.get("r1")).toBeUndefined();
  });
});

describe("fetchRegistrantDetails — sibling grouping (self-inclusive)", () => {
  it("groups by group_id and includes the row's OWN registration in its own group", async () => {
    siblingsResult.value = [
      {
        id: "r1",
        group_id: "g1",
        display_name: "Team A",
        status: "confirmed",
        division_name: "Open",
        form_fields: [],
      },
      {
        id: "r2",
        group_id: "g1",
        display_name: "Team B",
        status: "pending",
        division_name: "Open",
        form_fields: [],
      },
    ];
    const result = await fetchRegistrantDetails(AUTH, [{ id: "r1", group_id: "g1" }]);
    const group = result.siblingsByGroup.get("g1")!;
    expect(group.map((s) => s.id)).toEqual(["r1", "r2"]);
  });

  it("reads form_fields off the SAME sibling rows, keyed by registration id — no third query", async () => {
    siblingsResult.value = [
      {
        id: "r1",
        group_id: "g1",
        display_name: "Team A",
        status: "confirmed",
        division_name: "Open",
        form_fields: [{ key: "k", label: "K label", kind: "text", required: false }],
      },
      {
        id: "r2",
        group_id: "g1",
        display_name: "Team B",
        status: "pending",
        division_name: "Open",
        form_fields: null,
      },
    ];
    const result = await fetchRegistrantDetails(AUTH, [
      { id: "r1", group_id: "g1" },
      { id: "r2", group_id: "g1" },
    ]);
    expect(result.formFieldsByRegistration.get("r1")).toEqual([
      { key: "k", label: "K label", kind: "text", required: false },
    ]);
    // LEFT JOIN miss (no registration_settings row) -> null in the DB, [] here.
    expect(result.formFieldsByRegistration.get("r2")).toEqual([]);
  });
});
