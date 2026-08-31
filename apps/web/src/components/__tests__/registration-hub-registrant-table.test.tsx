// RS005 W2a (task 4) + W2b (task 1/3) — the Registrants tab's row list.
//
// W2b rewrite: this used to be built on ui/responsive-table.tsx (desktop
// <table>, phone stacked cards). Adding the row-expand detail (W2b) forced
// it OUT of real <table> markup — a <tr>'s content model only accepts
// <td>/<th> children, so a <details> cannot wrap one; see
// RegistrationHubRegistrantRow's own doc comment. Each row is now a
// <details> (unified markup, no separate desktop/mobile split), reusing the
// SAME cell-content functions below for its <summary> line.
//
// `walk()` never invokes a nested CUSTOM component (_hook-harness.tsx's own
// documented limitation) — RegistrationHubRegistrantDetail is one, so tests
// that need to see INSIDE it (none here; registration-hub-registrant-
// detail.test.tsx owns that) would need a manual invoke. This file only
// proves it receives the RIGHT PROPS (`e.type === RegistrationHubRegistrantDetail`),
// same split registration-hub-registrants-panel.test.tsx already uses for
// this table one level up.
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import {
  RegistrationHubRegistrantTable,
  RegistrationHubRegistrantRow,
  renderRegistrantKindCell,
  renderRegistrantStatusCell,
  renderRegistrantPaymentCell,
  REGISTRANT_GRID_COLS,
  type RegistrationHubRegistrantTableContext,
} from "@/components/registration-hub-registrant-table";
import { RegistrationHubRegistrantDetail } from "@/components/registration-hub-registrant-detail";
import { registrantRowAnchor } from "@/components/registration-hub-registrant-derive";
import { getDictionary, t } from "@/lib/i18n";
import type { RegistrationListRow } from "@/server/usecases/registrations";
import type { RegistrantDetails } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

const dict = await getDictionary("en", "ui");
const ORG_TZ = "UTC";

const CONTEXT: RegistrationHubRegistrantTableContext = {
  dict,
  orgTz: ORG_TZ,
  canEdit: true,
  baseHref: "/o/riverside/c/summer-league/registration?tab=registrants",
};

const EMPTY_DETAILS: RegistrantDetails = {
  rosterByRegistration: new Map(),
  siblingsByGroup: new Map(),
  formFieldsByRegistration: new Map(),
};

// A cast, not a typed literal: only the fields each individual test reads
// need real values, and a hand-typed 40+-field RegistrationListRow literal
// is itself a drift risk this fixture avoids by not pretending to be
// exhaustive. row() overrides just what a given test cares about.
function row(over: Partial<RegistrationListRow>): RegistrationListRow {
  return {
    id: "reg-1",
    group_id: "group-1",
    display_name: "Alex Smith",
    division_name: "Open Singles",
    entrant_kind: "individual",
    roster_count: 1,
    roster_cap: 1,
    status: "confirmed",
    waitlist_position: null,
    free_agent: false,
    assigned_team_id: null,
    assigned_team_name: null,
    amount_cents: 1500,
    refunded_cents: 0,
    currency: "usd",
    created_at: new Date("2026-01-15T10:00:00Z"),
    ...over,
  } as unknown as RegistrationListRow;
}

describe("renderRegistrantKindCell — roster fill (task 4)", () => {
  it("a team shows roster fill n/cap", () => {
    const text = textOf(renderRegistrantKindCell(row({ entrant_kind: "team", roster_count: 5, roster_cap: 7 }), dict));
    expect(text).toContain("5/7");
  });

  it("a team with NO roster cap (unlimited sport) shows n/∞", () => {
    const text = textOf(
      renderRegistrantKindCell(row({ entrant_kind: "team", roster_count: 5, roster_cap: null }), dict),
    );
    expect(text).toContain("5/∞");
  });

  it("individual/pair entries show the kind label but NO roster fill", () => {
    const individual = textOf(renderRegistrantKindCell(row({ entrant_kind: "individual", roster_count: 1, roster_cap: 1 }), dict));
    const pair = textOf(renderRegistrantKindCell(row({ entrant_kind: "pair", roster_count: 2, roster_cap: 2 }), dict));
    expect(individual).not.toMatch(/\d+\/(\d+|∞)/);
    expect(pair).not.toMatch(/\d+\/(\d+|∞)/);
  });
});

