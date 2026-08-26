// RS005 W2b — the row-expand detail's own content (task 2). Invoked
// directly as a plain function (not mounted via <RegistrationHubRegistrantRow>)
// — same convention as every other server component test in this family
// (registration-hub-division-row.test.tsx) — and walked/textOf'd, since every
// field row here is a plain host-element <div>/<dt>/<dd>, not a nested custom
// component (see the file's own comment on why: opaque-nesting-free by
// construction, so no manual-invoke step is needed anywhere in this file).
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import {
  RegistrationHubRegistrantDetail,
  type RegistrationHubRegistrantDetailProps,
} from "@/components/registration-hub-registrant-detail";
import { RegistrationHubRegistrantJoinCode } from "@/components/registration-hub-registrant-join-code";
import { RegistrationHubRegistrantActions } from "@/components/registration-hub-registrant-actions";
import { getDictionary, t } from "@/lib/i18n";
import type { RegistrationListRow } from "@/server/usecases/registrations";
import type { RegistrantRosterPlayer, RegistrantCartSibling } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

const dict = await getDictionary("en", "ui");

function row(over: Partial<RegistrationListRow> = {}): RegistrationListRow {
  return {
    id: "reg-1",
    division_id: "div-1",
    org_id: "org-1",
    status: "confirmed",
    display_name: "Riverside Raptors",
    answers: {},
    amount_cents: 1500,
    refunded_cents: 0,
    entrant_id: null,
    promoted_at: null,
    withdrawn_at: null,
    group_id: "group-1",
    join_code: null,
    free_agent: false,
    created_at: new Date("2026-01-15T10:00:00Z"),
    updated_at: new Date("2026-01-15T10:00:00Z"),
    contact_name: "Casey Contact",
    contact_email: "casey@test.local",
    user_id: null,
    locale: null,
    ref_code: "RC-ABC123",
    currency: "usd",
    payment_method: "stripe",
    checkout_session_id: null,
    payment_intent_id: null,
    expires_at: null,
    reminded_at: null,
    refunded_at: null,
    disputed_at: null,
    dispute_id: null,
    offline_marked_paid_at: null,
    offline_marked_paid_by: null,
    fee_percent: 8,
    privacy_consent_at: null,
    privacy_consent_version: null,
    group_refunded_cents: 0,
    division_name: "Open Doubles",
    division_slug: "open-doubles",
    entrant_kind: "team",
    roster_count: 2,
    roster_cap: 10,
    consent_pending_count: 0,
    waitlist_position: null,
    ...over,
  } as unknown as RegistrationListRow;
}

const PLAYER_A: RegistrantRosterPlayer = {
  id: "p1",
  full_name: "Alex Player",
  squad_number: 7,
  is_captain: true,
  consent_status: "granted",
};
const PLAYER_B: RegistrantRosterPlayer = {
  id: "p2",
  full_name: "Sam Player",
  squad_number: null,
  is_captain: false,
  consent_status: "pending",
};

const SIBLING: RegistrantCartSibling = {
  id: "reg-2",
  display_name: "Riverside Raptors B",
  division_name: "Open Doubles",
  status: "pending",
};

function baseProps(over: Partial<RegistrationHubRegistrantDetailProps> = {}): RegistrationHubRegistrantDetailProps {
  return {
    row: row(),
    dict,
    orgTz: "UTC",
    canEdit: true,
    roster: [PLAYER_A, PLAYER_B],
    siblings: [],
    formFields: [],
    baseHref: "/o/riverside/c/summer-league/registration?tab=registrants",
    ...over,
  };
}

describe("RegistrationHubRegistrantDetail — data hook + access_token_hash", () => {
  it("carries a root data hook for e2e/regression targeting", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps()));
    expect(propsOf(tree[0]!)).toHaveProperty("data-registration-hub-registrant-detail");
  });

  it("never renders access_token_hash, even if a caller accidentally widened the row type", () => {
    const poisoned = row() as unknown as Record<string, unknown>;
    poisoned.access_token_hash = "SECRET_HASH_VALUE";
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ row: poisoned as unknown as RegistrationListRow })));
    expect(text).not.toContain("SECRET_HASH_VALUE");
  });
});

