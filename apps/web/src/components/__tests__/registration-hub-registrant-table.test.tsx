// RS005 W2a — the Registrants tab's table (task 4). ONE table, ONE row
// renderer for every status including waitlisted (ruling: no separate
// waitlist section — this session deleted waitlist-queue.tsx to avoid
// exactly that second renderer; waitlist_position rides its own column/spot
// on this same row instead, and the "waitlist" status filter is how an
// organiser scopes to the queue).
//
// Built on the shared ui/responsive-table.tsx (desktop <table>, phone
// stacked cards, already proven elsewhere — persons-panel.tsx) rather than
// a hand-rolled table, so this wave inherits its no-horizontal-scroll
// behaviour instead of re-deriving it. `walk()` never invokes a nested
// custom component (_hook-harness.tsx's own documented limitation), so
// rather than trying to render INSIDE <ResponsiveTable>, these tests pull
// the `columns[i].render`/`renderCard` FUNCTIONS straight off its props and
// call them directly with a fixture row — the cell-rendering logic is what
// task 4/6/7's acceptance criteria are actually about.
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubRegistrantTable } from "@/components/registration-hub-registrant-table";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ui/responsive-table";
import { getDictionary } from "@/lib/i18n";
import type { RegistrationListRow } from "@/server/usecases/registrations";

const dict = await getDictionary("en", "ui");
const ORG_TZ = "UTC";

function tableElement(rows: RegistrationListRow[]) {
  const tree = walk(RegistrationHubRegistrantTable({ rows, context: { dict, orgTz: ORG_TZ } }));
  return tree.find((e) => e.type === ResponsiveTable)!;
}

function columnsOf(rows: RegistrationListRow[] = []): ResponsiveColumn<RegistrationListRow>[] {
  return propsOf(tableElement(rows)).columns as ResponsiveColumn<RegistrationListRow>[];
}

// A cast, not a typed literal: only the fields each individual test reads
// need real values, and a hand-typed 40+-field RegistrationListRow literal
// is itself a drift risk this fixture avoids by not pretending to be
// exhaustive. row() overrides just what a given test cares about.
function row(over: Partial<RegistrationListRow>): RegistrationListRow {
  return {
    id: "reg-1",
    display_name: "Alex Smith",
    division_name: "Open Singles",
    entrant_kind: "individual",
    roster_count: 1,
    roster_cap: 1,
    status: "confirmed",
    waitlist_position: null,
    amount_cents: 1500,
    refunded_cents: 0,
    currency: "usd",
    created_at: new Date("2026-01-15T10:00:00Z"),
    ...over,
  } as unknown as RegistrationListRow;
}

describe("RegistrationHubRegistrantTable — wiring", () => {
  it("passes rows straight through, unmodified", () => {
    const rows = [row({ id: "r1" }), row({ id: "r2" })];
    expect(propsOf(tableElement(rows)).rows).toBe(rows);
  });

  it("keys by the registration id", () => {
    const keyOf = propsOf(tableElement([])).keyOf as (r: RegistrationListRow) => string;
    expect(keyOf(row({ id: "reg-42" }))).toBe("reg-42");
  });

  it("declares exactly the 6 required columns, in order", () => {
    expect(columnsOf().map((c) => c.key)).toEqual([
      "name",
      "division",
      "kind",
      "status",
      "payment",
      "submittedAt",
    ]);
  });
});

describe("name / division / submittedAt cells", () => {
  it("name renders display_name", () => {
    const col = columnsOf().find((c) => c.key === "name")!;
    expect(textOf(col.render(row({ display_name: "Jordan Lee" })))).toContain("Jordan Lee");
  });

  it("division renders division_name", () => {
    const col = columnsOf().find((c) => c.key === "division")!;
    expect(textOf(col.render(row({ division_name: "Mixed Doubles" })))).toContain("Mixed Doubles");
  });

  it("submittedAt formats created_at in the ORG timezone, not UTC/browser-local", () => {
    const col = columnsOf().find((c) => c.key === "submittedAt")!;
    const utcText = textOf(col.render(row({ created_at: new Date("2026-01-15T10:00:00Z") })));
    // Same instant, threaded through a DIFFERENT orgTz, must render differently.
    const kolkataTree = walk(
      RegistrationHubRegistrantTable({
        rows: [],
        context: { dict, orgTz: "Asia/Kolkata" },
      }),
    );
    const kolkataCol = (propsOf(kolkataTree.find((e) => e.type === ResponsiveTable)!).columns as ResponsiveColumn<RegistrationListRow>[]).find(
      (c) => c.key === "submittedAt",
    )!;
    const kolkataText = textOf(kolkataCol.render(row({ created_at: new Date("2026-01-15T10:00:00Z") })));
    expect(kolkataText).not.toBe(utcText);
  });
});