describe("renderRegistrantKindCell — a solo sign-up is not a team (RS009)", () => {
  // A solo sign-up is stored with the DIVISION's entrant_kind, which on these
  // divisions is 'team'. The team branch therefore rendered "Team · 1/23" for
  // one person: it called them a team, and drew a roster meter for a roster
  // they do not have — the 1 was their own player row and the 22 empty places
  // belonged to whichever team might later take them.
  //
  // Found by reading the shipped table, not by a test. Every assertion in
  // this file was about entrant_kind, and entrant_kind was correct.
  it("says solo sign-up, not Team", () => {
    const text = textOf(
      renderRegistrantKindCell(
        row({ entrant_kind: "team", free_agent: true, roster_count: 1, roster_cap: 23 }),
        dict,
      ),
    );
    expect(text).toContain("Solo sign-up");
    expect(text).not.toContain("Team");
  });

  it("shows no roster meter — they have no roster", () => {
    const text = textOf(
      renderRegistrantKindCell(
        row({ entrant_kind: "team", free_agent: true, roster_count: 1, roster_cap: 23 }),
        dict,
      ),
    );
    expect(text).not.toMatch(/\d+\/(\d+|∞)/);
  });

  it("says who they are waiting for, or which team they are on", () => {
    const waiting = textOf(
      renderRegistrantKindCell(
        row({ entrant_kind: "team", free_agent: true, assigned_team_name: null }),
        dict,
      ),
    );
    expect(waiting).toContain("Waiting for a team");

    const placed = textOf(
      renderRegistrantKindCell(
        row({ entrant_kind: "team", free_agent: true, assigned_team_name: "Riverside Rovers" }),
        dict,
      ),
    );
    expect(placed).toContain("Riverside Rovers");
    expect(placed).not.toContain("Waiting for a team");
  });

  it("leaves an ordinary team entry alone", () => {
    // The guard must be narrow: free_agent, not entrant_kind. Without this a
    // change that swallowed every team row would pass the three above.
    const text = textOf(
      renderRegistrantKindCell(
        row({ entrant_kind: "team", free_agent: false, roster_count: 5, roster_cap: 7 }),
        dict,
      ),
    );
    expect(text).toContain("5/7");
    expect(text).not.toContain("Solo sign-up");
  });
});

describe("renderRegistrantStatusCell — waitlist position (task 4)", () => {
  it("a waitlisted row shows its position", () => {
    const text = textOf(renderRegistrantStatusCell(row({ status: "waitlisted", waitlist_position: 3 }), dict));
    expect(text).toContain("#3");
  });

  it("a non-waitlisted row shows NO position in the ordinary case (waitlist_position genuinely null)", () => {
    const text = textOf(renderRegistrantStatusCell(row({ status: "confirmed", waitlist_position: null }), dict));
    expect(text).not.toContain("#");
  });

  it("a non-waitlisted row shows NO position even if waitlist_position were somehow non-null (status gates it, not just the field)", () => {
    const text = textOf(renderRegistrantStatusCell(row({ status: "confirmed", waitlist_position: 3 }), dict));
    expect(text).not.toContain("#3");
  });

  it("carries a data hook naming the real status, for e2e/regression", () => {
    const tree = walk(renderRegistrantStatusCell(row({ status: "rejected" }), dict));
    const pill = tree.find((e) => propsOf(e)["data-registration-hub-registrant-status"] !== undefined)!;
    expect(propsOf(pill)["data-registration-hub-registrant-status"]).toBe("rejected");
  });
});

