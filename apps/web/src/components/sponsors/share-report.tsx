"use client";
// The Share report panel (R4 sponsors on stream, S13; spec 2026-10-27 §5.1 "Share report", §5.2): opened under one sponsor's
// row on the Overview. Editors only - the Overview mounts it for nobody else, and both routes refuse a viewer anyway (R19).
//
//   Create  POST   /api/v1/orgs/{id}/sponsors/{sponsorId}/report-links   { competitionId, from, to }  -> { id, url }
//   Revoke  DELETE /api/v1/orgs/{id}/sponsor-report-links/{linkId}
//
// The url is answered ONCE (only the token's hash is stored), so it lives in this panel's state and nowhere else: shown read-only
// with a Copy button until Done, then gone. A lost link is revoked and made again. The list below is the server's (props, after
// `router.refresh()`); a revoke hides its row at once, and the next props are the truth from then on.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import { fmtIsoDay, isIsoDay, type ReportLinkDefaults, type ReportLinkSummary } from "@/lib/sponsor-report";

export interface ShareReportProps {
  /** The panel's element id: the row's Share report button points `aria-controls` at it. */
  id: string;
  orgId: string;
  sponsor: { id: string; name: string };
  /** The period on screen, as dates (and its competition, for a competition period). */
  defaults: ReportLinkDefaults;
  /** The competition's name when `defaults.competitionId` is set. */
  competitionName: string | null;
  /** This sponsor's live links. */
  links: ReportLinkSummary[];
  onClose: () => void;
}

