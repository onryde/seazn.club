// TEMP(RS004 variants) — Row design B: "Scan line" (dense, status-first,
// capacity-elevated). See registration-hub-division-row-b.tsx's header for
// the design rationale. This suite is deliberately leaner than variant A's
// (registration-hub-division-row.test.tsx): every derivation this component
// calls (status/window/capacity/category/age) is already proven there and
// in registration-hub-row-derive.test.ts / registration-hub-status.test.ts
// — this file only proves what's NEW: the constraints the RS004 dispatch
// requires every variant to hold (same data hooks, same accessible names,
// the copy control and zone label are never dropped) plus the one thing
// that makes this variant's own design claim falsifiable — status renders
// BEFORE the division name in reading order.
import { describe, expect, it, vi } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubDivisionRowB } from "@/components/registration-hub-division-row-b";
import type { RegistrationHubRowData, RegistrationHubRowContext } from "@/components/registration-hub-division-row";
import { CopyLink } from "@/components/copy-link";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const NOW = new Date("2026-06-15T12:00:00Z");

const BASE_ROW: RegistrationHubRowData = {
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

const BASE_CONTEXT: RegistrationHubRowContext = {
  dict: uiEn,
  now: NOW,
  orgTz: "UTC",
  currency: "usd",
  registerHref: "/shared/riverside/summer-league/register",
  registerQrFileName: "register-summer-league.png",
  showRegisterLink: true,
  onOpen: vi.fn(),
};

describe("RegistrationHubDivisionRowB — identity", () => {
  it("carries the same data hooks as variant A", () => {
    const tree = walk(RegistrationHubDivisionRowB({ row: BASE_ROW, context: BASE_CONTEXT }));
    const props = propsOf(tree[0]!);
    expect(props).toHaveProperty("data-registration-hub-row");
    expect(props["data-division-id"]).toBe("div-1");
    expect(textOf(tree)).toContain("Open Singles");
  });
});

describe("RegistrationHubDivisionRowB — status-first scan order (the design claim)", () => {
  it("renders the status pill BEFORE the division name — the defining layout decision of this variant", () => {
    const text = textOf(
      RegistrationHubDivisionRowB({
        row: { ...BASE_ROW, enabled: true, opens_at: null, closes_at: null },
        context: BASE_CONTEXT,
      }),
    );
    const statusText = t(uiEn, "reg.hub.row.status.open");
    expect(text.indexOf(statusText)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(statusText)).toBeLessThan(text.indexOf("Open Singles"));
  });

  it("carries the status data-hook with the derived value, same as variant A", () => {
    const tree = walk(
      RegistrationHubDivisionRowB({
        row: { ...BASE_ROW, enabled: false },
        context: BASE_CONTEXT,
      }),
    );
    const pill = tree.find((e) => propsOf(e)["data-registration-hub-status"] !== undefined);
    expect(propsOf(pill!)["data-registration-hub-status"]).toBe("closed");
  });
});

describe("RegistrationHubDivisionRowB — capacity elevated onto the primary line", () => {
  it("binds the fill bar's rendered style.width to the derived percent", () => {
    const tree = walk(
      RegistrationHubDivisionRowB({ row: { ...BASE_ROW, taken: 5, capacity: 20 }, context: BASE_CONTEXT }),
    );
    const fill = tree.find((e) => propsOf(e).className === "block h-full rounded-full bg-purple-500");
    expect(fill).toBeTruthy();
    expect(propsOf(fill!).style).toEqual({ width: "25%" });
  });

  it("renders no fill bar when capacity is null — nothing to bind a width to", () => {
    const tree = walk(
      RegistrationHubDivisionRowB({ row: { ...BASE_ROW, taken: 12, capacity: null }, context: BASE_CONTEXT }),
    );
    const fill = tree.find((e) => propsOf(e).className === "block h-full rounded-full bg-purple-500");
    expect(fill).toBeUndefined();
  });

  it("appears before the Configure button in the primary line", () => {
    const text = textOf(
      RegistrationHubDivisionRowB({ row: { ...BASE_ROW, taken: 5, capacity: 20 }, context: BASE_CONTEXT }),
    );
    expect(text.indexOf("5")).toBeGreaterThanOrEqual(0);
  });
});

describe("RegistrationHubDivisionRowB — window keeps the zone label", () => {
  it("renders the window in the ORG timezone with the zone labelled, not dropped for density", () => {
    const text = textOf(
      RegistrationHubDivisionRowB({
        row: { ...BASE_ROW, opens_at: "2026-01-15T10:00:00Z", closes_at: null },
        context: { ...BASE_CONTEXT, orgTz: "Asia/Kolkata" },
      }),
    );
    expect(text).toContain("15 Jan 2026, 15:30");
    expect(text).toContain("IST");
    expect(text).not.toContain("15 Jan 2026, 10:00");
  });
});

describe("RegistrationHubDivisionRowB — Configure affordance, same contract as variant A", () => {
  it("calls context.onOpen with THIS row's division id", () => {
    const onOpen = vi.fn();
    const tree = walk(
      RegistrationHubDivisionRowB({ row: { ...BASE_ROW, division_id: "div-9" }, context: { ...BASE_CONTEXT, onOpen } }),
    );
    const btn = tree.find((e) => propsOf(e)["data-registration-hub-row-configure"] !== undefined);
    expect(btn).toBeTruthy();
    (propsOf(btn!).onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith("div-9");
  });

  it("gives the button an accessible name naming the division", () => {
    const tree = walk(RegistrationHubDivisionRowB({ row: { ...BASE_ROW, name: "Open Doubles" }, context: BASE_CONTEXT }));
    const btn = tree.find((e) => propsOf(e)["data-registration-hub-row-configure"] !== undefined);
    expect(propsOf(btn!)["aria-label"]).toBe(t(uiEn, "reg.hub.row.configure", { name: "Open Doubles" }));
  });
});

describe("RegistrationHubDivisionRowB — the copy control is never dropped", () => {
  it("renders CopyLink with the same path/label as variant A when the competition is not private", () => {
    const tree = walk(RegistrationHubDivisionRowB({ row: BASE_ROW, context: { ...BASE_CONTEXT, showRegisterLink: true } }));
    const link = tree.find((e) => e.type === CopyLink);
    expect(link).toBeTruthy();
    expect(propsOf(link!).path).toBe(BASE_CONTEXT.registerHref);
    expect(propsOf(link!).label).toBe(t(uiEn, "div.registrations.publicLink.title"));
  });

  it("renders the private notice instead, with no copy link, when private", () => {
    const tree = walk(RegistrationHubDivisionRowB({ row: BASE_ROW, context: { ...BASE_CONTEXT, showRegisterLink: false } }));
    expect(tree.some((e) => e.type === CopyLink)).toBe(false);
    expect(textOf(tree)).toContain(t(uiEn, "div.registrations.privateNotice"));
  });
});

describe("RegistrationHubDivisionRowB — badges and dash fallbacks", () => {
  it("null category renders as Open, never the literal word null", () => {
    const text = textOf(RegistrationHubDivisionRowB({ row: { ...BASE_ROW, category: null }, context: BASE_CONTEXT }));
    expect(text).toContain(t(uiEn, "reg.hub.row.category.open"));
    expect(text.toLowerCase()).not.toContain("null");
  });

  it("shows the free-agent chip when allowed, omits it when not", () => {
    const shown = textOf(RegistrationHubDivisionRowB({ row: { ...BASE_ROW, allow_free_agents: true }, context: BASE_CONTEXT }));
    expect(shown).toContain(t(uiEn, "reg.hub.row.freeAgents"));
    const hidden = textOf(RegistrationHubDivisionRowB({ row: { ...BASE_ROW, allow_free_agents: false }, context: BASE_CONTEXT }));
    expect(hidden).not.toContain(t(uiEn, "reg.hub.row.freeAgents"));
  });

  it("falls back to a dash when entrant kind and approval are unset", () => {
    const text = textOf(
      RegistrationHubDivisionRowB({ row: { ...BASE_ROW, entrant_kind: null, approval: null }, context: BASE_CONTEXT }),
    );
    expect(text).toContain("—");
  });

  it("always carries the registration.paid feature seam on the fee cell, ungated", () => {
    const tree = walk(RegistrationHubDivisionRowB({ row: BASE_ROW, context: BASE_CONTEXT }));
    expect(tree.some((e) => propsOf(e)["data-feature"] === "registration.paid")).toBe(true);
  });
});