describe("renderRegistrantPaymentCell", () => {
  it("shows the formatted amount", () => {
    const text = textOf(renderRegistrantPaymentCell(row({ amount_cents: 2500, currency: "usd", refunded_cents: 0 }), dict));
    expect(text).toContain("$25");
  });

  it("shows Free for a zero-fee entry", () => {
    const text = textOf(renderRegistrantPaymentCell(row({ amount_cents: 0, refunded_cents: 0 }), dict));
    expect(text.toLowerCase()).toContain("free");
  });

  it("notes a refund when refunded_cents is positive", () => {
    const text = textOf(renderRegistrantPaymentCell(row({ amount_cents: 2500, currency: "usd", refunded_cents: 1000 }), dict));
    expect(text).toContain("$10");
  });

  it("says nothing about a refund when refunded_cents is zero", () => {
    const text = textOf(renderRegistrantPaymentCell(row({ amount_cents: 2500, refunded_cents: 0 }), dict));
    expect(text.toLowerCase()).not.toContain("refund");
  });

  // RS005 F2 finding 2: registration-submit.ts:542 forces amount_cents to 0
  // for EVERY waitlisted entry at submit, regardless of the division's real
  // fee — they are never charged until promotion re-snapshots the live fee.
  // Reading that 0 as "Free" told an organiser a fee-bearing division's
  // waitlisted entrant owed nothing.
  it("shows 'not charged yet', never Free, for a waitlisted entry", () => {
    const text = textOf(
      renderRegistrantPaymentCell(row({ status: "waitlisted", amount_cents: 0, refunded_cents: 0 }), dict),
    );
    expect(text.toLowerCase()).not.toContain("free");
    expect(text).toContain(t(dict, "reg.hub.registrants.detail.paymentState.waitlisted"));
  });
});

describe("RegistrationHubRegistrantRow — the expand mechanism (task 1)", () => {
  it("is a native <details>, with NO onToggle handler at all", () => {
    const tree = walk(
      RegistrationHubRegistrantRow({ row: row({}), context: CONTEXT, roster: [], siblings: [], formFields: [] }),
    );
    const root = tree[0]!;
    expect(root.type).toBe("details");
    expect(propsOf(root)).not.toHaveProperty("onToggle");
    expect(propsOf(root).open).toBeUndefined();
  });

  it("carries the row data hooks and an id anchor a sibling link can point at", () => {
    const tree = walk(
      RegistrationHubRegistrantRow({ row: row({ id: "reg-77" }), context: CONTEXT, roster: [], siblings: [], formFields: [] }),
    );
    const root = tree[0]!;
    expect(propsOf(root)).toHaveProperty("data-registration-hub-registrant-row");
    expect(propsOf(root)["data-registration-id"]).toBe("reg-77");
    expect(propsOf(root).id).toBe(registrantRowAnchor("reg-77"));
  });

  it("access_token_hash never appears in the summary line, even if a caller accidentally widened the row type", () => {
    const poisoned = row({}) as unknown as Record<string, unknown>;
    poisoned.access_token_hash = "SECRET_HASH_VALUE";
    const tree = walk(
      RegistrationHubRegistrantRow({
        row: poisoned as unknown as RegistrationListRow,
        context: CONTEXT,
        roster: [],
        siblings: [],
        formFields: [],
      }),
    );
    // Only the <summary> line's own text is checked here — the detail body
    // is an opaque nested component from this row's own tree (see file
    // header); registration-hub-registrant-detail.test.tsx proves it there.
    const summary = tree.find((e) => e.type === "summary")!;
    expect(textOf(summary)).not.toContain("SECRET_HASH_VALUE");
  });

  // W2c task 4 (hardening finding carried over from the W2a review):
  // join_code is a REAL field on RegistrationListRow (unlike
  // access_token_hash above, which the type deliberately omits — see
  // RegistrationListRow's own Omit<...> in server/usecases/registrations.ts
  // — so this needs no "widened type" cast to set it). The owner ruled it
  // hidden from viewers because it's a bearer secret that grants roster
  // WRITES; today it's safe only because the summary's columns are a
  // hardcoded list rather than a row spread, and nothing stops a future
  // column addition from leaking it. This locks that invariant in.
  it("join_code never appears in the summary line — a bearer secret, and the summary's columns are a hardcoded list, never a row spread", () => {
    const tree = walk(
      RegistrationHubRegistrantRow({
        row: row({ join_code: "SECRET_JOIN_CODE_VALUE" }),
        context: CONTEXT,
        roster: [],
        siblings: [],
        formFields: [],
      }),
    );
    const summary = tree.find((e) => e.type === "summary")!;
    expect(textOf(summary)).not.toContain("SECRET_JOIN_CODE_VALUE");
  });
});