describe("kind cell — roster fill (task 4)", () => {
  it("a team shows roster fill n/cap", () => {
    const col = columnsOf().find((c) => c.key === "kind")!;
    const text = textOf(col.render(row({ entrant_kind: "team", roster_count: 5, roster_cap: 7 })));
    expect(text).toContain("5/7");
  });

  it("a team with NO roster cap (unlimited sport) shows n/∞", () => {
    const col = columnsOf().find((c) => c.key === "kind")!;
    const text = textOf(col.render(row({ entrant_kind: "team", roster_count: 5, roster_cap: null })));
    expect(text).toContain("5/∞");
  });

  it("individual/pair entries show the kind label but NO roster fill", () => {
    const col = columnsOf().find((c) => c.key === "kind")!;
    const individual = textOf(col.render(row({ entrant_kind: "individual", roster_count: 1, roster_cap: 1 })));
    const pair = textOf(col.render(row({ entrant_kind: "pair", roster_count: 2, roster_cap: 2 })));
    expect(individual).not.toMatch(/\d+\/(\d+|∞)/);
    expect(pair).not.toMatch(/\d+\/(\d+|∞)/);
  });
});

describe("status cell — waitlist position (task 4)", () => {
  it("a waitlisted row shows its position", () => {
    const col = columnsOf().find((c) => c.key === "status")!;
    const text = textOf(col.render(row({ status: "waitlisted", waitlist_position: 3 })));
    expect(text).toContain("#3");
  });

  it("a non-waitlisted row shows NO position in the ordinary case (waitlist_position genuinely null)", () => {
    const col = columnsOf().find((c) => c.key === "status")!;
    const text = textOf(col.render(row({ status: "confirmed", waitlist_position: null })));
    expect(text).not.toContain("#");
  });

  it("a non-waitlisted row shows NO position even if waitlist_position were somehow non-null (status gates it, not just the field)", () => {
    // listRegistrations' own query only ever sets waitlist_position when
    // status='waitlisted' — this is a defence-in-depth case, not a reachable
    // one, and it is the ONE that actually exercises the `row.status ===
    // "waitlisted" &&` half of the guard: the test above (waitlist_position
    // null) passes identically whether or not that half of the condition
    // exists at all.
    const col = columnsOf().find((c) => c.key === "status")!;
    const text = textOf(col.render(row({ status: "confirmed", waitlist_position: 3 })));
    expect(text).not.toContain("#3");
  });

  it("carries a data hook naming the real status, for e2e/regression", () => {
    const col = columnsOf().find((c) => c.key === "status")!;
    const tree = walk(col.render(row({ status: "rejected" })));
    const pill = tree.find((e) => propsOf(e)["data-registration-hub-registrant-status"] !== undefined)!;
    expect(propsOf(pill)["data-registration-hub-registrant-status"]).toBe("rejected");
  });
});

describe("payment cell", () => {
  it("shows the formatted amount", () => {
    const col = columnsOf().find((c) => c.key === "payment")!;
    const text = textOf(col.render(row({ amount_cents: 2500, currency: "usd", refunded_cents: 0 })));
    expect(text).toContain("$25");
  });

  it("shows Free for a zero-fee entry", () => {
    const col = columnsOf().find((c) => c.key === "payment")!;
    const text = textOf(col.render(row({ amount_cents: 0, refunded_cents: 0 })));
    expect(text.toLowerCase()).toContain("free");
  });

  it("notes a refund when refunded_cents is positive", () => {
    const col = columnsOf().find((c) => c.key === "payment")!;
    const text = textOf(col.render(row({ amount_cents: 2500, currency: "usd", refunded_cents: 1000 })));
    expect(text).toContain("$10");
  });

  it("says nothing about a refund when refunded_cents is zero", () => {
    const col = columnsOf().find((c) => c.key === "payment")!;
    const text = textOf(col.render(row({ amount_cents: 2500, refunded_cents: 0 })));
    expect(text.toLowerCase()).not.toContain("refund");
  });
});

describe("access_token_hash never appears", () => {
  it("is absent from every cell's rendered text, even if a caller accidentally widened the row type", () => {
    const poisoned = row({}) as unknown as Record<string, unknown>;
    poisoned.access_token_hash = "SECRET_HASH_VALUE";
    const cols = columnsOf();
    for (const col of cols) {
      const text = textOf(col.render(poisoned as unknown as RegistrationListRow));
      expect(text).not.toContain("SECRET_HASH_VALUE");
    }
  });
});

describe("mobile card (renderCard) carries its own row data hook", () => {
  it("tags the card root with the registration id — ResponsiveTable's <tr> has no such hook, this is the addressable one", () => {
    const renderCard = propsOf(tableElement([])).renderCard as (
      r: RegistrationListRow,
    ) => Parameters<typeof walk>[0];
    const root = walk(renderCard(row({ id: "reg-77" })))[0]!;
    expect(propsOf(root)["data-registration-hub-registrant-row"]).not.toBeUndefined();
    expect(propsOf(root)["data-registration-id"]).toBe("reg-77");
  });
});
