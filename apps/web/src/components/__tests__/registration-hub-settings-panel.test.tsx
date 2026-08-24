// RS004 W3/W3c — the Settings tab panel: an empty-frame (no divisions yet,
// unchanged from W2) or a list of division rows, plus (W3c) the state for
// "which row's config panel is open" and mounting RegistrationHubConfigPanel
// for it. Stateful now (useState), so driven through the repo's hook
// harness rather than called as a plain function.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import { RegistrationHubConfigPanel } from "@/components/registration-hub-config-panel";
import {
  RegistrationHubDivisionRow,
  type RegistrationHubRowData,
  type RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";
// TEMP(RS004 variants) — sign-off scaffold components, see
// registration-hub-variant.ts's header. Deleted alongside it.
import { RegistrationHubDivisionRowB } from "@/components/registration-hub-division-row-b";
import { RegistrationHubDivisionRowC } from "@/components/registration-hub-division-row-c";
import { RegistrationHubConfigPanelB } from "@/components/registration-hub-config-panel-b";
import { RegistrationHubConfigPanelC } from "@/components/registration-hub-config-panel-c";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh }),
}));

const title = t(uiEn, "reg.hub.settings.title");
const body = t(uiEn, "reg.hub.settings.body");

const CONTEXT: Omit<RegistrationHubRowContext, "onOpen"> = {
  dict: uiEn,
  now: new Date("2026-06-15T12:00:00Z"),
  orgTz: "UTC",
  currency: "usd",
  registerHref: "/shared/riverside/summer-league/register",
  registerQrFileName: "register-summer-league.png",
  showRegisterLink: true,
};

const ROW: RegistrationHubRowData = {
  division_id: "div-1",
  name: "Open Singles",
  category: null,
  age_min: null,
  age_max: null,
  enabled: true,
  entrant_kind: "individual",
  opens_at: null,
  closes_at: null,
  capacity: null,
  fee_cents: 0,
  approval: "auto",
  allow_free_agents: false,
  taken: 0,
};

const BASE_PROPS = {
  title,
  body,
  rows: [ROW, { ...ROW, division_id: "div-2", name: "Open Doubles" }],
  context: CONTEXT,
  orgSlug: "riverside",
  feePercentPct: 8,
  cardUnsupportedCurrency: null,
};

beforeEach(() => {
  nav.refresh.mockClear();
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
    // The populated root is now a Fragment (a sibling slot is needed for the
    // config panel), so the marker lives on the <ul> rather than tree()[0].
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    const list = island.tree().find((e) => e.type === "ul")!;
    expect(propsOf(list)).toHaveProperty("data-registration-hub-settings-panel");
  });

  it("mounts no config panel until a row is opened", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    expect(island.tree().some((e) => e.type === RegistrationHubConfigPanel)).toBe(false);
  });
});