describe("RegistrationHubRegistrantDetail — contact and entry fields", () => {
  it("renders the contact name and email", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps()));
    expect(text).toContain("Casey Contact");
    expect(text).toContain("casey@test.local");
  });

  it("renders entry name, division, kind, status, ref code", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps()));
    expect(text).toContain("Riverside Raptors");
    expect(text).toContain("Open Doubles");
    expect(text).toContain(t(dict, "divset.entrants.kind.team"));
    expect(text).toContain(t(dict, "reg.hub.registrants.status.confirmed"));
    expect(text).toContain("RC-ABC123");
  });

  it("renders the formatted amount and the card payment method label", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ row: row({ amount_cents: 2500, currency: "usd", payment_method: "stripe" }) })));
    expect(text).toContain("$25");
    expect(text).toContain(t(dict, "reg.settings.cardPayment"));
  });

  it("renders the offline payment method label", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ row: row({ payment_method: "offline" }) })));
    expect(text).toContain(t(dict, "reg.settings.payOrganiser"));
  });

  it("falls back to a dash when payment_method is null", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ row: row({ payment_method: null }) })));
    expect(text).toContain("—");
  });

  it("renders a payment state derived from the row (refunded)", () => {
    const text = textOf(
      RegistrationHubRegistrantDetail(baseProps({ row: row({ amount_cents: 1000, refunded_cents: 1000 }) })),
    );
    expect(text).toContain(t(dict, "reg.hub.registrants.detail.paymentState.refunded"));
  });

  it("renders submitted-at in the ORG timezone, not UTC/browser-local", () => {
    const utcText = textOf(RegistrationHubRegistrantDetail(baseProps({ orgTz: "UTC" })));
    const kolkataText = textOf(RegistrationHubRegistrantDetail(baseProps({ orgTz: "Asia/Kolkata" })));
    expect(kolkataText).not.toBe(utcText);
  });
});

describe("RegistrationHubRegistrantDetail — join code (viewer/editor gating)", () => {
  it("renders the join-code control for an editor when the entry has a join_code", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ row: row({ join_code: "TEAM-XYZ" }), canEdit: true })));
    const control = tree.find((e) => e.type === RegistrationHubRegistrantJoinCode);
    expect(control).toBeTruthy();
    expect(propsOf(control!).code).toBe("TEAM-XYZ");
  });

  it("is ABSENT from the markup for a viewer, even though the entry has a join_code (assert on rendered output, not the prop)", () => {
    const html = textOf(RegistrationHubRegistrantDetail(baseProps({ row: row({ join_code: "TEAM-XYZ" }), canEdit: false })));
    expect(html).not.toContain("TEAM-XYZ");
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ row: row({ join_code: "TEAM-XYZ" }), canEdit: false })));
    expect(tree.some((e) => e.type === RegistrationHubRegistrantJoinCode)).toBe(false);
  });

  it("is absent for an editor too when the entry has NO join_code (degenerate case: free agent / no code minted)", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ row: row({ join_code: null }), canEdit: true })));
    expect(tree.some((e) => e.type === RegistrationHubRegistrantJoinCode)).toBe(false);
  });

  // RS005 R1 second-wave finding: observed live, a WITHDRAWN entry still
  // displayed its join code under "Anyone with this code can add players to
  // this entry" — but joinTeamEntry (registration-submit.ts) refuses a
  // withdrawn/rejected/expired entry outright ("This entry is no longer
  // accepting players"), so the code was inert and the warning described a
  // capability nobody had.
  it("is absent for an editor on a TERMINAL entry (withdrawn/rejected/expired), even with a join_code", () => {
    for (const status of ["withdrawn", "rejected", "expired"] as const) {
      const tree = walk(
        RegistrationHubRegistrantDetail(baseProps({ row: row({ join_code: "TEAM-XYZ", status }), canEdit: true })),
      );
      expect(tree.some((e) => e.type === RegistrationHubRegistrantJoinCode)).toBe(false);
    }
  });

  it("stays PRESENT for an editor on every non-terminal status with a join_code — this wave must not over-gate", () => {
    for (const status of ["pending", "paid", "confirmed", "waitlisted"] as const) {
      const tree = walk(
        RegistrationHubRegistrantDetail(baseProps({ row: row({ join_code: "TEAM-XYZ", status }), canEdit: true })),
      );
      expect(tree.some((e) => e.type === RegistrationHubRegistrantJoinCode)).toBe(true);
    }
  });
});