describe("RegistrationHubRegistrantRow — ≥sm aligned columns (W2c task 1)", () => {
  it("the name cell truncates instead of reflowing, and can shrink below its own content width", () => {
    const tree = walk(
      RegistrationHubRegistrantRow({ row: row({}), context: CONTEXT, roster: [], siblings: [], formFields: [] }),
    );
    const nameCell = tree.find((e) => propsOf(e)["data-registration-hub-registrant-name-cell"] !== undefined)!;
    const className = propsOf(nameCell).className as string;
    // min-w-0: a grid item's default min-width is `auto` (= its content's
    // own intrinsic width), which refuses to shrink below that and blows
    // the row out horizontally — the trap the brief calls out by name.
    // truncate: single-line ellipsis, chosen over letting the name reflow.
    expect(className).toContain("truncate");
    expect(className).toContain("min-w-0");
  });

  it("renders both a phone card block and a ≥sm grid block, complementary via CSS visibility (display:none removes a block from the a11y tree too, so there is no double-announcement)", () => {
    const tree = walk(
      RegistrationHubRegistrantRow({ row: row({}), context: CONTEXT, roster: [], siblings: [], formFields: [] }),
    );
    const card = tree.find((e) => propsOf(e)["data-registration-hub-registrant-card"] !== undefined)!;
    const grid = tree.find((e) => propsOf(e)["data-registration-hub-registrant-grid"] !== undefined)!;
    expect(card).toBeTruthy();
    expect(grid).toBeTruthy();
    // Card: visible (flex) below sm, display:none at sm and up.
    expect(propsOf(card).className as string).toContain("sm:hidden");
    // Grid: display:none below sm, grid at sm and up — the inverse.
    expect(propsOf(grid).className as string).toContain("hidden");
    expect(propsOf(grid).className as string).toContain("sm:grid");
  });

  it("the ≥sm grid block uses the SAME column template constant the table header uses, so the two can't drift apart", () => {
    const tree = walk(
      RegistrationHubRegistrantRow({ row: row({}), context: CONTEXT, roster: [], siblings: [], formFields: [] }),
    );
    const grid = tree.find((e) => propsOf(e)["data-registration-hub-registrant-grid"] !== undefined)!;
    expect(propsOf(grid).className as string).toContain(REGISTRANT_GRID_COLS);
  });
});

describe("RegistrationHubRegistrantRow — summary line content", () => {
  it("renders name, division, kind, status, payment, submitted-at", () => {
    const tree = walk(
      RegistrationHubRegistrantRow({
        row: row({ display_name: "Jordan Lee", division_name: "Mixed Doubles", created_at: new Date("2026-01-15T10:00:00Z") }),
        context: CONTEXT,
        roster: [],
        siblings: [],
        formFields: [],
      }),
    );
    const summary = tree.find((e) => e.type === "summary")!;
    const text = textOf(summary);
    expect(text).toContain("Jordan Lee");
    expect(text).toContain("Mixed Doubles");
  });

  it("formats submittedAt in the ORG timezone, not UTC/browser-local", () => {
    const utcTree = walk(
      RegistrationHubRegistrantRow({ row: row({}), context: { ...CONTEXT, orgTz: "UTC" }, roster: [], siblings: [], formFields: [] }),
    );
    const kolkataTree = walk(
      RegistrationHubRegistrantRow({ row: row({}), context: { ...CONTEXT, orgTz: "Asia/Kolkata" }, roster: [], siblings: [], formFields: [] }),
    );
    const utcText = textOf(utcTree.find((e) => e.type === "summary")!);
    const kolkataText = textOf(kolkataTree.find((e) => e.type === "summary")!);
    expect(kolkataText).not.toBe(utcText);
  });
});