describe("RegistrationHubSettingsPanel — opening/closing/saving the config panel (W3c)", () => {
  it("clicking a row's onOpen mounts the config panel for THAT division", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    const rows = island.tree().filter((e) => e.type === RegistrationHubDivisionRow);
    (propsOf(rows[1]!).context as RegistrationHubRowContext).onOpen("div-2");
    const panel = island.tree().find((e) => e.type === RegistrationHubConfigPanel);
    expect(panel).toBeTruthy();
    expect(propsOf(panel!).division).toMatchObject({ division_id: "div-2", name: "Open Doubles" });
  });

  it("passes orgTz/currency/orgSlug/feePercentPct/cardUnsupportedCurrency through to the config panel", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, {
      ...BASE_PROPS,
      context: { ...CONTEXT, orgTz: "Asia/Kolkata", currency: "inr" as const },
      feePercentPct: 5,
      cardUnsupportedCurrency: "jpy",
    });
    (propsOf(island.tree().find((e) => e.type === RegistrationHubDivisionRow)!).context as RegistrationHubRowContext).onOpen(
      "div-1",
    );
    const panel = island.tree().find((e) => e.type === RegistrationHubConfigPanel)!;
    expect(propsOf(panel)).toMatchObject({
      orgTz: "Asia/Kolkata",
      orgSlug: "riverside",
      currency: "inr",
      feePercentPct: 5,
      cardUnsupportedCurrency: "jpy",
    });
  });

  it("opening a different row switches which division's panel is mounted (only one at a time)", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    const context1 = propsOf(island.tree().filter((e) => e.type === RegistrationHubDivisionRow)[0]!)
      .context as RegistrationHubRowContext;
    context1.onOpen("div-1");
    let panels = island.tree().filter((e) => e.type === RegistrationHubConfigPanel);
    expect(panels).toHaveLength(1);
    expect(propsOf(panels[0]!).division).toMatchObject({ division_id: "div-1" });

    const context2 = propsOf(island.tree().filter((e) => e.type === RegistrationHubDivisionRow)[1]!)
      .context as RegistrationHubRowContext;
    context2.onOpen("div-2");
    panels = island.tree().filter((e) => e.type === RegistrationHubConfigPanel);
    expect(panels).toHaveLength(1);
    expect(propsOf(panels[0]!).division).toMatchObject({ division_id: "div-2" });
  });

  it("onClose unmounts the panel without refreshing the router", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    (propsOf(island.tree().find((e) => e.type === RegistrationHubDivisionRow)!).context as RegistrationHubRowContext).onOpen(
      "div-1",
    );
    const panel = island.tree().find((e) => e.type === RegistrationHubConfigPanel)!;
    (propsOf(panel).onClose as () => void)();
    expect(island.tree().some((e) => e.type === RegistrationHubConfigPanel)).toBe(false);
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("onSaved unmounts the panel AND refreshes the router so the row reflects what was saved", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    (propsOf(island.tree().find((e) => e.type === RegistrationHubDivisionRow)!).context as RegistrationHubRowContext).onOpen(
      "div-1",
    );
    const panel = island.tree().find((e) => e.type === RegistrationHubConfigPanel)!;
    (propsOf(panel).onSaved as () => void)();
    expect(island.tree().some((e) => e.type === RegistrationHubConfigPanel)).toBe(false);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

// TEMP(RS004 variants) — the sign-off scaffold's row/panel switch. See
// registration-hub-variant.ts's header comment for the full explanation;
// deleted alongside every other TEMP(RS004 variants) file/edit once the
// owner picks a direction.
describe("RegistrationHubSettingsPanel — variant switch (TEMP(RS004 variants))", () => {
  it("defaults to variant A's row/panel components when `variant` is omitted", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, BASE_PROPS);
    const rows = island.tree().filter((e) => e.type === RegistrationHubDivisionRow);
    expect(rows).toHaveLength(2);
    (propsOf(rows[0]!).context as RegistrationHubRowContext).onOpen("div-1");
    expect(island.tree().some((e) => e.type === RegistrationHubConfigPanel)).toBe(true);
  });

  it("variant b renders RegistrationHubDivisionRowB, and opening a row mounts RegistrationHubConfigPanelB", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, { ...BASE_PROPS, variant: "b" });
    const rows = island.tree().filter((e) => e.type === RegistrationHubDivisionRowB);
    expect(rows).toHaveLength(2);
    expect(island.tree().some((e) => e.type === RegistrationHubDivisionRow)).toBe(false);

    (propsOf(rows[0]!).context as RegistrationHubRowContext).onOpen("div-1");
    const panel = island.tree().find((e) => e.type === RegistrationHubConfigPanelB);
    expect(panel).toBeTruthy();
    expect(propsOf(panel!).division).toMatchObject({ division_id: "div-1" });
    expect(island.tree().some((e) => e.type === RegistrationHubConfigPanel)).toBe(false);
  });

  it("variant c renders RegistrationHubDivisionRowC, and opening a row mounts RegistrationHubConfigPanelC", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, { ...BASE_PROPS, variant: "c" });
    const rows = island.tree().filter((e) => e.type === RegistrationHubDivisionRowC);
    expect(rows).toHaveLength(2);

    (propsOf(rows[0]!).context as RegistrationHubRowContext).onOpen("div-1");
    const panel = island.tree().find((e) => e.type === RegistrationHubConfigPanelC);
    expect(panel).toBeTruthy();
    expect(propsOf(panel!).division).toMatchObject({ division_id: "div-1" });
  });

  it("variant a (explicit) is identical to omitting it — the row/panel components used today", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, { ...BASE_PROPS, variant: "a" });
    expect(island.tree().filter((e) => e.type === RegistrationHubDivisionRow)).toHaveLength(2);
  });

  it("still threads the same row/context data to variant B's rows as variant A's", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, { ...BASE_PROPS, variant: "b" });
    const row = island.tree().find((e) => e.type === RegistrationHubDivisionRowB)!;
    expect(propsOf(row).row).toMatchObject({ division_id: "div-1" });
    expect(propsOf(row).context).toMatchObject(CONTEXT);
  });

  it("still passes orgTz/currency/orgSlug/feePercentPct/cardUnsupportedCurrency to variant C's panel", () => {
    const island = renderIsland(RegistrationHubSettingsPanel, {
      ...BASE_PROPS,
      variant: "c",
      context: { ...CONTEXT, orgTz: "Asia/Kolkata", currency: "inr" as const },
      feePercentPct: 5,
      cardUnsupportedCurrency: "jpy",
    });
    const row = island.tree().find((e) => e.type === RegistrationHubDivisionRowC)!;
    (propsOf(row).context as RegistrationHubRowContext).onOpen("div-1");
    const panel = island.tree().find((e) => e.type === RegistrationHubConfigPanelC)!;
    expect(propsOf(panel)).toMatchObject({
      orgTz: "Asia/Kolkata",
      orgSlug: "riverside",
      currency: "inr",
      feePercentPct: 5,
      cardUnsupportedCurrency: "jpy",
    });
  });
});