describe("RegistrationHubRegistrantDetail — answers (task 2: labelled, not raw keys)", () => {
  it("renders the declared field's LABEL, not the raw key", () => {
    const text = textOf(
      RegistrationHubRegistrantDetail(
        baseProps({
          row: row({ answers: { dietary_reqs: "Vegetarian" } }),
          formFields: [{ key: "dietary_reqs", label: "Dietary requirements", kind: "text", required: false }],
        }),
      ),
    );
    expect(text).toContain("Dietary requirements");
    expect(text).toContain("Vegetarian");
    expect(text).not.toContain("dietary_reqs");
  });

  it("falls back to the raw key for an undeclared answer", () => {
    const text = textOf(
      RegistrationHubRegistrantDetail(baseProps({ row: row({ answers: { mystery_key: "value" } }), formFields: [] })),
    );
    expect(text).toContain("mystery_key");
  });

  it("renders a boolean (checkbox) answer as Yes/No, not true/false", () => {
    const text = textOf(
      RegistrationHubRegistrantDetail(
        baseProps({
          row: row({ answers: { agreed: true } }),
          formFields: [{ key: "agreed", label: "Agreed", kind: "checkbox", required: false }],
        }),
      ),
    );
    expect(text).toContain(t(dict, "reg.hub.registrants.detail.answers.yes"));
    expect(text).not.toContain("true");
  });

  it("shows the empty-answers message when there are none (degenerate case)", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ row: row({ answers: {} }) })));
    expect(text).toContain(t(dict, "reg.hub.registrants.detail.answers.empty"));
  });
});

describe("RegistrationHubRegistrantDetail — roster (task 2 + acceptance)", () => {
  it("renders one line per player: name, squad number, captain marker", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ roster: [PLAYER_A, PLAYER_B] })));
    expect(text).toContain("Alex Player");
    expect(text).toContain("Sam Player");
    expect(text).toContain(t(dict, "reg.hub.registrants.detail.roster.squadNumber", { number: 7 }));
    expect(text).toContain(t(dict, "reg.hub.registrants.detail.roster.captain"));
  });

  it("preserves the given roster order (ordering itself is the data layer's job, not this component's)", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ roster: [PLAYER_B, PLAYER_A] })));
    const names = tree
      .filter((e) => propsOf(e)["data-registration-hub-registrant-roster-player"] !== undefined)
      .map((e) => textOf(e));
    expect(names[0]).toContain("Sam Player");
    expect(names[1]).toContain("Alex Player");
  });

  it("each player's consent chip reflects THAT player's own consent_status, independently", () => {
    const tree = walk(
      RegistrationHubRegistrantDetail(
        baseProps({
          roster: [
            { ...PLAYER_A, consent_status: "granted" },
            { ...PLAYER_B, consent_status: "pending" },
            { id: "p3", full_name: "Jordan Player", squad_number: 9, is_captain: false, consent_status: "guardian" },
          ],
        }),
      ),
    );
    const chips = tree.filter((e) => propsOf(e)["data-registration-hub-registrant-consent"] !== undefined);
    expect(chips.map((c) => propsOf(c)["data-registration-hub-registrant-consent"])).toEqual([
      "granted",
      "pending",
      "guardian",
    ]);
  });

  it("shows the empty-roster message for a free agent / empty roster (degenerate case), not an empty list", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ roster: [] })));
    expect(text).toContain(t(dict, "reg.hub.registrants.detail.roster.empty"));
  });

  it("omits the squad-number text entirely when it is null, rather than printing 'Squad #null'", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ roster: [PLAYER_B] })));
    expect(text.toLowerCase()).not.toContain("null");
  });
});