export function ShareReport(props: ShareReportProps) {
  const { id, orgId, sponsor, defaults, competitionName, links, onClose } = props;
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const router = useRouter();

  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  // The period picker is a `router.push` to the same page with a new `?period=`, and Next keeps client state across a
  // search-param navigation - so an open panel would keep the OLD period's dates while `defaults.competitionId` follows the
  // new one, and Create would mint a link with one period's scope and another's dates. When the defaults' VALUES change, the
  // form re-opens at them (render-phase reset, never an effect). Compared by value: a refresh that hands the same period back
  // as a new object keeps what the organiser typed. A url already on screen is kept - it is shown only this once.
  const [seenDefaults, setSeenDefaults] = useState(defaults);
  if (
    seenDefaults.from !== defaults.from ||
    seenDefaults.to !== defaults.to ||
    seenDefaults.competitionId !== defaults.competitionId
  ) {
    setSeenDefaults(defaults);
    setFrom(defaults.from);
    setTo(defaults.to);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The absolute url, while it is on screen - the only copy that exists. */
  const [created, setCreated] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [confirming, setConfirming] = useState<string | null>(null);
  // Rows revoked here, hidden until the server's next list arrives (then dropped: the props are the truth).
  const [seen, setSeen] = useState(links);
  const [gone, setGone] = useState<readonly string[]>([]);
  if (seen !== links) {
    setSeen(links);
    setGone([]);
  }
  const visible = links.filter((l) => !gone.includes(l.id));

  const datesValid = isIsoDay(from) && isIsoDay(to);
  const inverted = datesValid && to < from;
  const canCreate = datesValid && !inverted && !busy;

  async function create(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const out = await apiV1<{ id: string; url: string }>(`/api/v1/orgs/${orgId}/sponsors/${sponsor.id}/report-links`, {
        method: "POST",
        json: { competitionId: defaults.competitionId, from, to },
      });
      setCreated(new URL(out.url, window.location.origin).href);
      setCopy("idle");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  function copyLink() {
    if (created === null) return;
    navigator.clipboard.writeText(created).then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  }

  async function revoke(linkId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/orgs/${orgId}/sponsor-report-links/${linkId}`, { method: "DELETE" });
      setGone((g) => [...g, linkId]);
      setConfirming(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const titleId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-testid="sponsor-share"
      className="mt-3 grid min-w-0 gap-4 rounded-xl border border-purple-100 bg-purple-50/50 p-3 sm:p-4"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h3 id={titleId} className="min-w-0 break-words text-sm font-semibold text-slate-800">
          {msg("sponsors.share.title", { name: sponsor.name })}
        </h3>
        <button type="button" className="btn btn-ghost shrink-0 px-2.5 py-1 text-xs" data-testid="sponsor-share-close" onClick={onClose}>
          {msg("sponsors.share.close")}
        </button>
      </div>
      <p className="max-w-prose text-xs text-slate-600">{msg("sponsors.share.help")}</p>

      {created !== null ? (
        <div role="status" data-testid="sponsor-share-once" className="grid min-w-0 gap-2 rounded-lg border border-purple-200 bg-white p-3">
          <p className="text-sm font-medium text-slate-800">{msg("sponsors.share.onceTitle")}</p>
          <p className="text-xs text-slate-600">{msg("sponsors.share.onceHelp")}</p>
          <label htmlFor={`${id}-url`} className="label mb-0 mt-1">
            {msg("sponsors.share.linkLabel")}
          </label>
          <input
            id={`${id}-url`}
            data-testid="sponsor-share-url"
            className="ph-no-capture input min-w-0 text-xs"
            readOnly
            value={created}
            onFocus={(e) => e.target.select()}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" data-testid="sponsor-share-copy" onClick={copyLink}>
              {copy === "copied" ? msg("sponsors.share.copied") : msg("sponsors.share.copy")}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="sponsor-share-done"
              onClick={() => {
                setCreated(null);
                setCopy("idle");
              }}
            >
              {msg("sponsors.share.done")}
            </button>
          </div>
          {copy === "failed" && (
            <p role="alert" className="text-xs text-red-600" data-testid="sponsor-share-copy-failed">
              {msg("sponsors.share.copyFailed")}
            </p>
          )}
        </div>
      ) : (
        <form data-testid="sponsor-share-form" className="grid min-w-0 gap-3" onSubmit={create}>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <div className="grid min-w-0">
              <label htmlFor={`${id}-from`} className="label">
                {msg("sponsors.share.from")}
              </label>
              <input
                id={`${id}-from`}
                type="date"
                data-testid="sponsor-share-from"
                className="input min-w-0"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="grid min-w-0">
              <label htmlFor={`${id}-to`} className="label">
                {msg("sponsors.share.to")}
              </label>
              <input
                id={`${id}-to`}
                type="date"
                data-testid="sponsor-share-to"
                className="input min-w-0"
                value={to}
                aria-invalid={inverted || undefined}
                aria-describedby={inverted ? `${id}-range` : undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary" data-testid="sponsor-share-create" disabled={!canCreate}>
              {busy ? msg("sponsors.share.creating") : msg("sponsors.share.create")}
            </button>
          </div>
          {inverted && (
            <p id={`${id}-range`} className="text-xs text-red-600" data-testid="sponsor-share-range">
              {msg("comp.validation.endsBeforeStarts")}
            </p>
          )}
          {defaults.competitionId !== null && competitionName !== null && (
            <p className="text-xs text-slate-600" data-testid="sponsor-share-competition">
              {msg("sponsors.share.competition", { competition: competitionName })}
            </p>
          )}
        </form>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-red-600" data-testid="sponsor-share-error">
          {error}
        </p>
      )}

      <div className="grid min-w-0 gap-2">
        <h4 className="text-xs font-medium text-slate-600">{msg("sponsors.share.active")}</h4>
        {visible.length === 0 ? (
          <p className="text-xs text-slate-500" data-testid="sponsor-share-none">
            {msg("sponsors.share.none")}
          </p>
        ) : (
          <ul className="grid min-w-0 gap-2">
            {visible.map((l) => (
              <li
                key={l.id}
                data-testid={`sponsor-share-link-${l.id}`}
                className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg bg-white px-3 py-2 text-xs"
              >
                <span className="grid min-w-0">
                  <span className="font-medium text-slate-700">
                    {msg("sponsors.share.period", { from: fmtIsoDay(locale, l.from), to: fmtIsoDay(locale, l.to) })}
                  </span>
                  {l.competitionName !== null && <span className="truncate text-slate-500">{l.competitionName}</span>}
                  <span className="text-slate-500">{msg("sponsors.share.created", { date: fmtIsoDay(locale, l.createdAt.slice(0, 10)) })}</span>
                </span>
                {confirming === l.id ? (
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-slate-700">{msg("sponsors.share.revokeConfirm")}</span>
                    <button
                      type="button"
                      className="btn btn-danger px-2.5 py-1 text-xs"
                      data-testid={`sponsor-share-revoke-yes-${l.id}`}
                      disabled={busy}
                      onClick={() => void revoke(l.id)}
                    >
                      {msg("sponsors.share.revokeYes")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost px-2.5 py-1 text-xs"
                      data-testid={`sponsor-share-revoke-cancel-${l.id}`}
                      onClick={() => setConfirming(null)}
                    >
                      {msg("confirm.cancel")}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost px-2.5 py-1 text-xs"
                    data-testid={`sponsor-share-revoke-${l.id}`}
                    onClick={() => setConfirming(l.id)}
                  >
                    {msg("sponsors.share.revoke")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