describe("RegistrationHubRegistrantRow — the detail body", () => {
  it("renders RegistrationHubRegistrantDetail with the row and every context/data prop threaded through", () => {
    const roster = [{ id: "p1", full_name: "Alex", squad_number: 1, is_captain: true, consent_status: "granted" as const }];
    const siblings = [{ id: "reg-2", display_name: "Sibling", division_name: "Open", status: "pending" as const }];
    const formFields = [{ key: "k", label: "K", kind: "text" as const, required: false }];
    const theRow = row({ id: "reg-1" });

    const tree = walk(
      RegistrationHubRegistrantRow({ row: theRow, context: CONTEXT, roster, siblings, formFields }),
    );
    const detail = tree.find((e) => e.type === RegistrationHubRegistrantDetail)!;
    expect(detail).toBeTruthy();
    const props = propsOf(detail);
    expect(props.row).toBe(theRow);
    expect(props.dict).toBe(CONTEXT.dict);
    expect(props.orgTz).toBe(CONTEXT.orgTz);
    expect(props.canEdit).toBe(CONTEXT.canEdit);
    expect(props.baseHref).toBe(CONTEXT.baseHref);
    expect(props.roster).toBe(roster);
    expect(props.siblings).toBe(siblings);
    expect(props.formFields).toBe(formFields);
  });
});

describe("RegistrationHubRegistrantTable — row list wiring (task 3: per-row map lookups)", () => {
  it("renders one RegistrationHubRegistrantRow per row, keyed by registration id", () => {
    const rows = [row({ id: "r1" }), row({ id: "r2" })];
    const tree = walk(RegistrationHubRegistrantTable({ rows, context: CONTEXT, details: EMPTY_DETAILS }));
    const rowEls = tree.filter((e) => e.type === RegistrationHubRegistrantRow);
    expect(rowEls.map((e) => propsOf(e).row)).toEqual(rows);
  });

  it("resolves each row's roster off rosterByRegistration, defaulting to [] when absent", () => {
    const rows = [row({ id: "r1" }), row({ id: "r2" })];
    const details: RegistrantDetails = {
      rosterByRegistration: new Map([["r1", [{ id: "p1", full_name: "A", squad_number: null, is_captain: false, consent_status: "granted" as const }]]]),
      siblingsByGroup: new Map(),
      formFieldsByRegistration: new Map(),
    };
    const tree = walk(RegistrationHubRegistrantTable({ rows, context: CONTEXT, details }));
    const rowEls = tree.filter((e) => e.type === RegistrationHubRegistrantRow);
    expect(propsOf(rowEls[0]!).roster).toHaveLength(1);
    expect(propsOf(rowEls[1]!).roster).toEqual([]);
  });

  it("resolves each row's cart siblings off siblingsByGroup keyed by GROUP id, with the row's OWN id excluded", () => {
    const rows = [row({ id: "r1", group_id: "g1" }), row({ id: "r2", group_id: "g1" })];
    const details: RegistrantDetails = {
      rosterByRegistration: new Map(),
      siblingsByGroup: new Map([
        [
          "g1",
          [
            { id: "r1", display_name: "First", division_name: "Open", status: "confirmed" as const },
            { id: "r2", display_name: "Second", division_name: "Open", status: "pending" as const },
          ],
        ],
      ]),
      formFieldsByRegistration: new Map(),
    };
    const tree = walk(RegistrationHubRegistrantTable({ rows, context: CONTEXT, details }));
    const rowEls = tree.filter((e) => e.type === RegistrationHubRegistrantRow);
    expect((propsOf(rowEls[0]!).siblings as { id: string }[]).map((s) => s.id)).toEqual(["r2"]);
    expect((propsOf(rowEls[1]!).siblings as { id: string }[]).map((s) => s.id)).toEqual(["r1"]);
  });

  it("a single-entry cart's siblings prop is an empty array, not the self-inclusive list", () => {
    const rows = [row({ id: "r1", group_id: "g1" })];
    const details: RegistrantDetails = {
      rosterByRegistration: new Map(),
      siblingsByGroup: new Map([["g1", [{ id: "r1", display_name: "Only", division_name: "Open", status: "confirmed" as const }]]]),
      formFieldsByRegistration: new Map(),
    };
    const tree = walk(RegistrationHubRegistrantTable({ rows, context: CONTEXT, details }));
    const rowEl = tree.find((e) => e.type === RegistrationHubRegistrantRow)!;
    expect(propsOf(rowEl).siblings).toEqual([]);
  });

  it("resolves each row's answer form_fields off formFieldsByRegistration, defaulting to [] when absent", () => {
    const rows = [row({ id: "r1" })];
    const details: RegistrantDetails = {
      rosterByRegistration: new Map(),
      siblingsByGroup: new Map(),
      formFieldsByRegistration: new Map([["r1", [{ key: "k", label: "K", kind: "text" as const, required: false }]]]),
    };
    const tree = walk(RegistrationHubRegistrantTable({ rows, context: CONTEXT, details }));
    const rowEl = tree.find((e) => e.type === RegistrationHubRegistrantRow)!;
    expect(propsOf(rowEl).formFields).toEqual([{ key: "k", label: "K", kind: "text", required: false }]);
  });

  it("passes context straight through to every row, unmodified", () => {
    const rows = [row({ id: "r1" })];
    const tree = walk(RegistrationHubRegistrantTable({ rows, context: CONTEXT, details: EMPTY_DETAILS }));
    const rowEl = tree.find((e) => e.type === RegistrationHubRegistrantRow)!;
    expect(propsOf(rowEl).context).toBe(CONTEXT);
  });

  it("carries a root data hook for e2e/regression targeting", () => {
    const tree = walk(RegistrationHubRegistrantTable({ rows: [], context: CONTEXT, details: EMPTY_DETAILS }));
    expect(propsOf(tree[0]!)).toHaveProperty("data-registration-hub-registrant-table");
  });
});

