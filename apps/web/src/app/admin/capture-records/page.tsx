import Link from "@/components/ui/console-link";
import { requireStaff } from "@/lib/admin";
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { captureRecordByRef, normaliseRecordRef } from "@/server/usecases/admin-capture-records";
import { CaptureRecordView } from "./record-view";

export const dynamic = "force-dynamic";

/**
 * Capture records by ref (spec 2026-10-12 §10, P7/Q5) — the support path: the operator reads the ref aloud, the
 * organiser passes it on, staff look it up here. Staff-only — the page asks itself (review fix 3: a Next layout
 * does not gate its segments), and so does each read it calls — and desktop-only.
 */
export default async function AdminCaptureRecordsPage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  await requireStaff();
  const { ref } = await searchParams;
  const typed = (ref ?? "").trim();
  const normalised = normaliseRecordRef(typed);
  const record = normalised === null ? null : await captureRecordByRef(normalised);
  const dict = await getDictionary(await resolveLocale(), "ui");

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 text-xs text-slate-500">
          <Link href="/admin" className="hover:text-white">{t(dict, "admin.captureRecords.breadcrumb")}</Link> / {t(dict, "admin.captureRecords.title")}
        </p>
        <h1 className="text-xl font-bold text-white">{t(dict, "admin.captureRecords.title")}</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">{t(dict, "admin.captureRecords.intro")}</p>
      </div>

      <form method="get" className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          name="ref"
          defaultValue={typed}
          aria-label={t(dict, "admin.captureRecords.refLabel")}
          data-testid="capture-record-ref-input"
          placeholder="R-7K2Q"
          className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-700 px-2 py-1 font-mono text-sm text-white placeholder:text-slate-500"
        />
        <button type="submit" className="rounded bg-slate-700 px-3 py-1 text-sm font-semibold text-white">
          {t(dict, "admin.captureRecords.lookUp")}
        </button>
      </form>

      {typed.length > 0 && normalised === null && (
        <p className="text-sm text-amber-400" data-testid="capture-record-not-found">{t(dict, "admin.captureRecords.notARef")}</p>
      )}
      {normalised !== null && record === null && (
        <p className="text-sm text-amber-400" data-testid="capture-record-not-found">{t(dict, "admin.captureRecords.notFound")}</p>
      )}
      {record && <CaptureRecordView record={record} dict={dict} />}
    </div>
  );
}
