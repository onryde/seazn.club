// RS005 W2b — the row-expand detail's own content (task 2). Invoked
// directly as a plain function (not mounted via <RegistrationHubRegistrantRow>)
// — same convention as every other server component test in this family
// (registration-hub-division-row.test.tsx) — and walked/textOf'd, since every
// field row here is a plain host-element <div>/<dt>/<dd>, not a nested custom
// component (see the file's own comment on why: opaque-nesting-free by
// construction, so no manual-invoke step is needed anywhere in this file).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import {
  RegistrationHubRegistrantDetail,
  type RegistrationHubRegistrantDetailProps,
} from "@/components/registration-hub-registrant-detail";
import { RegistrationHubRegistrantJoinCode } from "@/components/registration-hub-registrant-join-code";
import { RegistrationHubRegistrantActions } from "@/components/registration-hub-registrant-actions";
import { getDictionary, t } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";
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
    late_refunded_cents: 0,
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
    cart_position: 1,
    cart_size: 1,
    currency: "usd",
    payment_method: "stripe",
    checkout_session_id: null,
    payment_intent_id: null,
    entry_payment_intent_id: null,
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
    orgSlug: "riverside",
    compSlug: "summer-league",
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

  it("renders a solo sign-up's kind as 'Solo sign-up', not the division's team entrant_kind", () => {
    // RS009 walkthrough (2026-08-31): the table already special-cases
    // free_agent (renderRegistrantKindCell), but this panel's ENTRY block
    // read entrant_kind directly and never checked free_agent — so
    // expanding the exact row the table just labelled "Solo sign-up" told
    // the organiser its Kind was "Team". entrant_kind on a solo sign-up IS
    // 'team' (RS009 stores it as the division's kind), which is why this
    // must branch on free_agent rather than trust entrant_kind alone.
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ row: row({ free_agent: true }) })));
    expect(text).toContain(t(dict, "reg.hub.registrants.table.soloSignUp"));
    expect(text).not.toContain(t(dict, "divset.entrants.kind.team"));
  });

  it("renders the formatted amount and the card payment method label", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ row: row({ amount_cents: 2500, currency: "usd", payment_method: "stripe" }) })));
    expect(text).toContain("$25");
    expect(text).toContain(t(dict, "reg.settings.cardPayment"));
  });

  it("a whole amount keeps its pence (owner ruling 2026-11-12: '£15.00', never '£15')", () => {
    const text = textOf(RegistrationHubRegistrantDetail(baseProps({ row: row({ amount_cents: 1500, currency: "gbp" }) })));
    expect(text).toContain("£15.00");
    expect(text).not.toMatch(/£15(?![.\d])/);
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

  // RS005 F2 finding 1: offline_marked_paid_at lives on registration_groups
  // (V363/V364) — CART-level, shared by every entry in the cart.
  // markRegistrationPaidOffline stamps it for the whole cart while
  // confirming only ONE entry, so a still-pending SIBLING used to inherit
  // "Paid offline" from it. This entry's own `status` (untouched by the
  // sibling's mark-paid) must win instead.
  it("a still-pending entry reads 'Awaiting payment', never a paid state, even when a SIBLING in its cart was already marked paid offline", () => {
    const text = textOf(
      RegistrationHubRegistrantDetail(
        baseProps({
          row: row({
            status: "pending",
            amount_cents: 1500,
            payment_intent_id: null,
            offline_marked_paid_at: new Date("2026-01-16T09:00:00Z"),
          }),
        }),
      ),
    );
    expect(text).toContain(t(dict, "reg.hub.registrants.detail.paymentState.awaitingPayment"));
  });

  // RS005 F2 finding 2: amount_cents is forced to 0 at submit for EVERY
  // waitlisted entry (registration-submit.ts:542), regardless of the
  // division's real fee — both the "Payment" amount field and the "Payment
  // state" field must say so truthfully rather than "Free".
  it("renders 'not charged yet', never Free, for a waitlisted entry on a fee-bearing division", () => {
    const text = textOf(
      RegistrationHubRegistrantDetail(baseProps({ row: row({ status: "waitlisted", amount_cents: 0 }) })),
    );
    expect(text).not.toContain(t(dict, "reg.hub.row.fee.free"));
    expect(text).toContain(t(dict, "reg.hub.registrants.detail.paymentState.waitlisted"));
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
    // Polish wave P6: the control is handed the competition's public join LINK, not the bare code. Typed from the route's own shape
    // (`/live/<org>/<competition>/register/join?join_code=`), not built by the code under test.
    expect(propsOf(control!).joinPath).toBe("/live/riverside/summer-league/register/join?join_code=TEAM-XYZ");
    expect(propsOf(control!)).not.toHaveProperty("code");
  });

  it("the link follows the competition's slugs and the entry's own code (two competitions, two links)", () => {
    const paths = [
      { orgSlug: "riverside", compSlug: "summer-league", code: "TEAM-AAA" },
      { orgSlug: "harbour", compSlug: "winter-cup", code: "TEAM-BBB" },
    ].map(({ orgSlug, compSlug, code }) => {
      const tree = walk(RegistrationHubRegistrantDetail(baseProps({ row: row({ join_code: code }), canEdit: true, orgSlug, compSlug })));
      return propsOf(tree.find((e) => e.type === RegistrationHubRegistrantJoinCode)!).joinPath;
    });
    expect(paths).toEqual([
      "/live/riverside/summer-league/register/join?join_code=TEAM-AAA",
      "/live/harbour/winter-cup/register/join?join_code=TEAM-BBB",
    ]);
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

  // Polish wave P4 (walkthrough W2): "Consent pending" sat beside a registrant who had ticked the privacy consent on the form, with no
  // word on what it meant. It is the player's OWN confirmation of their place on the roster - a different thing - so the panel says so.
  describe("the pending chip is explained (W2)", () => {
    const NOTE =
      "Pending means the player hasn't confirmed their own place on this roster yet (they do that from their claim email or the team's join link). It is separate from the privacy consent ticked on the registration form.";
    const noteEls = (roster: RegistrantRosterPlayer[]) =>
      walk(RegistrationHubRegistrantDetail(baseProps({ roster }))).filter(
        (e) => propsOf(e)["data-registration-hub-registrant-consent-note"] !== undefined,
      );

    it("a roster with a pending player carries the note, in words, below the list", () => {
      const els = noteEls([PLAYER_A, PLAYER_B]);
      expect(els).toHaveLength(1);
      expect(textOf(els[0]!)).toBe(NOTE);
      expect(t(dict, "reg.hub.registrants.detail.consent.pendingNote")).toBe(NOTE);
    });

    it("the note is also the pending chip's own tooltip, and only the pending chip carries one", () => {
      const tree = walk(RegistrationHubRegistrantDetail(baseProps({ roster: [PLAYER_A, PLAYER_B] })));
      const chips = tree.filter((e) => propsOf(e)["data-registration-hub-registrant-consent"] !== undefined);
      expect(chips.map((c) => propsOf(c)["data-registration-hub-registrant-consent"])).toEqual(["granted", "pending"]);
      expect(propsOf(chips[0]!).title, "a granted chip needs no explaining").toBeUndefined();
      expect(propsOf(chips[1]!).title).toBe(NOTE);
    });

    it("no pending player, or no roster at all: no note (the empty case answers no)", () => {
      expect(noteEls([{ ...PLAYER_A, consent_status: "granted" }, { ...PLAYER_B, consent_status: "guardian" }])).toHaveLength(0);
      expect(noteEls([])).toHaveLength(0);
    });

    it("the note exists in every locale's own words (raw files: getDictionary fills English for a missing key)", () => {
      const key = "reg.hub.registrants.detail.consent.pendingNote";
      const en = JSON.parse(readFileSync(join(__dirname, "..", "..", "dictionaries", "en", "ui.json"), "utf8"))[key] as string;
      let checked = 0;
      for (const loc of ["es", "fr", "nl"]) {
        const v = JSON.parse(readFileSync(join(__dirname, "..", "..", "dictionaries", loc, "ui.json"), "utf8"))[key] as string | undefined;
        expect(typeof v === "string" && v.length > 0, `${loc} has the key`).toBe(true);
        expect(v, `${loc} is not the English copy`).not.toBe(en);
        checked += 1;
      }
      expect(checked).toBe(3);
    });
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
            entry_payment_intent_id: "pi_own_789",
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
      // Polish wave W8: Refund keys off the entry's OWN intent, so it must reach the island distinct from the cart's.
      entryPaymentIntentId: "pi_own_789",
    });
  });

  // Polish wave P5 (carry b): a late payment's refund stays in `refunded_cents` (history) but is not this payment's; the island's
  // Refund cap is what was sent back of the CURRENT payment, the same rule the server's refund applies.
  it("hands the island the CURRENT payment's refunded amount, not the history (a late refund then an in-time payment)", () => {
    const tree = walk(
      RegistrationHubRegistrantDetail(
        baseProps({
          row: row({ status: "confirmed", amount_cents: 1500, refunded_cents: 2200, late_refunded_cents: 1500, entry_payment_intent_id: "pi_now" }),
          canEdit: true,
        }),
      ),
    );
    const actions = tree.find((e) => e.type === RegistrationHubRegistrantActions);
    expect(propsOf(actions!).refundedCents).toBe(700);
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

// ---------------------------------------------------------------------------
// Registration redesign B5 T19 (spec §6.3): the detail shows the ENTRY's own reference, the one a bank transfer quotes, and — for a
// cart sent with 2+ entries — the cart's, so an organiser can tie the entry to the mail the person got about the whole cart.
// ---------------------------------------------------------------------------
const CART = "SZ-7F3K-Q2ND";
const hook = (tree: ReturnType<typeof walk>, attr: string) => tree.filter((e) => attr in propsOf(e));

describe("RegistrationHubRegistrantDetail — the entry's reference (B5 T19)", () => {
  it("a one-entry cart: the Entry reference row carries the cart's reference alone, and there is no Cart line", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ row: row({ ref_code: CART, cart_position: 1, cart_size: 1 }) })));
    const entry = hook(tree, "data-registration-hub-registrant-entry-ref");
    expect(entry, "exactly one entry reference").toHaveLength(1);
    expect(textOf(entry[0]!)).toBe(CART);
    expect(hook(tree, "data-registration-hub-registrant-cart-ref"), "a cart of one has no Cart line").toHaveLength(0);
    expect(textOf(tree)).toContain(t(dict, "reg.hub.registrants.detail.field.entryRef"));
    expect(textOf(tree)).not.toContain(`Cart ${CART}`);
  });

  it("an entry of a 2-entry cart: its own reference with the position, and a Cart line naming the cart's", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ row: row({ ref_code: CART, cart_position: 2, cart_size: 2 }) })));
    expect(textOf(hook(tree, "data-registration-hub-registrant-entry-ref")[0]!)).toBe(`${CART}-2`);
    const cart = hook(tree, "data-registration-hub-registrant-cart-ref");
    expect(cart).toHaveLength(1);
    expect(textOf(cart[0]!)).toBe(`Cart ${CART}`);
  });

  it("is the stored size that decides, not the entries left: the lone survivor of a 3-entry cart is still -3 and still shows the Cart line", () => {
    // `siblings` is empty (the others are gone), exactly the case a count-based rule would read as a one-entry cart.
    const tree = walk(
      RegistrationHubRegistrantDetail(baseProps({ row: row({ ref_code: CART, cart_position: 3, cart_size: 3 }), siblings: [] })),
    );
    expect(textOf(hook(tree, "data-registration-hub-registrant-entry-ref")[0]!)).toBe(`${CART}-3`);
    expect(textOf(hook(tree, "data-registration-hub-registrant-cart-ref")[0]!)).toBe(`Cart ${CART}`);
  });

  it("a cart with no reference shows a dash, and no Cart line whatever its size", () => {
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ row: row({ ref_code: null, cart_position: 2, cart_size: 2 }) })));
    expect(textOf(hook(tree, "data-registration-hub-registrant-entry-ref")[0]!)).toBe("—");
    expect(hook(tree, "data-registration-hub-registrant-cart-ref")).toHaveLength(0);
  });

  it("the row's label and the Cart line are real copy in all four locales, with the reference slot kept", async () => {
    const wording = new Set<string>();
    for (const locale of ["en", "es", "fr", "nl"] as Locale[]) {
      const d = await getDictionary(locale, "ui");
      const label = t(d, "reg.hub.registrants.detail.field.entryRef");
      const cartLine = t(d, "reg.hub.registrants.detail.cartRef", { ref: CART });
      expect(label.length, locale).toBeGreaterThan(3);
      expect(cartLine, locale).toContain(CART);
      expect(cartLine.replace(CART, "").trim().length, `${locale}: a word besides the reference`).toBeGreaterThan(2);
      wording.add(label).add(cartLine);
      // Rendered in that locale, through the component.
      const tree = walk(RegistrationHubRegistrantDetail(baseProps({ dict: d, row: row({ ref_code: CART, cart_position: 2, cart_size: 2 }) })));
      expect(textOf(tree), locale).toContain(label);
      expect(textOf(hook(tree, "data-registration-hub-registrant-cart-ref")[0]!), locale).toBe(cartLine);
    }
    expect(wording.size, "anti-vacuity: four distinct labels and four distinct Cart lines").toBe(8);
  });
});

