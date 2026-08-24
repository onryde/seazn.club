// RS004 W3/W3c/W4 — the Settings tab's per-division row ("Scan line"
// treatment): status pill, window (org tz), capacity meter, fee, entrant
// kind, category/age badges, approval mode, free-agent flag, the public
// register link/private notice, and the Configure affordance that opens
// the config panel. Every derivation this component calls (status/window/
// capacity/category/age) is proven in registration-hub-row-derive.test.ts /
// registration-hub-status.test.ts — this file proves the row's own JSX
// binding and text assembly.
import { describe, expect, it, vi } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import {
  RegistrationHubDivisionRow,
  Chip,
  type RegistrationHubRowData,
  type RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";
import { CopyLink } from "@/components/copy-link";
import { t } from "@/lib/i18n-runtime";
import { formatMinor } from "@/lib/currency";
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

describe("RegistrationHubDivisionRow — identity", () => {
  it("carries the division name and a data hook for e2e/regression targeting", () => {
    const tree = walk(RegistrationHubDivisionRow({ row: BASE_ROW, context: BASE_CONTEXT }));
    const props = propsOf(tree[0]!);
    expect(props).toHaveProperty("data-registration-hub-row");
    expect(props["data-division-id"]).toBe("div-1");
    expect(textOf(tree)).toContain("Open Singles");
  });
});

describe("RegistrationHubDivisionRow — status-first scan order (the design claim)", () => {
  it("renders the status pill BEFORE the division name — the defining layout decision of this row", () => {
    const text = textOf(
      RegistrationHubDivisionRow({
        row: { ...BASE_ROW, enabled: true, opens_at: null, closes_at: null },
        context: BASE_CONTEXT,
      }),
    );
    const statusText = t(uiEn, "reg.hub.row.status.open");
    expect(text.indexOf(statusText)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(statusText)).toBeLessThan(text.indexOf("Open Singles"));
  });

  it("carries the status data-hook with the derived value", () => {
    const tree = walk(
      RegistrationHubDivisionRow({
        row: { ...BASE_ROW, enabled: false },
        context: BASE_CONTEXT,
      }),
    );
    const pill = tree.find((e) => propsOf(e)["data-registration-hub-status"] !== undefined);
    expect(propsOf(pill!)["data-registration-hub-status"]).toBe("closed");
  });

  it("scheduled — window not yet open", () => {
    const tree = walk(
      RegistrationHubDivisionRow({
        row: { ...BASE_ROW, enabled: true, opens_at: "2026-07-01T00:00:00Z", closes_at: null },
        context: BASE_CONTEXT,
      }),
    );
    const pill = tree.find((e) => propsOf(e)["data-registration-hub-status"] !== undefined);
    expect(propsOf(pill!)["data-registration-hub-status"]).toBe("scheduled");
  });
});

describe("RegistrationHubDivisionRow — capacity elevated onto the primary line", () => {
  it("binds the fill bar's rendered style.width to the derived percent", () => {
    const tree = walk(
      RegistrationHubDivisionRow({ row: { ...BASE_ROW, taken: 5, capacity: 20 }, context: BASE_CONTEXT }),
    );
    const fill = tree.find((e) => propsOf(e).className === "block h-full rounded-full bg-purple-500");
    expect(fill).toBeTruthy();
    expect(propsOf(fill!).style).toEqual({ width: "25%" });
  });

  it("renders no fill bar when capacity is null — nothing to bind a width to", () => {
    const tree = walk(
      RegistrationHubDivisionRow({ row: { ...BASE_ROW, taken: 12, capacity: null }, context: BASE_CONTEXT }),
    );
    const fill = tree.find((e) => propsOf(e).className === "block h-full rounded-full bg-purple-500");
    expect(fill).toBeUndefined();
  });

  it("renders sensibly with capacity null — no '12/null', no divide-by-zero", () => {
    const text = textOf(
      RegistrationHubDivisionRow({ row: { ...BASE_ROW, taken: 12, capacity: null }, context: BASE_CONTEXT }),
    );
    expect(text).toContain("12");
    expect(text.toLowerCase()).not.toContain("null");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
  });

  it("appears before the Configure button in the primary line", () => {
    const text = textOf(
      RegistrationHubDivisionRow({ row: { ...BASE_ROW, taken: 5, capacity: 20 }, context: BASE_CONTEXT }),
    );
    expect(text.indexOf("5")).toBeGreaterThanOrEqual(0);
  });
});

describe("RegistrationHubDivisionRow — window keeps the zone label", () => {
  it("renders the window in the ORG timezone with the zone labelled, not dropped for density", () => {
    const text = textOf(
      RegistrationHubDivisionRow({
        row: { ...BASE_ROW, opens_at: "2026-01-15T10:00:00Z", closes_at: null },
        context: { ...BASE_CONTEXT, orgTz: "Asia/Kolkata" },
      }),
    );
    expect(text).toContain("15 Jan 2026, 15:30");
    expect(text).toContain("IST");
    expect(text).not.toContain("15 Jan 2026, 10:00");
  });

  it("shows a no-window message when neither bound is set", () => {
    const text = textOf(RegistrationHubDivisionRow({ row: { ...BASE_ROW, opens_at: null, closes_at: null }, context: BASE_CONTEXT }));
    expect(text).toContain(t(uiEn, "reg.hub.row.window.none"));
  });
});

describe("RegistrationHubDivisionRow — fee", () => {
  it("renders Free for a zero fee", () => {
    const text = textOf(RegistrationHubDivisionRow({ row: { ...BASE_ROW, fee_cents: 0 }, context: BASE_CONTEXT }));
    expect(text).toContain(t(uiEn, "reg.hub.row.fee.free"));
  });

  it("renders a formatted amount for a non-zero fee", () => {
    const text = textOf(
      RegistrationHubDivisionRow({ row: { ...BASE_ROW, fee_cents: 1999 }, context: { ...BASE_CONTEXT, currency: "usd" } }),
    );
    expect(text).toContain("19.99");
  });

  it("always carries the registration.paid feature seam on the fee cell, ungated", () => {
    const tree = walk(RegistrationHubDivisionRow({ row: BASE_ROW, context: BASE_CONTEXT }));
    expect(tree.some((e) => propsOf(e)["data-feature"] === "registration.paid")).toBe(true);
  });
});

describe("RegistrationHubDivisionRow — Configure affordance, same contract as before", () => {
  it("calls context.onOpen with THIS row's division id", () => {
    const onOpen = vi.fn();
    const tree = walk(
      RegistrationHubDivisionRow({ row: { ...BASE_ROW, division_id: "div-9" }, context: { ...BASE_CONTEXT, onOpen } }),
    );
    const btn = tree.find((e) => propsOf(e)["data-registration-hub-row-configure"] !== undefined);
    expect(btn).toBeTruthy();
    (propsOf(btn!).onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith("div-9");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("gives the button an accessible name naming the division", () => {
    const tree = walk(RegistrationHubDivisionRow({ row: { ...BASE_ROW, name: "Open Doubles" }, context: BASE_CONTEXT }));
    const btn = tree.find((e) => propsOf(e)["data-registration-hub-row-configure"] !== undefined);
    expect(propsOf(btn!)["aria-label"]).toBe(t(uiEn, "reg.hub.row.configure", { name: "Open Doubles" }));
  });
});

describe("RegistrationHubDivisionRow — the copy control is never dropped", () => {
  it("renders CopyLink with the same path/label when the competition is not private", () => {
    const tree = walk(RegistrationHubDivisionRow({ row: BASE_ROW, context: { ...BASE_CONTEXT, showRegisterLink: true } }));
    const link = tree.find((e) => e.type === CopyLink);
    expect(link).toBeTruthy();
    expect(propsOf(link!).path).toBe(BASE_CONTEXT.registerHref);
    expect(propsOf(link!).label).toBe(t(uiEn, "div.registrations.publicLink.title"));
  });

  it("renders the private notice instead, with no copy link, when private", () => {
    const tree = walk(RegistrationHubDivisionRow({ row: BASE_ROW, context: { ...BASE_CONTEXT, showRegisterLink: false } }));
    expect(tree.some((e) => e.type === CopyLink)).toBe(false);
    expect(textOf(tree)).toContain(t(uiEn, "div.registrations.privateNotice"));
  });
});

// Every Chip element's own rendered text — a Chip's `children` prop IS its
// label text directly (`<Chip>{categoryLabel}</Chip>`), so no manual
// invocation is needed to read it, only a type match. This is the reason a
// plain textOf(...).toContain("Open") can't test badge presence/absence on
// its own here: the status pill's OWN text for an open division is
// "Open now" (and this file's fixture row is even named "Open Singles"),
// both of which contain the substring "Open" regardless of whether the
// category badge renders — the check has to target Chip elements
// specifically, not scan the row's whole text.
function chipTexts(tree: ReturnType<typeof walk>): unknown[] {
  return tree.filter((e) => e.type === Chip).map((e) => propsOf(e).children);
}

describe("RegistrationHubDivisionRow — badges and dash fallbacks", () => {
  // Finding 2: the status pill already owns the word "Open" ("Open now"),
  // and resolveDivisionCategory maps null -> "open" for OTHER derivations'
  // benefit (never having to special-case "no restriction set") — but
  // rendering a category badge for it collided with the status vocabulary:
  // a closed division read "Closed … Open" side by side. Null/open carries
  // no restriction to announce, so no badge, never the literal word null.
  it("renders no category badge for an explicit open category", () => {
    const tree = walk(RegistrationHubDivisionRow({ row: { ...BASE_ROW, category: "open" }, context: BASE_CONTEXT }));
    expect(chipTexts(tree)).not.toContain(t(uiEn, "reg.hub.row.category.open"));
    expect(textOf(tree).toLowerCase()).not.toContain("null");
  });

  it("renders no category badge when category is null, never the literal word null", () => {
    const tree = walk(RegistrationHubDivisionRow({ row: { ...BASE_ROW, category: null }, context: BASE_CONTEXT }));
    expect(chipTexts(tree)).not.toContain(t(uiEn, "reg.hub.row.category.open"));
    expect(textOf(tree).toLowerCase()).not.toContain("null");
  });

  it("a closed division with no category restriction has no 'Open' category badge (finding 2 collision)", () => {
    const tree = walk(
      RegistrationHubDivisionRow({ row: { ...BASE_ROW, enabled: false, category: null }, context: BASE_CONTEXT }),
    );
    const pill = tree.find((e) => propsOf(e)["data-registration-hub-status"] !== undefined);
    expect(propsOf(pill!)["data-registration-hub-status"]).toBe("closed");
    expect(chipTexts(tree)).not.toContain(t(uiEn, "reg.hub.row.category.open"));
  });

  it("renders an explicit category as a Chip", () => {
    const tree = walk(RegistrationHubDivisionRow({ row: { ...BASE_ROW, category: "mixed" }, context: BASE_CONTEXT }));
    expect(chipTexts(tree)).toContain(t(uiEn, "reg.hub.row.category.mixed"));
  });

  it("renders a two-sided age band", () => {
    const text = textOf(
      RegistrationHubDivisionRow({ row: { ...BASE_ROW, age_min: 10, age_max: 18 }, context: BASE_CONTEXT }),
    );
    expect(text).toContain(t(uiEn, "reg.hub.row.ageBand.range", { min: 10, max: 18 }));
  });

  it("shows the free-agent chip when allowed, omits it when not", () => {
    const shown = textOf(RegistrationHubDivisionRow({ row: { ...BASE_ROW, allow_free_agents: true }, context: BASE_CONTEXT }));
    expect(shown).toContain(t(uiEn, "reg.hub.row.freeAgents"));
    const hidden = textOf(RegistrationHubDivisionRow({ row: { ...BASE_ROW, allow_free_agents: false }, context: BASE_CONTEXT }));
    expect(hidden).not.toContain(t(uiEn, "reg.hub.row.freeAgents"));
  });

  it("falls back to a dash when entrant kind and approval are unset", () => {
    const text = textOf(
      RegistrationHubDivisionRow({ row: { ...BASE_ROW, entrant_kind: null, approval: null }, context: BASE_CONTEXT }),
    );
    expect(text).toContain("—");
  });

  it("renders the entrant kind label when set", () => {
    const text = textOf(RegistrationHubDivisionRow({ row: { ...BASE_ROW, entrant_kind: "team" }, context: BASE_CONTEXT }));
    expect(text).toContain(t(uiEn, "divset.entrants.kind.team"));
  });

  it("renders the approval mode label when set", () => {
    const text = textOf(RegistrationHubDivisionRow({ row: { ...BASE_ROW, approval: "manual" }, context: BASE_CONTEXT }));
    expect(text).toContain(t(uiEn, "reg.hub.row.approval.manual"));
  });
});

describe("RegistrationHubDivisionRow — full text against a fixture, not spot-checked fragments", () => {
  // RS004 review finding 3 (pre-promotion): "byte-identical" claims that only
  // check a few substrings survived are nowhere near what they claim. This
  // pins the row's FULL rendered text, exactly, against a hand-built fixture.
  it("renders the row's full text exactly", () => {
    const row: RegistrationHubRowData = {
      division_id: "div-42",
      name: "Open Doubles",
      category: "mixed",
      age_min: 10,
      age_max: 18,
      enabled: true,
      entrant_kind: "team",
      opens_at: null,
      closes_at: null,
      capacity: 20,
      fee_cents: 1999,
      approval: "manual",
      allow_free_agents: true,
      taken: 5,
    };
    // showRegisterLink: false — the true branch renders <CopyLink label={…}
    // .../> with the label as a PROP, not a JSX child, so textOf (children
    // only) can never see it; the private-notice branch renders its text as
    // an actual child and keeps this fixture exhaustive.
    const context: RegistrationHubRowContext = { ...BASE_CONTEXT, showRegisterLink: false };
    const text = textOf(RegistrationHubDivisionRow({ row, context }));

    // Every text-bearing node the row renders, in DOM order: status pill,
    // name, capacity, fee (the primary scan line), then window/entrant/
    // approval/category/age/free-agents (the secondary line), then the
    // private notice (showRegisterLink: false above). This is text
    // ASSEMBLY, not a re-verification of each derivation's own formatting.
    const expected = [
      t(uiEn, "reg.hub.row.status.open"),
      row.name,
      t(uiEn, "reg.hub.row.capacity.limited", { count: 5, capacity: 20 }),
      formatMinor(1999, "usd"),
      t(uiEn, "reg.hub.row.window.none"),
      t(uiEn, "divset.entrants.kind.team"),
      t(uiEn, "reg.hub.row.approval.manual"),
      t(uiEn, "reg.hub.row.category.mixed"),
      t(uiEn, "reg.hub.row.ageBand.range", { min: 10, max: 18 }),
      t(uiEn, "reg.hub.row.freeAgents"),
      t(uiEn, "div.registrations.privateNotice"),
    ].join(" ");

    expect(text).toBe(expected);
  });
});
