import { type Dict, t } from "@/lib/i18n";
import type { AdminCaptureRecord } from "@/server/usecases/admin-capture-records";

/**
 * One stored capture record (spec 2026-10-12 §10): its ref, time, slot and code id (no tok is stored, so none can be
 * shown), its counts, and its KEPT lines as a table — `at`, `kind`, `level`, `sid`, then the other fields as
 * `key=value`. Staff-only and desktop-only (/admin): the wide table scrolls inside its own box.
 */
export function CaptureRecordView({ record, dict }: { record: AdminCaptureRecord; dict: Dict }) {
  return (
    <section
      data-testid="capture-record"
      data-ref={record.ref}
      className="space-y-3 rounded-lg border border-slate-700 bg-slate-900 p-4"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="font-mono text-lg font-bold text-white" data-testid="capture-record-ref">{record.ref}</h2>
        <p className="text-sm text-slate-300" data-testid="capture-record-counts">
          {t(dict, "admin.captureRecords.counts", { received: record.received, kept: record.kept, dropped: record.dropped })}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Field label={t(dict, "admin.captureRecords.sentAt")} value={record.createdAt.toISOString()} />
        <Field label={t(dict, "admin.captureRecords.expiresAt")} value={record.expiresAt.toISOString()} />
        <Field label={t(dict, "admin.captureRecords.slot")} value={String(record.slot)} />
        <Field label={t(dict, "admin.captureRecords.codeId")} value={record.codeId} mono />
        <Field label={t(dict, "admin.captureRecords.fixtureId")} value={record.fixtureId} mono />
        <Field
          label={t(dict, "admin.captureRecords.sessions")}
          value={record.sessionIds.length > 0 ? record.sessionIds.join(", ") : t(dict, "admin.captureRecords.noSession")}
          mono={record.sessionIds.length > 0}
        />
      </dl>
      {record.lines.length === 0 ? (
        <p className="text-sm text-slate-400" data-testid="capture-record-no-lines">{t(dict, "admin.captureRecords.noLines")}</p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="text-slate-500">
              <tr>
                <th className="px-2 py-1 font-semibold">{t(dict, "admin.captureRecords.col.at")}</th>
                <th className="px-2 py-1 font-semibold">{t(dict, "admin.captureRecords.col.kind")}</th>
                <th className="px-2 py-1 font-semibold">{t(dict, "admin.captureRecords.col.level")}</th>
                <th className="px-2 py-1 font-semibold">{t(dict, "admin.captureRecords.col.sid")}</th>
                <th className="px-2 py-1 font-semibold">{t(dict, "admin.captureRecords.col.fields")}</th>
              </tr>
            </thead>
            <tbody>
              {record.lines.map((line, i) => (
                <tr key={i} className="border-t border-slate-800 align-top" data-testid="capture-record-line" data-kind={line.kind}>
                  <td className="whitespace-nowrap px-2 py-1 font-mono">{line.at}</td>
                  <td className="whitespace-nowrap px-2 py-1">{line.kind}</td>
                  <td className="px-2 py-1">{line.level ?? "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono">{line.sid ?? "—"}</td>
                  <td className="px-2 py-1 font-mono break-all">
                    {line.fields.map(([k, v]) => `${k}=${v}`).join("  ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`break-words text-slate-200 ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
