// RS004 W3/W3c — the Settings tab panel: an empty-frame (no divisions yet,
// unchanged from W2) or a list of division rows. B7 T24: a row's "Open
// settings" asks the hub's tab host to open the division as a tab — the panel
// no longer mounts a dialog of its own. The host's open is mocked here (its own
// behaviour is the host's tests' and the e2e's); what this file proves is that
// every row reaches it with ITS division, and that the panel refuses to render
// an editor's rows with no host to open them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import {
  RegistrationHubDivisionRow,
  type RegistrationHubRowData,
  type RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import { effectiveEntrantModel } from "@seazn/engine/sport";

// FU1 — every kind the engine knows (a sport with no entrant model takes them all). Derived, never typed here.
const ALL_KINDS = effectiveEntrantModel(null).kinds;

const host = vi.hoisted(() => ({ api: null as { openDivision: (id: string) => void } | null }));
vi.mock("@/components/registration-hub-tabs-host", () => ({ useHubTabs: () => host.api }));

const title = t(uiEn, "reg.hub.settings.title");
const body = t(uiEn, "reg.hub.settings.body");

const CONTEXT: Omit<RegistrationHubRowContext, "onOpen"> = {
  dict: uiEn,
  now: new Date("2026-06-15T12:00:00Z"),
  orgTz: "UTC",
  currency: "usd",
  registerHref: "/live/riverside/summer-league/register",
  registerQrFileName: "register-summer-league.png",
  showRegisterLink: true,
  canEdit: true,
};

const ROW: RegistrationHubRowData = {
  division_id: "div-1",
  name: "Open Singles",
  category: null,
  age_min: null,
  age_max: null,
  age_cutoff_month: 9,
  age_cutoff_day: 1,
  eligibility_note: "School-registered students only",
  enabled: true,
  entrant_kind: "individual",
  allowed_kinds: ALL_KINDS,
  opens_at: null,
  closes_at: null,
  capacity: null,
  fee_cents: 0,
  approval: "auto",
  allow_free_agents: false,
  taken: 0,
  waitlisted: 0,
};

const BASE_PROPS = {
  title,
  body,
  rows: [ROW, { ...ROW, division_id: "div-2", name: "Open Doubles" }],
  context: CONTEXT,
};

const openDivision = vi.fn();
beforeEach(() => {
  openDivision.mockClear();
  host.api = { openDivision };
});

describe("RegistrationHubSettingsPanel — empty (no divisions yet)", () => {
  it("renders the title and body it is given", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, { ...BASE_PROPS, rows: [] });
    expect(island.text()).toContain(title);
    expect(island.text()).toContain(body);
  });

  it("is a designed frame, never a literal TODO placeholder", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, { ...BASE_PROPS, rows: [] });
    expect(island.text()).not.toContain("TODO");
  });

  it("carries its own data hook for e2e/regression targeting", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, { ...BASE_PROPS, rows: [] });
    const root = island.tree()[0]!;
    expect(propsOf(root)).toHaveProperty("data-registration-hub-settings-panel");
  });
});

describe("RegistrationHubSettingsPanel — populated", () => {
  it("renders one RegistrationHubDivisionRow per division, in the given order", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    const rendered = island.tree().filter((e) => e.type === RegistrationHubDivisionRow);
    expect(rendered).toHaveLength(2);
    expect(propsOf(rendered[0]!).row).toMatchObject({ division_id: "div-1" });
    expect(propsOf(rendered[1]!).row).toMatchObject({ division_id: "div-2" });
  });

  it("threads the shared context fields to every row, plus a live onOpen callback", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    const row = island.tree().find((e) => e.type === RegistrationHubDivisionRow)!;
    expect(propsOf(row).context).toMatchObject(CONTEXT);
    expect((propsOf(row).context as RegistrationHubRowContext).onOpen).toBeInstanceOf(Function);
  });

  it("does not render the empty-frame copy once there is at least one row", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    expect(island.text()).not.toContain(body);
  });

  it("still carries the panel's own data hook when populated", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    const list = island.tree().find((e) => e.type === "ul")!;
    expect(propsOf(list)).toHaveProperty("data-registration-hub-settings-panel");
  });
});

describe("RegistrationHubSettingsPanel — Open settings opens a tab (B7 T24)", () => {
  it("each row's onOpen asks the host to open THAT row's division, once, and nothing else", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    const rows = island.tree().filter((e) => e.type === RegistrationHubDivisionRow);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const { division_id } = propsOf(row).row as RegistrationHubRowData;
      openDivision.mockClear();
      (propsOf(row).context as RegistrationHubRowContext).onOpen(division_id);
      expect(openDivision.mock.calls).toEqual([[division_id]]);
    }
  });

  it("mounts nothing of its own: no dialog, no settings page (the host owns the tabs)", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    (propsOf(island.tree().find((e) => e.type === RegistrationHubDivisionRow)!).context as RegistrationHubRowContext).onOpen(
      "div-1",
    );
    const types = new Set(island.tree().map((e) => e.type));
    // The list, its items and the rows — nothing else at the top of the panel.
    expect([...types].every((type) => type === "ul" || type === "li" || type === RegistrationHubDivisionRow)).toBe(true);
  });

  it("refuses, by name, to render an editor's rows outside a tab host — Open settings would open nothing", () => {
    host.api = null;
    expect(() => renderIsland(RegistrationHubSettingsPanel, BASE_PROPS)).toThrow(/outside RegistrationHubTabsHost/);
  });

  it("positive pair: a viewer's rows (no Open settings) and the empty frame need no host", () => {
    host.api = null;
    const viewer = renderIsland(RegistrationHubSettingsPanel, { ...BASE_PROPS, context: { ...CONTEXT, canEdit: false } });
    expect(viewer.tree().filter((e) => e.type === RegistrationHubDivisionRow)).toHaveLength(2);
    const empty = renderIsland(RegistrationHubSettingsPanel, { ...BASE_PROPS, rows: [] });
    expect(empty.text()).toContain(title);
  });
});
