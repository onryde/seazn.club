// RS004 W3b review finding 1 — `SPOT_HOLDERS` was hand-duplicated:
// registrations.ts declared the canonical array, and the registration hub's
// page.tsx declared a byte-identical SECOND copy locally (to avoid dragging
// registrations.ts's Stripe/email clients into a read-only page — a sound
// reason; the duplicate was not). This module is now the ONE place the list
// is declared; registrations.ts re-exports it (so its three existing
// importers — itself, registration-approval.ts, registration-submit.ts —
// need no change) and page.tsx imports it directly from here.
//
// These three tests pin exactly the defect described above: (1) the list's
// contents, (2) that registrations.ts's export is the SAME binding, not a
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
