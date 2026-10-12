import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { captureRecordsOfFixture } from "@/server/usecases/admin-capture-records";
import { CaptureRecordView } from "./record-view";

/**
 * The fixture page's Capture records section (spec 2026-10-12 §10, P7/Q5): beside each of the fixture's stream
 * sessions, the records linked to it; then the fixture's records that name no session.
 */
export async function FixtureCaptureRecords({ fixtureId }: { fixtureId: string }) {
  const [{ sessions, unlinked }, dict] = await Promise.all([
    captureRecordsOfFixture(fixtureId),
    resolveLocale().then((locale) => getDictionary(locale, "ui")),
  ]);
  const none = sessions.every((s) => s.records.length === 0) && unlinked.length === 0;
  return (
    <section className="space-y-4" data-testid="capture-records-section">
      <h2 className="text-lg font-bold text-white">{t(dict, "admin.captureRecords.fixtureSection")}</h2>
      {none && <p className="text-sm text-slate-400" data-testid="capture-records-none">{t(dict, "admin.captureRecords.noneForFixture")}</p>}
      {sessions.map((s) => (
        <div key={s.id} className="space-y-2" data-testid="capture-records-session" data-session-id={s.id}>
          <h3 className="font-mono text-sm text-slate-300">{t(dict, "admin.captureRecords.session", { id: s.id, state: s.state })}</h3>
          {s.records.length === 0
            ? <p className="text-xs text-slate-500">{t(dict, "admin.captureRecords.noneForSession")}</p>
            : s.records.map((r) => <CaptureRecordView key={r.id} record={r} dict={dict} />)}
        </div>
      ))}
      {unlinked.length > 0 && (
        <div className="space-y-2" data-testid="capture-records-unlinked">
          <h3 className="text-sm text-slate-300">{t(dict, "admin.captureRecords.unlinked")}</h3>
          {unlinked.map((r) => <CaptureRecordView key={r.id} record={r} dict={dict} />)}
        </div>
      )}
    </section>
  );
}
