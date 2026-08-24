// RS004 W3 — the Settings tab's per-division row: status pill, window
// (org tz), capacity meter, fee, entrant kind, category/age badges,
// approval mode, free-agent flag, and the public register link/private
// notice. The row's click-to-open config panel is a later wave — this only
// covers the read surface.
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import {
  RegistrationHubDivisionRow,
  type RegistrationHubRowData,
  type RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";
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
};

function textFor(row: Partial<RegistrationHubRowData>, context: Partial<RegistrationHubRowContext> = {}) {
  return textOf(
    RegistrationHubDivisionRow({
      row: { ...BASE_ROW, ...row },
      context: { ...BASE_CONTEXT, ...context },
    }),
  );
}

describe("RegistrationHubDivisionRow — identity", () => {
  it("carries the division name and a data hook for e2e/regression targeting", () => {
    const root = RegistrationHubDivisionRow({ row: BASE_ROW, context: BASE_CONTEXT });
    const tree = walk(root);
    const props = propsOf(tree[0]!);
    expect(props).toHaveProperty("data-registration-hub-row");
    expect(props["data-division-id"]).toBe("div-1");
    expect(textOf(root)).toContain("Open Singles");
  });
});

describe("RegistrationHubDivisionRow — status pill", () => {
  it("open now", () => {
    const text = textFor({ enabled: true, opens_at: null, closes_at: null });
    expect(text).toContain(t(uiEn, "reg.hub.row.status.open"));
  });

  it("scheduled — window not yet open", () => {
    const text = textFor({ enabled: true, opens_at: "2026-07-01T00:00:00Z", closes_at: null });
    expect(text).toContain(t(uiEn, "reg.hub.row.status.scheduled"));
  });

  it("closed — window has passed", () => {
    const text = textFor({
      enabled: true,
      opens_at: "2026-05-01T00:00:00Z",
      closes_at: "2026-06-01T00:00:00Z",
    });
    expect(text).toContain(t(uiEn, "reg.hub.row.status.closed"));
  });
});

describe("RegistrationHubDivisionRow — window (org timezone, zone labelled)", () => {
  // Same hand-verified instant as registration-hub-row-derive.test.ts:
  // 2026-01-15T10:00:00Z in Asia/Kolkata (UTC+5:30) is 15:30 local, "IST".
  it("renders the window in the ORG timezone, not UTC/browser-local, with the zone labelled", () => {
    const text = textFor(
      { opens_at: "2026-01-15T10:00:00Z", closes_at: null },
      { orgTz: "Asia/Kolkata" },
    );
    expect(text).toContain("15 Jan 2026, 15:30");
    expect(text).toContain("IST");
    // Proves it isn't just echoing UTC under a different label.
    expect(text).not.toContain("15 Jan 2026, 10:00");
  });

  it("shows a no-window message when neither bound is set", () => {
    const text = textFor({ opens_at: null, closes_at: null });
    expect(text).toContain(t(uiEn, "reg.hub.row.window.none"));
  });
});

describe("RegistrationHubDivisionRow — capacity meter", () => {
  it("renders count/capacity when capacity is set", () => {
    const text = textFor({ taken: 5, capacity: 20 });
    expect(text).toContain("5");
    expect(text).toContain("20");
  });

  it("renders sensibly with capacity null — no '12/null', no divide-by-zero", () => {
    const text = textFor({ taken: 12, capacity: null });
    expect(text).toContain("12");
    expect(text.toLowerCase()).not.toContain("null");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
  });
});

describe("RegistrationHubDivisionRow — category badge", () => {
  it("null category renders as Open, never the literal word null", () => {
    const text = textFor({ category: null });
    expect(text).toContain(t(uiEn, "reg.hub.row.category.open"));
    expect(text.toLowerCase()).not.toContain("null");
  });

  it("renders an explicit category", () => {
    const text = textFor({ category: "mixed" });
    expect(text).toContain(t(uiEn, "reg.hub.row.category.mixed"));
  });
});