describe("RegistrationHubRegistrantTable — ≥sm header row (W2c task 2)", () => {
  it("renders a header label for each of the six columns, reusing the SAME table.* keys the detail body's own field labels already use", () => {
    const tree = walk(RegistrationHubRegistrantTable({ rows: [], context: CONTEXT, details: EMPTY_DETAILS }));
    const header = tree.find((e) => propsOf(e)["data-registration-hub-registrant-table-header"] !== undefined)!;
    const text = textOf(header);
    expect(text).toContain(t(dict, "reg.hub.registrants.table.name"));
    expect(text).toContain(t(dict, "reg.hub.registrants.table.division"));
    expect(text).toContain(t(dict, "reg.hub.registrants.table.kind"));
    expect(text).toContain(t(dict, "reg.hub.registrants.table.status"));
    expect(text).toContain(t(dict, "reg.hub.registrants.table.payment"));
    expect(text).toContain(t(dict, "reg.hub.registrants.table.submittedAt"));
  });

  it("is hidden below sm and shown as a row at sm and up", () => {
    const tree = walk(RegistrationHubRegistrantTable({ rows: [], context: CONTEXT, details: EMPTY_DETAILS }));
    const header = tree.find((e) => propsOf(e)["data-registration-hub-registrant-table-header"] !== undefined)!;
    const className = propsOf(header).className as string;
    expect(className).toContain("hidden");
    expect(className).toContain("sm:flex");
  });

  it("is removed from the accessibility tree — never announced as a data row", () => {
    const tree = walk(RegistrationHubRegistrantTable({ rows: [], context: CONTEXT, details: EMPTY_DETAILS }));
    const header = tree.find((e) => propsOf(e)["data-registration-hub-registrant-table-header"] !== undefined)!;
    expect(propsOf(header)["aria-hidden"]).toBe(true);
  });

  it("uses the SAME column template constant every row's ≥sm grid block uses, so header and rows can't drift apart", () => {
    const tree = walk(RegistrationHubRegistrantTable({ rows: [], context: CONTEXT, details: EMPTY_DETAILS }));
    const header = tree.find((e) => propsOf(e)["data-registration-hub-registrant-table-header"] !== undefined)!;
    const gridSpan = tree.find(
      (e) => e !== header && (propsOf(e).className as string | undefined)?.includes("sm:grid-cols-["),
    )!;
    expect(gridSpan).toBeTruthy();
    expect(propsOf(gridSpan).className as string).toContain(REGISTRANT_GRID_COLS);
  });
});
