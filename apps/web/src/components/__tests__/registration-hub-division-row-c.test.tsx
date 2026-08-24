// TEMP(RS004 variants) — Row design C: "Capacity-forward card". See
// registration-hub-division-row-c.tsx's header for the design rationale.
// Same leaner-than-variant-A shape as registration-hub-division-row-b.test.tsx
// — shared derivations are proven elsewhere; this file proves the RS004
// dispatch's required constraints plus this variant's own signature claim:
// a headline capacity figure plus a bar whose COLOUR escalates as a
// division nears capacity (purple -> amber -> rose), which is the thing
// that makes "capacity foregrounded" a real, falsifiable design decision
// rather than a re-styled variant A.
import { describe, expect, it, vi } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubDivisionRowC } from "@/components/registration-hub-division-row-c";
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

function fillEl(tree: ReturnType<typeof walk>) {
  return tree.find((e) => typeof propsOf(e).className === "string" && (propsOf(e).className as string).includes("rounded-full") && propsOf(e).style !== undefined);
}

describe("RegistrationHubDivisionRowC — identity", () => {
  it("carries the same data hooks as variant A", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: BASE_ROW, context: BASE_CONTEXT }));
    const props = propsOf(tree[0]!);
    expect(props).toHaveProperty("data-registration-hub-row");
    expect(props["data-division-id"]).toBe("div-1");
    expect(textOf(tree)).toContain("Open Singles");
  });

  it("carries the status data-hook with the derived value", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, enabled: false }, context: BASE_CONTEXT }));
    const pill = tree.find((e) => propsOf(e)["data-registration-hub-status"] !== undefined);
    expect(propsOf(pill!)["data-registration-hub-status"]).toBe("closed");
  });
});

describe("RegistrationHubDivisionRowC — headline capacity figure (the design claim)", () => {
  it("renders the derived percent as a large headline figure when capacity is set", () => {
    const text = textOf(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, taken: 5, capacity: 20 }, context: BASE_CONTEXT }));
    expect(text).toContain("25%");
  });

  it("renders the raw count as the headline figure when uncapped (no percent to show)", () => {
    const text = textOf(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, taken: 12, capacity: null }, context: BASE_CONTEXT }));
    expect(text).toContain("12");
    expect(text).not.toContain("%");
  });
});

describe("RegistrationHubDivisionRowC — capacity bar colour escalates near/at capacity", () => {
  it("healthy (50%): purple bar", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, taken: 10, capacity: 20 }, context: BASE_CONTEXT }));
    const fill = fillEl(tree)!;
    expect(propsOf(fill).style).toEqual({ width: "50%" });
    expect(propsOf(fill).className).toContain("bg-purple-500");
  });

  it("near capacity (85%): amber bar, not purple", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, taken: 17, capacity: 20 }, context: BASE_CONTEXT }));
    const fill = fillEl(tree)!;
    expect(propsOf(fill).style).toEqual({ width: "85%" });
    expect(propsOf(fill).className).toContain("bg-amber-500");
    expect(propsOf(fill).className).not.toContain("bg-purple-500");
  });

  it("at/over capacity (100%): rose bar, not amber or purple", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, taken: 25, capacity: 20 }, context: BASE_CONTEXT }));
    const fill = fillEl(tree)!;
    expect(propsOf(fill).style).toEqual({ width: "100%" });
    expect(propsOf(fill).className).toContain("bg-rose-500");
    expect(propsOf(fill).className).not.toContain("bg-amber-500");
    expect(propsOf(fill).className).not.toContain("bg-purple-500");
  });

  it("renders no fill bar when capacity is null — nothing to bind a width or tone to", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, taken: 12, capacity: null }, context: BASE_CONTEXT }));
    expect(fillEl(tree)).toBeUndefined();
  });
});

describe("RegistrationHubDivisionRowC — window keeps the zone label", () => {
  it("renders the window in the ORG timezone with the zone labelled", () => {
    const text = textOf(
      RegistrationHubDivisionRowC({
        row: { ...BASE_ROW, opens_at: "2026-01-15T10:00:00Z", closes_at: null },
        context: { ...BASE_CONTEXT, orgTz: "Asia/Kolkata" },
      }),
    );
    expect(text).toContain("15 Jan 2026, 15:30");
    expect(text).toContain("IST");
  });
});

describe("RegistrationHubDivisionRowC — Configure affordance, same contract as variant A", () => {
  it("calls context.onOpen with THIS row's division id", () => {
    const onOpen = vi.fn();
    const tree = walk(
      RegistrationHubDivisionRowC({ row: { ...BASE_ROW, division_id: "div-9" }, context: { ...BASE_CONTEXT, onOpen } }),
    );
    const btn = tree.find((e) => propsOf(e)["data-registration-hub-row-configure"] !== undefined);
    (propsOf(btn!).onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith("div-9");
  });

  it("gives the button an accessible name naming the division", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, name: "Open Doubles" }, context: BASE_CONTEXT }));
    const btn = tree.find((e) => propsOf(e)["data-registration-hub-row-configure"] !== undefined);
    expect(propsOf(btn!)["aria-label"]).toBe(t(uiEn, "reg.hub.row.configure", { name: "Open Doubles" }));
  });
});

describe("RegistrationHubDivisionRowC — the copy control is never dropped", () => {
  it("renders CopyLink with the same path/label as variant A when not private", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: BASE_ROW, context: { ...BASE_CONTEXT, showRegisterLink: true } }));
    const link = tree.find((e) => e.type === CopyLink);
    expect(link).toBeTruthy();
    expect(propsOf(link!).path).toBe(BASE_CONTEXT.registerHref);
    expect(propsOf(link!).label).toBe(t(uiEn, "div.registrations.publicLink.title"));
  });

  it("renders the private notice instead, with no copy link, when private", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: BASE_ROW, context: { ...BASE_CONTEXT, showRegisterLink: false } }));
    expect(tree.some((e) => e.type === CopyLink)).toBe(false);
    expect(textOf(tree)).toContain(t(uiEn, "div.registrations.privateNotice"));
  });
});

describe("RegistrationHubDivisionRowC — badges and dash fallbacks", () => {
  it("null category renders as Open, never the literal word null", () => {
    const text = textOf(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, category: null }, context: BASE_CONTEXT }));
    expect(text).toContain(t(uiEn, "reg.hub.row.category.open"));
    expect(text.toLowerCase()).not.toContain("null");
  });

  it("shows the free-agent badge when allowed, omits it when not", () => {
    const shown = textOf(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, allow_free_agents: true }, context: BASE_CONTEXT }));
    expect(shown).toContain(t(uiEn, "reg.hub.row.freeAgents"));
    const hidden = textOf(RegistrationHubDivisionRowC({ row: { ...BASE_ROW, allow_free_agents: false }, context: BASE_CONTEXT }));
    expect(hidden).not.toContain(t(uiEn, "reg.hub.row.freeAgents"));
  });

  it("always carries the registration.paid feature seam on the fee cell, ungated", () => {
    const tree = walk(RegistrationHubDivisionRowC({ row: BASE_ROW, context: BASE_CONTEXT }));
    expect(tree.some((e) => propsOf(e)["data-feature"] === "registration.paid")).toBe(true);
  });
});
