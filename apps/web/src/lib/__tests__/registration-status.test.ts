// RS004 W3b review finding 1 — `SPOT_HOLDERS` was hand-duplicated:
// usecases/registrations/ declared the canonical array, and the registration hub's
// page.tsx declared a byte-identical SECOND copy locally (to avoid dragging
// usecases/registrations/ folder's Stripe/email clients into a read-only page — a sound
// reason; the duplicate was not). This module is now the ONE place the list
// is declared; usecases/registrations/ re-exports it (so its three existing
// importers — itself, registration-approval.ts, registration-submit.ts —
// need no change) and page.tsx imports it directly from here.
//
// These three tests pin exactly the defect described above: (1) the list's
// contents, (2) that usecases/registrations/ folder's export is the SAME binding, not a
// second array that can drift, and (3) that page.tsx's source carries no
// local re-declaration at all.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import { SPOT_HOLDERS as fromRegistrations } from "@/server/usecases/registrations";

describe("SPOT_HOLDERS — single source of truth", () => {
  it("holds exactly the three spot-holding statuses", () => {
    expect(SPOT_HOLDERS).toEqual(["pending", "paid", "confirmed"]);
  });

  it("registrations.ts re-exports the SAME array — not a second copy that can drift", () => {
    expect(fromRegistrations).toBe(SPOT_HOLDERS);
  });

  it("the registration hub's data layer has no local re-declaration — it imports from this module", () => {
    // `data.ts`, not `page.tsx`: the hub's query moved out of the page module
    // when app-module-exports.test.ts caught the page exporting helpers Next
    // does not tolerate. The constant went with the query it belongs to.
    const hubDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "..", "app", "o", "[orgSlug]", "c", "[compSlug]", "registration",
    );
    const data = readFileSync(join(hubDir, "data.ts"), "utf8");
    expect(data).toContain('from "@/lib/registration-status"');
    expect(data).not.toMatch(/const SPOT_HOLDERS\s*=/);
    // …and the page it moved out of did not keep a copy on the way past.
    const page = readFileSync(join(hubDir, "page.tsx"), "utf8");
    expect(page).not.toMatch(/const SPOT_HOLDERS\s*=/);
  });
});

// Polish wave P2: what an entry that is not yet confirmed is WAITING ON. One derivation for the mails (cart confirmation entry lines,
// the joiner's confirmation) so "Pending" is never the whole answer. Every status x fee x approval cell is enumerated; the expected
// answers are typed from the rules (a fee is owed only while pending; a manual-approval division always needs the organiser's yes),
// never read back from the function.
import { entryStanding, entryWaitingOn } from "@/lib/registration-status";

describe("entryWaitingOn", () => {
  const STATUSES = ["pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected"] as const;
  const EXPECTED: Record<string, "payment" | "approval" | "payment_and_approval" | null> = {
    "pending|fee|auto": "payment",
    "pending|fee|manual": "payment_and_approval",
    "pending|free|auto": null,
    "pending|free|manual": "approval",
    "paid|fee|auto": null,
    "paid|fee|manual": "approval",
    "paid|free|auto": null,
    "paid|free|manual": "approval",
  };

  it("enumerates every status x fee x approval cell (anti-vacuity: 7 statuses x 2 x 2 = 28 cells checked)", () => {
    let checked = 0;
    for (const status of STATUSES) {
      for (const [feeLabel, feeCents] of [["fee", 2500], ["free", 0]] as const) {
        for (const approval of ["auto", "manual"] as const) {
          const want = EXPECTED[`${status}|${feeLabel}|${approval}`] ?? null;
          expect(entryWaitingOn(status, feeCents, approval, false), `${status} ${feeLabel} ${approval}`).toBe(want);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(28);
  });

  it("an unknown status waits on nothing (never throws on a value the column could grow)", () => {
    expect(entryWaitingOn("something_new", 2500, "manual", false)).toBeNull();
  });

  // Polish wave P5 (W12): the organiser approved an entry whose fee was still owed (`approved_at`, V511). Their yes is given, so the entry
  // waits on what an entry that needs no yes waits on: the expected value is the SAME table's auto-approval cell, never this function's
  // own output. The approved stamp never adds a wait (an auto division's cells are unchanged by it).
  it("an approved entry waits on what an auto-approval entry waits on: every status x fee x approval cell (28 checked)", () => {
    let checked = 0;
    let differs = 0;
    for (const status of STATUSES) {
      for (const [feeLabel, feeCents] of [["fee", 2500], ["free", 0]] as const) {
        for (const approval of ["auto", "manual"] as const) {
          const want = EXPECTED[`${status}|${feeLabel}|auto`] ?? null;
          expect(entryWaitingOn(status, feeCents, approval, true), `approved ${status} ${feeLabel} ${approval}`).toBe(want);
          if (want !== (EXPECTED[`${status}|${feeLabel}|${approval}`] ?? null)) differs += 1;
          checked += 1;
        }
      }
    }
    expect(checked).toBe(28);
    // The cells where approval changes the answer (manual pending/paid): the witness that this test can see the flag at all.
    expect(differs).toBe(4);
  });

  it("the headline: a manual entry approved while its fee is owed waits on payment alone; unapproved, on both", () => {
    expect(entryWaitingOn("pending", 2500, "manual", true)).toBe("payment");
    expect(entryWaitingOn("pending", 2500, "manual", false)).toBe("payment_and_approval");
  });
});

describe("entryStanding", () => {
  it("reads the approved stamp too: an approved unpaid entry stands on its payment alone (polish wave P5, W12)", () => {
    expect(entryStanding("pending", 2500, "manual", true)).toBe("payment");
    expect(entryStanding("pending", 2500, "manual", false)).toBe("payment_and_approval");
    // An unreadable review mode names nothing, approved or not; confirmed stays confirmed.
    expect(entryStanding("pending", 2500, null, true)).toBeNull();
    expect(entryStanding("confirmed", 2500, "manual", true)).toBe("confirmed");
  });
});
