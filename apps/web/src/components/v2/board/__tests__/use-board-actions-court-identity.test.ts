// P9 pass 4a item 2b. `moveCard` and `swapCourts` both PATCHed
// `/api/v1/fixtures/{id}` with a `court_label` key — PatchFixture
// (schemas.ts) is `.strict()` and dropped that key from its shape when the
// cutover landed, so every drag and every court swap 400ed instead of
// writing. `swapCourts` additionally READ `f.court_label` to decide which
// side of the swap a fixture was on, which is frozen null post-cutover and
// so could never match either side. Both must key on court_id.
import { describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, options });
      return Promise.resolve({ conflicts: [] });
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { dayKey } from "@/lib/schedule-board";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";

const DIVISION = { id: "d1", name: "Open", seq: 3 } as unknown as BoardDivision;
const AT = "2026-08-05T12:00:00.000Z";
const DAY = dayKey(AT); // local-TZ-safe, matches whatever swapCourts/moveCard compute internally

// Post-cutover shape: a real court_id, frozen null court_label — exactly
// what every fixture placed since the cutover looks like.
const ON_COURT_A = {
  id: "f1",
  division_id: "d1",
  status: "scheduled",
  scheduled_at: AT,
  court_label: null,
  court_id: "crt-a",
  schedule_locked: false,
} as unknown as BoardFixture;

const ON_COURT_B = {
  id: "f2",
  division_id: "d1",
  status: "scheduled",
  scheduled_at: AT,
  court_label: null,
  court_id: "crt-b",
  schedule_locked: false,
} as unknown as BoardFixture;

const DIVISIONS = [DIVISION];

function driveHook(fixtures: BoardFixture[]) {
  let latest: BoardActions | null = null;
  renderIsland(() => {
    latest = useBoardActions(DIVISIONS, fixtures, {}, {}, true);
    return null;
  }, {});
  return () => latest as BoardActions;
}

describe("useBoardActions — court identity (P9 pass 4a)", () => {
  it("swapCourts matches fixtures by court_id (court_label is frozen null) and sends court_id, never court_label", async () => {
    const FIXTURES = [ON_COURT_A, ON_COURT_B];
    net.calls.length = 0;
    const actions = driveHook(FIXTURES);
    await actions().swapCourts(DAY, "crt-a", "crt-b");

    const patches = net.calls.filter((c) => c.options?.method === "PATCH");
    expect(patches).toHaveLength(2); // both fixtures matched a side of the swap

    for (const p of patches) {
      const json = p.options?.json as Record<string, unknown>;
      expect(json).not.toHaveProperty("court_label"); // PatchFixture is .strict() — this 400s
      expect(json).toHaveProperty("court_id");
    }
    const byFixture = new Map(
      patches.map((p) => [p.url, (p.options?.json as Record<string, unknown>).court_id]),
    );
    expect(byFixture.get("/api/v1/fixtures/f1")).toBe("crt-b"); // was on crt-a -> moves to crt-b
    expect(byFixture.get("/api/v1/fixtures/f2")).toBe("crt-a"); // was on crt-b -> moves to crt-a
  });

  it("swapCourts is a no-op for a fixture on neither side of the swap", async () => {
    const elsewhere = { ...ON_COURT_A, id: "f3", court_id: "crt-z" } as unknown as BoardFixture;
    net.calls.length = 0;
    const actions = driveHook([elsewhere]);
    await actions().swapCourts(DAY, "crt-a", "crt-b");
    expect(net.calls.filter((c) => c.options?.method === "PATCH")).toHaveLength(0);
  });

  it("moveCard sends court_id, never court_label, on a drag", async () => {
    net.calls.length = 0;
    const actions = driveHook([ON_COURT_A]);
    await actions().moveCard("f1", AT, "crt-b");

    const patch = net.calls.find((c) => c.options?.method === "PATCH");
    expect(patch).toBeDefined();
    const json = patch!.options?.json as Record<string, unknown>;
    expect(json).not.toHaveProperty("court_label");
    expect(json.court_id).toBe("crt-b");
  });
});
