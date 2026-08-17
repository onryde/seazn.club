// P6 fix round 2 — coordinator's finding #1: the officials-tab fixture
// picker (page.tsx:319-329) was reverted from msgFor(locale, …) back to
// hardcoded English msg() (fix round 1's predecessor commit) specifically
// to unbreak officials-loads-deferred.test.tsx, whose direct-invocation
// `renderTab` helper has no real Next request scope for resolveLocale()'s
// cookies() call to read. That deleted localization on a surface the plan's
// IN list names explicitly ("org schedule page") — the same defect class
// as finding #2, reintroduced to satisfy a test rather than fixing the test.
//
// resolve-locale.ts now catches cookies()/headers() failing (see its own
// header comment) so the ORIGINAL test needs no changes at all — this is a
// SEPARATE file specifically to prove the restored localization actually
// works when a real locale IS available, which officials-loads-deferred.
// test.tsx's own mocks never provide (it has no next/headers mock and no
// TBD-with-a-label fixture). Same no-jsdom / direct-invocation convention.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const spies = vi.hoisted(() => ({
  listOfficialsForConsole: vi.fn(),
  listOfficialBlackouts: vi.fn(),
  listOfficialBusyElsewhere: vi.fn(),
}));

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));

// Configurable per-test — default (undefined) reads as "no switcher cookie",
// matching a first-time visitor; set to "es" to prove the locale actually
// drives the rendered text, not just that resolveLocale() no longer throws.
const localeCookie = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "seazn_locale" && localeCookie.value ? { name, value: localeCookie.value } : undefined,
  }),
  headers: async () => ({ get: () => null }),
}));

const divisionPage = () => ({
  auth: { orgId: "org-1", userId: "user-1", role: "owner" },
  canEdit: true,
  division: { id: "div-1" },
  org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: "Europe/London" },
});

vi.mock("@/server/usecases/officials", () => spies);
vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1", name: "Div One", slug: "div-one", status: "active", seq: 1,
    schedule_locked: false, sport_key: "badminton", officials_hide_names: false,
    competition_id: "comp-1",
  })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({
    id: "comp-1", frozen: false, starts_on: "2026-09-01", ends_on: "2026-09-30",
  })),
}));
vi.mock("@/server/usecases/stages", () => ({ listStages: vi.fn(async () => []) }));
// The one TBD fixture the officials tab has to pick a label for: both
// entrants unfilled, real V360/V361 slot.winner_group descriptors — the
// exact shape a KO final carries before the group stage decides who plays.
// Both readers return the SAME row. The board tab reads through the narrower
// listDivisionFixturesForBoard projection (F1 — it omits the five bracket
// round-role columns the board never renders) while the officials tab reads
// the full row; this test is about slot-label locale resolution, which both
// paths must do identically. Mocking only one leaves the page importing a
// name the factory does not export, which vitest rejects at module load.
// The row is repeated rather than lifted to a const: vi.mock is hoisted above
// every declaration in this file, so a factory closing over a const would
// throw on module load.
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => [
    {
      id: "fx-1",
      home_entrant_id: null,
      away_entrant_id: null,
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
      scheduled_at: null,
      status: "scheduled",
      officials: [],
    },
  ]),
  listDivisionFixturesForBoard: vi.fn(async () => [
    {
      id: "fx-1",
      home_entrant_id: null,
      away_entrant_id: null,
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
      scheduled_at: null,
      status: "scheduled",
      officials: [],
    },
  ]),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "Europe/London" })),
}));
vi.mock("@/lib/entitlements", () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "GBP") }));

const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));

import DivisionSchedulePage from "../page";
import { OfficialsPanel } from "@/components/v2/officials-panel";

function find(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return find((node.props as { children?: ReactNode }).children, type);
}

const renderOfficialsTab = () =>
  DivisionSchedulePage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab: "officials" }),
  });

describe("officials-tab fixture picker resolves slot labels via resolveLocale() (P6 fix round 2)", () => {
  beforeEach(() => {
    spies.listOfficialsForConsole.mockReset().mockResolvedValue([]);
    spies.listOfficialBlackouts.mockReset().mockResolvedValue([]);
    spies.listOfficialBusyElsewhere.mockReset().mockResolvedValue([]);
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(divisionPage());
    localeCookie.value = undefined;
  });

  it("does not throw outside a real request scope (the exact defect that made the predecessor commit revert this)", async () => {
    await expect(renderOfficialsTab()).resolves.toBeDefined();
  });

  it("no switcher cookie -> resolves to the English default (DEFAULT_LOCALE, not a crash)", async () => {
    const panel = find(await renderOfficialsTab(), OfficialsPanel);
    const label = (panel!.props as { fixtures: { label: string }[] }).fixtures[0]!.label;
    expect(label).toBe("Winner of Group A vs Winner of Group B");
  });

  // The test that fails without the fix: before this round, the picker was
  // hardcoded to the client-safe English msg() regardless of ANY locale
  // signal, so this would still read "Winner of Group A vs Winner of Group
  // B" even with the switcher cookie set to Spanish.
  it("seazn_locale=es -> resolves the SAME fixture's label in Spanish", async () => {
    localeCookie.value = "es";
    const panel = find(await renderOfficialsTab(), OfficialsPanel);
    const label = (panel!.props as { fixtures: { label: string }[] }).fixtures[0]!.label;
    expect(label).toBe("Ganador del Grupo A vs Ganador del Grupo B");
  });
});
