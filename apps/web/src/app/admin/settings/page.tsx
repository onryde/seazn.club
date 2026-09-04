import Link from "@/components/ui/console-link";
import { platformFeeDefault } from "@/lib/platform-settings";
import { requireStaff } from "@/lib/admin";
import { AdminPlatformSettings } from "@/components/admin-platform-settings";

export const dynamic = "force-dynamic";

/** Platform settings (spec §5) — layout enforces staff; the API re-checks
 *  superadmin on write, so the form must express that same split or a support
 *  user is handed a Save that can only 401. */
export default async function AdminSettingsPage() {
  // Check THEN fetch, in that order and not concurrently. `Promise.all` starts
  // the fee read before the authz check has resolved; nothing escapes today
  // (`requireStaff()` redirects, and the value is discarded on the way out),
  // but it inverts check-then-fetch for no gain — the fee read is a single
  // cached row, not the slow path — and every one of the six sibling admin
  // pages awaits `requireStaff()` first.
  const staff = await requireStaff();
  const fee = await platformFeeDefault();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Platform settings</h1>
        <p className="text-xs text-slate-500 mt-1">
          Fee resolution: org override → plan entitlement (registration.fee_percent) → this
          default → PLATFORM_FEE_PERCENT env → 5.
        </p>
      </div>
      <AdminPlatformSettings
        initialFeePercent={fee}
        canWrite={staff.staff_role === "superadmin"}
      />
      <p className="text-xs text-slate-500">
        See what the cut has earned →{" "}
        <Link href="/admin/revenue" className="text-purple-300 hover:text-white">
          Revenue
        </Link>
      </p>
    </div>
  );
}
