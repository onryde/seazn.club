// Scorer sheets §4.4 — the schedule page's `printable` guard and what it hands
// the print control. Printing mints scoring links, so only an editor on a
// competition that is not billing-frozen (D8) sees the control; the day list
// is only read for them; the device-links gate is asked for THIS competition
// (an Event Pass lifts one competition — pass-scoping-guard's rule); and the
// default day is "today" on the ORG clock, never the machine's.
//
// Same technique as venues-prop.test.tsx beside it (no jsdom): call the server
// component and walk the returned element tree. That proves the WIRING — a
// prop handed straight to the component in its own test would pass even if
// the page never threaded it through.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const state = vi.hoisted(() => ({
  canEdit: true,
  frozen: false,
  deviceLinks: true,
  orgTz: "Europe/London",
}));
const sheets = vi.hoisted(() => ({ listSheetDays: vi.fn(async (): Promise<string[]> => ["2026-09-23"]) }));
const ent = vi.hoisted(() => ({
  // (orgId, featureKey, competitionId?) — lib/entitlements.ts's signature.
  hasFeature: vi.fn(async (...args: [string, string, string?]) =>
    args[1] === "scoring.device_links" ? state.deviceLinks : true,
  ),
  orgPlanKey: vi.fn(async () => "community"),
}));

vi.mock("@/server/usecases/venues", () => ({ listVenues: vi.fn(async () => []) }));
vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: vi.fn(async () => ({
    auth: { orgId: "org-1", userId: "user-1", role: "owner" },
    canEdit: state.canEdit,
    org: { id: "org-1", slug: "org", name: "Org One", role: "owner", timezone: state.orgTz },
    competition: { id: "comp-1", slug: "comp" },
  })),
}));
vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: vi.fn(async () => ({
    id: "comp-1",
    name: "Comp One",
    frozen: state.frozen,
    starts_on: "2026-09-01",
    ends_on: "2026-09-30",
  })),
}));
vi.mock("@/server/usecases/divisions", () => ({
  listDivisions: vi.fn(async () => [
    { id: "div-1", name: "Div One", slug: "div-one", status: "active", seq: 1, schedule_locked: false },
  ]),
}));
vi.mock("@/server/usecases/stages", () => ({ listStages: vi.fn(async () => []) }));
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixturesForBoard: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: { courts: [] }, tz: "Europe/London" })),
}));
vi.mock("@/server/usecases/scorer-sheets", () => sheets);
vi.mock("@/lib/entitlements", () => ent);
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "usd") }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: vi.fn(async () => "en") }));

const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
}));

import CompetitionSchedulePage from "../page";
import { PrintScorerSheets } from "@/components/v2/print-scorer-sheets";
import { ScheduleBoard } from "@/components/v2/schedule-board";

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

type PrintProps = Parameters<typeof PrintScorerSheets>[0];
const printProps = (el: ReactElement | null) => el?.props as PrintProps;

const renderPage = () =>
  CompetitionSchedulePage({ params: Promise.resolve({ orgSlug: "org", compSlug: "comp" }) });

beforeEach(() => {
  Object.assign(state, { canEdit: true, frozen: false, deviceLinks: true, orgTz: "Europe/London" });
  sheets.listSheetDays.mockClear().mockImplementation(async () => ["2026-09-23"]);
  ent.hasFeature.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("schedule page — the scorer-sheets print control (§4.4)", () => {
  it("an editor on a live competition gets the print control, opening at the default day", async () => {
    state.canEdit = true;
    state.frozen = false;
    const el = find(await renderPage(), PrintScorerSheets);
    expect(el).not.toBeNull();
    expect(printProps(el).defaultDay).toBe("2026-09-23");
    expect(printProps(el)).toMatchObject({
      action: "/api/v1/competitions/comp-1/exports/scorer-sheets",
      days: ["2026-09-23"],
      allowed: true,
      viewerPlan: "community",
    });
    expect(sheets.listSheetDays).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1" }), "comp-1");
  });

  it("a member who cannot edit gets no print control, and the day list is never read", async () => {
    state.canEdit = false;
    state.frozen = false;
    const tree = await renderPage();
    // Positive marker first: the page rendered its board for this viewer.
    expect(find(tree, ScheduleBoard)).not.toBeNull();
    expect(find(tree, PrintScorerSheets)).toBeNull();
    expect(sheets.listSheetDays).not.toHaveBeenCalled();
  });

  it("a billing-frozen competition gets no print control (D8)", async () => {
    state.canEdit = true;
    state.frozen = true;
    const tree = await renderPage();
    expect(find(tree, ScheduleBoard)).not.toBeNull();
    expect(find(tree, PrintScorerSheets)).toBeNull();
    expect(sheets.listSheetDays).not.toHaveBeenCalled();
  });

  it("without device links for THIS competition the control is handed allowed=false (the upgrade gate), asked with the competition id", async () => {
    state.deviceLinks = false;
    const el = find(await renderPage(), PrintScorerSheets);
    expect(el).not.toBeNull();
    expect(printProps(el).allowed).toBe(false);
    expect(ent.hasFeature).toHaveBeenCalledWith("org-1", "scoring.device_links", "comp-1");
  });

  it("no printable day → the control is handed an empty list and no default (it renders nothing)", async () => {
    sheets.listSheetDays.mockImplementation(async () => []);
    const el = find(await renderPage(), PrintScorerSheets);
    expect(printProps(el)).toMatchObject({ days: [], defaultDay: null });
  });

  describe("'today' is the ORG's day, never the machine's", () => {
    const DAYS = ["2026-09-23", "2026-09-24", "2026-09-25"];

    it("ahead of UTC: 12:00Z on the 23rd is already the 24th in Kiritimati (UTC+14)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
      state.orgTz = "Pacific/Kiritimati";
      sheets.listSheetDays.mockImplementation(async () => DAYS);
      const el = find(await renderPage(), PrintScorerSheets);
      // The UTC date, and any machine zone short of UTC+12, still says the 23rd.
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-09-23");
      expect(printProps(el).defaultDay).toBe("2026-09-24");
    });

    it("behind UTC: 05:00Z on the 24th is still the 23rd in Pago Pago (UTC-11)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-24T05:00:00Z"));
      state.orgTz = "Pacific/Pago_Pago";
      sheets.listSheetDays.mockImplementation(async () => DAYS);
      const el = find(await renderPage(), PrintScorerSheets);
      // The UTC date, and any machine zone east of UTC-05, already says the 24th.
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-09-24");
      expect(printProps(el).defaultDay).toBe("2026-09-23");
    });

    it("a day with nothing to print is skipped: today (org clock) empty → the next day that has fixtures", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
      state.orgTz = "Pacific/Kiritimati"; // org today = the 24th
      // The machine (UTC) says the 23rd, which HAS fixtures; the org says the
      // 24th, which has none — so the org answer is the 26th, the machine's the 23rd.
      sheets.listSheetDays.mockImplementation(async () => ["2026-09-23", "2026-09-26"]);
      const el = find(await renderPage(), PrintScorerSheets);
      expect(printProps(el).defaultDay).toBe("2026-09-26");
    });
  });
});
