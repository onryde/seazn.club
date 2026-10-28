// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, cookieHeader, raw, check, setStaff } from "../harness.ts";

/** design/v7 PROMPT-51: staff revenue report — guard, rollup shape, CSV
 *  header. A keyless env asserts the 503 guard instead of the rollup. */
export async function platformRevenueSuite(admin: Session, staffEmail: string): Promise<void> {
  const denied = await raw(admin, "/api/admin/revenue");
  check("revenue denied to non-staff", denied.status === 401);

  await setStaff(staffEmail, "superadmin");
  try {
    const res = await raw(admin, "/api/admin/revenue");
    if (res.status === 503) {
      check("revenue 503s without Stripe key", res.json.error === "Stripe is not configured");
    } else {
      const data = res.json.data as {
        byMonth?: unknown;
        byOrg?: unknown;
        rows?: unknown[];
      };
      check(
        "revenue JSON rollups",
        res.status === 200 && !!data.byMonth && !!data.byOrg && Array.isArray(data.rows),
      );
      const csv = await fetch(BASE + "/api/admin/revenue?format=csv", {
        headers: { cookie: cookieHeader(admin) },
      });
      const firstLine = (await csv.text()).split("\n")[0];
      check(
        "revenue CSV header",
        csv.status === 200 &&
          firstLine ===
            "month,org,org_slug,currency,gross_minor,refunded_minor,net_minor,fee_count",
      );
    }
    const bad = await raw(admin, "/api/admin/revenue?from=notadate");
    check("revenue 400s on malformed range", bad.status === 400);
  } finally {
    await setStaff(staffEmail, null);
  }
}