describe("RegistrationHubRegistrantDetail — cart siblings (task 2 + acceptance)", () => {
  it("renders NO siblings section for a single-entry cart (degenerate case)", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ siblings: [] })));
    expect(textOf(tree)).not.toContain(t(dict, "reg.hub.registrants.detail.section.siblings"));
  });

  it("renders a link per sibling for a multi-entry cart, pointing at the sibling's own row anchor", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ siblings: [SIBLING] })));
    const link = tree.find((e) => propsOf(e)["data-registration-hub-registrant-sibling-link"] !== undefined)!;
    expect(link).toBeTruthy();
    expect(propsOf(link).href).toBe(
      "/o/riverside/c/summer-league/registration?tab=registrants#registrant-reg-2",
    );
    expect(textOf([link])).toContain("Riverside Raptors B");
    expect(textOf([link])).toContain("Open Doubles");
    expect(textOf([link])).toContain(t(dict, "reg.hub.registrants.status.pending"));
  });

  it("renders one link per sibling when there are several", () => {
    const second: RegistrantCartSibling = { id: "reg-3", display_name: "Third Entry", division_name: "Open Doubles", status: "confirmed" };
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ siblings: [SIBLING, second] })));
    const links = tree.filter((e) => propsOf(e)["data-registration-hub-registrant-sibling-link"] !== undefined);
    expect(links).toHaveLength(2);
  });
});

describe("RegistrationHubRegistrantDetail — action controls (RS005 W3, viewer/editor gating)", () => {
  it("mounts RegistrationHubRegistrantActions for an editor, threading the row's id/status/approval/amount_cents/payment_intent_id straight through", () => {
    const tree = walk(
      RegistrationHubRegistrantDetail(
        baseProps({
          row: row({
            id: "reg-9",
            status: "pending",
            approval: "manual",
            amount_cents: 2500,
            payment_intent_id: "pi_456",
          }),
          canEdit: true,
        }),
      ),
    );
    const actions = tree.find((e) => e.type === RegistrationHubRegistrantActions);
    expect(actions).toBeTruthy();
    expect(propsOf(actions!)).toMatchObject({
      registrationId: "reg-9",
      status: "pending",
      approval: "manual",
      amountCents: 2500,
      paymentIntentId: "pi_456",
    });
  });

  it("is ABSENT for a viewer — not merely disabled (owner ruling, 2026-08-25: mutating controls are absent, not disabled)", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ canEdit: false })));
    expect(tree.some((e) => e.type === RegistrationHubRegistrantActions)).toBe(false);
  });

  it("renders the Actions section heading only for an editor, never for a viewer", () => {
    const editorText = textOf(RegistrationHubRegistrantDetail(baseProps({ canEdit: true })));
    const viewerText = textOf(RegistrationHubRegistrantDetail(baseProps({ canEdit: false })));
    expect(editorText).toContain(t(dict, "reg.hub.registrants.detail.section.actions"));
    expect(viewerText).not.toContain(t(dict, "reg.hub.registrants.detail.section.actions"));
  });
});

describe("RegistrationHubRegistrantDetail — no empty Actions heading", () => {
  // Found by driving the real product: a rejected entry correctly offers no
  // controls (every one is gated off for a terminal status), which left an
  // "Actions" heading standing over nothing. Same class as the "Only available
  // for team divisions." hint removed from the config panel — a section header
  // with no section under it tells an organiser something is missing rather
  // than that nothing applies.
  it.each(["withdrawn", "rejected", "expired"] as const)(
    "renders no Actions section for a %s entry",
    (status) => {
      const tree = walk(
        RegistrationHubRegistrantDetail(baseProps({ row: row({ status }), canEdit: true })),
      );
      const headings = tree.filter(
        (e) => propsOf(e)["aria-label"] === t(dict, "reg.hub.registrants.detail.section.actions"),
      );
      expect(headings).toHaveLength(0);
    },
  );

  it("still renders the Actions section when at least one control is legal", () => {
    const tree = walk(
      RegistrationHubRegistrantDetail(baseProps({ row: row({ status: "pending" }), canEdit: true })),
    );
    const headings = tree.filter(
      (e) => propsOf(e)["aria-label"] === t(dict, "reg.hub.registrants.detail.section.actions"),
    );
    expect(headings.length).toBeGreaterThan(0);
  });
});