// Tidy round (T19 ruling, no-new-issues): a long contact email overflowed the detail card at 320. The card is `overflow-hidden`, so
// the email was CLIPPED rather than scrolling the page: a horizontal-scroll check cannot see it. Every grid or flex item on the way
// from the detail's root down to the email's <dd> must be allowed to shrink (`min-w-0`), and the <dd> must wrap a word that cannot fit.
describe("RegistrationHubRegistrantDetail — a long contact email wraps inside the card (tidy)", () => {
  const LONG_EMAIL = "alexandra.featherstonehaugh@riverside-club.test";

  function pathTo(node: ReactNode, pred: (el: ReactElement) => boolean, trail: ReactElement[] = []): ReactElement[] | null {
    if (Array.isArray(node)) {
      for (const n of node) {
        const p = pathTo(n, pred, trail);
        if (p) return p;
      }
      return null;
    }
    if (!isValidElement(node)) return null;
    const here = [...trail, node];
    if (pred(node)) return here;
    return pathTo((node.props as { children?: ReactNode }).children, pred, here);
  }
  const classOf = (el: ReactElement) => String((el.props as { className?: string }).className ?? "");

  it("every grid/flex item from the root to the email's <dd> may shrink, and the <dd> breaks the word", () => {
    expect(LONG_EMAIL.length, "premise: longer than a 320px card's text width holds").toBeGreaterThanOrEqual(35);
    const path = pathTo(
      RegistrationHubRegistrantDetail(baseProps({ row: row({ contact_email: LONG_EMAIL }) })),
      (el) => el.type === "dd" && (el.props as { children?: unknown }).children === LONG_EMAIL,
    );
    expect(path, "the email's <dd>").not.toBeNull();
    let checked = 0;
    for (let i = 1; i < path!.length; i++) {
      if (!/(^|\s)(grid|flex|inline-flex)(\s|$)/.test(classOf(path![i - 1]!))) continue;
      expect(classOf(path![i]!), `<${String(path![i]!.type)}> inside <${String(path![i - 1]!.type)} class="${classOf(path![i - 1]!)}">`).toMatch(
        /(^|\s)min-w-0(\s|$)/,
      );
      checked += 1;
    }
    expect(checked, "the section in the grid and the <dd> in its row").toBe(2);
    expect(classOf(path!.at(-1)!), "the <dd> wraps a word too long for it").toMatch(/(^|\s)break-words(\s|$)/);
  });
});