describe("RegistrationHubDivisionRow — age badge", () => {
  it("renders a two-sided band", () => {
    const text = textFor({ age_min: 10, age_max: 18 });
    expect(text).toContain(t(uiEn, "reg.hub.row.ageBand.range", { min: 10, max: 18 }));
  });

  it("renders a min-only (floor, no ceiling) band correctly", () => {
    const text = textFor({ age_min: 35, age_max: null });
    expect(text).toContain(t(uiEn, "reg.hub.row.ageBand.min", { min: 35 }));
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/\{max\}/);
  });

  it("renders a max-only (ceiling, no floor) band correctly", () => {
    const text = textFor({ age_min: null, age_max: 12 });
    expect(text).toContain(t(uiEn, "reg.hub.row.ageBand.max", { max: 12 }));
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/\{min\}/);
  });
});

describe("RegistrationHubDivisionRow — fee", () => {
  it("renders Free for a zero fee", () => {
    const text = textFor({ fee_cents: 0 });
    expect(text).toContain(t(uiEn, "reg.hub.row.fee.free"));
  });

  it("renders a formatted amount for a non-zero fee", () => {
    const text = textFor({ fee_cents: 1999 }, { currency: "usd" });
    expect(text).toContain("19.99");
  });

  it("always carries the registration.paid feature seam on the fee cell, ungated", () => {
    const tree = walk(RegistrationHubDivisionRow({ row: BASE_ROW, context: BASE_CONTEXT }));
    const feeEl = tree.find((e) => propsOf(e)["data-feature"] === "registration.paid");
    expect(feeEl).toBeTruthy();
  });
});

describe("RegistrationHubDivisionRow — entrant kind and approval", () => {
  it("renders the entrant kind label", () => {
    const text = textFor({ entrant_kind: "team" });
    expect(text).toContain(t(uiEn, "divset.entrants.kind.team"));
  });

  it("falls back to a dash when entrant kind is unset (no registration_settings row yet)", () => {
    const text = textFor({ entrant_kind: null });
    expect(text).toContain("—");
  });

  it("renders the approval mode label", () => {
    const text = textFor({ approval: "manual" });
    expect(text).toContain(t(uiEn, "reg.hub.row.approval.manual"));
  });

  it("falls back to a dash when approval is unset", () => {
    const text = textFor({ approval: null });
    expect(text).toContain("—");
  });
});

describe("RegistrationHubDivisionRow — free-agent flag", () => {
  it("shows the free-agent badge when allowed", () => {
    const text = textFor({ allow_free_agents: true });
    expect(text).toContain(t(uiEn, "reg.hub.row.freeAgents"));
  });

  it("omits the free-agent badge when not allowed", () => {
    const text = textFor({ allow_free_agents: false });
    expect(text).not.toContain(t(uiEn, "reg.hub.row.freeAgents"));
  });
});

describe("RegistrationHubDivisionRow — public register link vs private notice", () => {
  it("renders the copy link with the working public URL when the competition is not private", () => {
    const tree = walk(
      RegistrationHubDivisionRow({
        row: BASE_ROW,
        context: { ...BASE_CONTEXT, showRegisterLink: true },
      }),
    );
    const link = tree.find((e) => e.type === CopyLink);
    expect(link).toBeTruthy();
    expect(propsOf(link!).path).toBe(BASE_CONTEXT.registerHref);
  });

  it("renders the private notice instead, with no copy link, when the competition is private", () => {
    const tree = walk(
      RegistrationHubDivisionRow({
        row: BASE_ROW,
        context: { ...BASE_CONTEXT, showRegisterLink: false },
      }),
    );
    expect(tree.some((e) => e.type === CopyLink)).toBe(false);
    const text = textOf(
      RegistrationHubDivisionRow({
        row: BASE_ROW,
        context: { ...BASE_CONTEXT, showRegisterLink: false },
      }),
    );
    expect(text).toContain(t(uiEn, "div.registrations.privateNotice"));
  });
});
