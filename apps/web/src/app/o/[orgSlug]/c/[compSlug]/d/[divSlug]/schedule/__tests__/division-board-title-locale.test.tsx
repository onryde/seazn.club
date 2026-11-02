// Match Day PB1 item 1: the division schedule board's <h1> was the hardcoded
// English `Schedule — {name}` in every locale. It is the dictionary key
// `schedule.divisionTitle` now, and it is the SAME title on every tab (the
// locale used to be resolved on the officials tab only).
//
// Direct-invocation page test (no jsdom), the rig officials-fixture-locale
// uses: the switcher cookie drives resolveLocale(), the expected text is read
// out of each locale's own dictionary — never typed here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

const pageAuth = vi.hoisted(() => ({ requireDivisionPage: vi.fn() }));
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

vi.mock("@/server/usecases/officials", () => ({
  listOfficialsForConsole: vi.fn(async () => []),
  listOfficialBlackouts: vi.fn(async () => []),
  listOfficialBusyElsewhere: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/venues", () => ({ listVenues: vi.fn(async () => []) }));
vi.mock("@/server/page-auth", () => pageAuth);
vi.mock("@/server/usecases/divisions", () => ({
  getDivision: vi.fn(async () => ({
    id: "div-1", name: "Under-12 Boys", slug: "u12", status: "active", seq: 1,
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
vi.mock("@/server/usecases/fixtures", () => ({
  listDivisionFixtures: vi.fn(async () => []),
  listDivisionFixturesForBoard: vi.fn(async () => []),
}));
vi.mock("@/server/usecases/entrants", () => ({ listEntrants: vi.fn(async () => []) }));
vi.mock("@/server/usecases/schedule", () => ({
  getScheduleSettings: vi.fn(async () => ({ config: {}, tz: "Europe/London" })),
}));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: vi.fn(async () => true),
  orgPlanKey: vi.fn(async () => "community"),
}));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: vi.fn(async () => "GBP") }));

const tx = () => Promise.resolve([]);
vi.mock("@/lib/db", () => ({
  sql: () => Promise.resolve([]),
  withTenant: (_orgId: string, fn: (t: unknown) => unknown) => fn(tx),
  statementCount: () => 0,
}));

import DivisionSchedulePage from "../page";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

const DICTS = { en: enUi, es: esUi, fr: frUi, nl: nlUi } as Record<string, Record<string, string>>;
const KEY = "schedule.divisionTitle";
const DIVISION = "Under-12 Boys";
// The seven tabs the page declares (page.tsx `TABS`).
const TABS = ["board", "health", "settings", "courts", "constraints", "officials", "history"];

/** The text of the first <h1> under the node (children flattened to strings). */
function h1Text(node: ReactNode): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = h1Text(child as ReactNode);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === "h1") return flatten(el.props.children);
  return h1Text(el.props.children);
}
function flatten(n: ReactNode): string {
  if (Array.isArray(n)) return n.map(flatten).join("");
  return typeof n === "string" || typeof n === "number" ? String(n) : "";
}

const render = (tab: string) =>
  DivisionSchedulePage({
    params: Promise.resolve({ orgSlug: "org", compSlug: "comp", divSlug: "div" }),
    searchParams: Promise.resolve({ tab }),
  });

describe("PB1 item 1: the division board title is a dictionary string in every locale, on every tab", () => {
  beforeEach(() => {
    pageAuth.requireDivisionPage.mockReset().mockResolvedValue(divisionPage());
    localeCookie.value = undefined;
  });

  it("premise: every locale authors the key with a {name} slot, and the three non-English ones differ from English", () => {
    for (const [loc, dict] of Object.entries(DICTS)) {
      expect(dict[KEY], `${loc} has ${KEY}`).toContain("{name}");
    }
    for (const loc of ["es", "fr", "nl"]) {
      expect(DICTS[loc]![KEY], `${loc} is translated`).not.toBe(enUi[KEY as keyof typeof enUi]);
    }
  });

  it("sweep locale x tab: the <h1> is the locale's own string with the division name filled in", async () => {
    let checked = 0;
    for (const loc of Object.keys(DICTS)) {
      for (const tab of TABS) {
        localeCookie.value = loc === "en" ? undefined : loc;
        const text = h1Text(await render(tab));
        const want = DICTS[loc]![KEY]!.replace("{name}", DIVISION);
        expect(text, `${loc} / ${tab}`).toBe(want);
        checked++;
      }
    }
    // Anti-vacuity: 4 locales x 7 tabs, none skipped.
    expect(checked).toBe(Object.keys(DICTS).length * TABS.length);
    expect(checked).toBe(28);
  });

  it("no switcher cookie -> English (the default), never a missing-key echo", async () => {
    const text = h1Text(await render("board"));
    expect(text).toBe(`Schedule — ${DIVISION}`);
    expect(text).not.toContain(KEY);
  });
});