// Guardian consent for minors (owner rec, 2026-11-14): a parent now routinely consents for the children they enter, so the organiser,
// who confirms they hold guardian consent for a youth division, sees WHO gave it on the player's row — "Consent by guardian: <name>" —
// wherever the row carries a guardian's name: a child consented for at submit or at their own claim ('guardian'), and a registrant
// under 18 whose own row was consented with their guardian ('granted', guardian_name set). No name, or a blank one: no line.
describe("RegistrationHubRegistrantDetail — the guardian who consented is named (owner rec)", () => {
  const guardianLines = (roster: RegistrantRosterPlayer[]) =>
    walk(RegistrationHubRegistrantDetail(baseProps({ roster }))).filter(
      (e) => propsOf(e)["data-registration-hub-registrant-guardian"] !== undefined,
    );

  it("names the guardian on each row that has one, beside that row's own chip, and on no other row", () => {
    const roster: RegistrantRosterPlayer[] = [
      { ...PLAYER_A, consent_status: "granted", guardian_name: null },
      { id: "p3", full_name: "Mia Cole", squad_number: null, is_captain: false, consent_status: "guardian", guardian_name: "Pat Parent" },
      { id: "p4", full_name: "Kai Teen", squad_number: null, is_captain: false, consent_status: "granted", guardian_name: "Mum Teen" },
      { ...PLAYER_B, consent_status: "pending" },
    ];
    const tree = walk(RegistrationHubRegistrantDetail(baseProps({ roster })));
    const rows = tree.filter((e) => propsOf(e)["data-registration-hub-registrant-roster-player"] !== undefined);
    expect(rows, "premise: one row per player").toHaveLength(4);
    const lineOf = (rowEl: ReactElement) =>
      walk(rowEl).filter((e) => propsOf(e)["data-registration-hub-registrant-guardian"] !== undefined).map((e) => textOf(e));
    expect(rows.map(lineOf)).toEqual([[], ["Consent by guardian: Pat Parent"], ["Consent by guardian: Mum Teen"], []]);
    expect(t(dict, "reg.hub.registrants.detail.consent.guardianBy", { name: "Pat Parent" })).toBe("Consent by guardian: Pat Parent");
  });

  it("no guardian's name, a blank one, or no roster: no line (the empty case answers no)", () => {
    let checked = 0;
    for (const roster of [
      [],
      [{ ...PLAYER_A, guardian_name: null }],
      [{ ...PLAYER_B, consent_status: "guardian" as const, guardian_name: "   " }],
      [PLAYER_A, PLAYER_B],
    ]) {
      expect(guardianLines(roster)).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the line's words are translated in every locale and carry the name", () => {
    let checked = 0;
    for (const loc of ["en", "es", "fr", "nl"] as const) {
      const raw = JSON.parse(readFileSync(join(process.cwd(), "src", "dictionaries", loc, "ui.json"), "utf8")) as Record<string, string>;
      const words = raw["reg.hub.registrants.detail.consent.guardianBy"];
      expect(words, loc).toBeTypeOf("string");
      expect(words, loc).toContain("{name}");
      checked++;
    }
    expect(checked).toBe(4);
  });
});
