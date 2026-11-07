"use client";
// Match Day code sheet (capture S4 design §3, §9 item 1; MD-1 Task 2): the organiser mints the one-day QR the Seazn Club
// app scans, and withdraws it. Opened from the Match Day header, editors only (the doors refuse anyone else on their own:
// POST/GET /competitions/{id}/match-day-codes and POST /match-day-codes/{id}/revoke are editor-session only).
//
// The form: what the code covers (the whole competition, one venue, or some courts), its day (today by default) and
// "Can approve draws" (off by default). A minted code shows as the Seazn QR, sensitive (it is a credential), above the
// competition's codes that can still open, each with Show QR and Withdraw.
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { PHONE_HANDOVER_QR_MAX_PX, SeaznQrImage } from "@/components/v2/seazn-qr-image";
import { apiV1 } from "@/lib/client-v1";
import { fmtPublicDate } from "@/lib/format";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchDayCourt } from "@/lib/match-day/types";
import { renderSeaznQr, type SeaznQr } from "@/lib/seazn-qr";
import type { MatchDayCode, MatchDayCodeScope } from "@/server/api-v1/schemas";

type ScopeKind = MatchDayCodeScope["kind"];
type Busy = { kind: "minting" } | { kind: "withdrawing"; id: string } | null;

export interface MatchDayCodeSheetProps {
  competitionId: string;
  dict: Dict;
  locale: Locale;
  /** The organisation's day (`MatchDayView.date`, YYYY-MM-DD): the default, and the earliest a code may be for. */
  today: string;
  /** Every court on the board, for the venue and court pickers. */
  courts: readonly MatchDayCourt[];
  /** The venues with a match today (`MatchDayView.venues_today`): offered first; every venue on the board when empty. */
  venuesToday: readonly string[];
  onClose: () => void;
}

/** The venues the picker offers: today's, else every venue on the board, each once, in board order. */
export function codeVenues(courts: readonly MatchDayCourt[], venuesToday: readonly string[]): { id: string; name: string }[] {
  const all = new Map<string, string>();
  for (const c of courts) if (!all.has(c.venue_id)) all.set(c.venue_id, c.venue_name);
  const today = [...all].filter(([id]) => venuesToday.includes(id));
  return (today.length > 0 ? today : [...all]).map(([id, name]) => ({ id, name }));
}

/** What a listed code covers, in words: the competition, the venue's name, or the courts' names. */
export function scopeWords(dict: Dict, scope: MatchDayCodeScope, courts: readonly MatchDayCourt[]): string {
  if (scope.kind === "competition") return t(dict, "matchDay.code.scope.competition");
  if (scope.kind === "venue") return courts.find((c) => c.venue_id === scope.venue_id)?.venue_name ?? t(dict, "matchDay.code.scope.venue");
  const names = scope.court_ids.map((id) => courts.find((c) => c.court_id === id)?.court_name).filter((n): n is string => !!n);
  return names.length > 0 ? names.join(", ") : t(dict, "matchDay.code.scope.courts");
}

/** The request body for the form's choice; null while it names nothing to cover (no venue, no court ticked). */
export function scopeBody(kind: ScopeKind, venueId: string | null, courtIds: ReadonlySet<string>): MatchDayCodeScope | null {
  if (kind === "competition") return { kind };
  if (kind === "venue") return venueId === null ? null : { kind, venue_id: venueId };
  return courtIds.size === 0 ? null : { kind, court_ids: [...courtIds] };
}

export function MatchDayCodeSheet({ competitionId, dict, locale, today, courts, venuesToday, onClose }: MatchDayCodeSheetProps) {
  const venues = codeVenues(courts, venuesToday);
  const [kind, setKind] = useState<ScopeKind>("competition");
  const [venueId, setVenueId] = useState<string | null>(venues[0]?.id ?? null);
  const [courtIds, setCourtIds] = useState<ReadonlySet<string>>(new Set());
  const [day, setDay] = useState(today);
  const [canApprove, setCanApprove] = useState(false);
  const [codes, setCodes] = useState<MatchDayCode[] | null>(null);
  const [shown, setShown] = useState<{ id: string; qr: SeaznQr } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [failed, setFailed] = useState(false);
  const base = `/api/v1/competitions/${competitionId}/match-day-codes`;

  const reload = useCallback(async () => {
    try {
      const list = await apiV1<MatchDayCode[] | undefined>(base);
      setCodes(Array.isArray(list) ? list : []);
    } catch {
      setFailed(true);
    }
  }, [base]);
  // The first read, on open. A cut-off 200 (undefined) reads as an empty list, never a crash.
  useEffect(() => {
    const ctl = new AbortController();
    apiV1<MatchDayCode[] | undefined>(base, { signal: ctl.signal })
      .then((list) => setCodes(Array.isArray(list) ? list : []))
      .catch(() => {
        if (!ctl.signal.aborted) setFailed(true);
      });
    return () => ctl.abort();
  }, [base]);

  const show = async (code: MatchDayCode) => setShown({ id: code.id, qr: await renderSeaznQr(code.url) });
  const body = scopeBody(kind, venueId, courtIds);

  const mint = async () => {
    if (body === null || busy !== null) return;
    setBusy({ kind: "minting" });
    setFailed(false);
    try {
      const code = await apiV1<MatchDayCode>(base, { method: "POST", json: { scope: body, day, can_approve: canApprove } });
      await show(code);
      await reload();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async (id: string) => {
    if (busy !== null) return;
    setBusy({ kind: "withdrawing", id });
    setFailed(false);
    try {
      await apiV1(`/api/v1/match-day-codes/${id}/revoke`, { method: "POST" });
      setShown((s) => (s?.id === id ? null : s));
      await reload();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const toggleCourt = (id: string) =>
    setCourtIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal
      title={t(dict, "matchDay.code.title")}
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose} className="btn btn-ghost min-h-11">
          {t(dict, "matchDay.code.close")}
        </button>
      }
    >
      <div data-testid="md-code-sheet" className="grid gap-4">
        <p className="text-sm text-slate-600">{t(dict, "matchDay.code.intro")}</p>
        <ScopePicker
          dict={dict}
          kind={kind}
          onKind={setKind}
          venues={venues}
          venueId={venueId}
          onVenue={setVenueId}
          courts={courts}
          courtIds={courtIds}
          onCourt={toggleCourt}
        />
        <label className="grid gap-1 text-sm">
          <span className="font-medium text-slate-800">{t(dict, "matchDay.code.day")}</span>
          <input
            type="date"
            data-testid="md-code-day"
            className="input min-h-11"
            value={day}
            min={today}
            onChange={(e) => setDay(e.target.value || today)}
          />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" data-testid="md-code-approve" checked={canApprove} onChange={(e) => setCanApprove(e.target.checked)} />
          <span>{t(dict, "matchDay.code.approve")}</span>
        </label>
        <button
          type="button"
          data-testid="md-code-mint"
          disabled={body === null || busy !== null}
          onClick={() => void mint()}
          className="btn btn-primary min-h-11"
        >
          {busy?.kind === "minting" ? t(dict, "matchDay.code.minting") : t(dict, "matchDay.code.mint")}
        </button>
        {failed && (
          <p role="alert" data-testid="md-code-failed" className="text-sm text-amber-800">
            {t(dict, "matchDay.code.failed")}
          </p>
        )}
        {shown !== null && (
          <div data-testid="md-code-qr" className="mx-auto w-full max-w-xs">
            <SeaznQrImage testId="md-code-qr-image" sensitive qr={shown.qr} alt={t(dict, "matchDay.code.alt")} maxSize={PHONE_HANDOVER_QR_MAX_PX} />
          </div>
        )}
        <CodeList dict={dict} locale={locale} today={today} courts={courts} codes={codes} busy={busy} onShow={(c) => void show(c)} onWithdraw={(id) => void withdraw(id)} />
      </div>
    </Modal>
  );
}

function ScopePicker(props: {
  dict: Dict;
  kind: ScopeKind;
  onKind: (k: ScopeKind) => void;
  venues: { id: string; name: string }[];
  venueId: string | null;
  onVenue: (id: string) => void;
  courts: readonly MatchDayCourt[];
  courtIds: ReadonlySet<string>;
  onCourt: (id: string) => void;
}) {
  const { dict, kind } = props;
  const kinds: ScopeKind[] = ["competition", "venue", "courts"];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium text-slate-800">{t(dict, "matchDay.code.scope.label")}</legend>
      {kinds.map((k) => (
        <label key={k} className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name="md-code-scope" data-testid={`md-code-scope-${k}`} checked={kind === k} onChange={() => props.onKind(k)} />
          <span>{t(dict, `matchDay.code.scope.${k}`)}</span>
        </label>
      ))}
      {kind === "venue" && (
        <select
          data-testid="md-code-venue"
          aria-label={t(dict, "matchDay.code.scope.venue")}
          className="input min-h-11"
          value={props.venueId ?? ""}
          onChange={(e) => props.onVenue(e.target.value)}
        >
          {props.venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      {kind === "courts" && (
        <div role="group" aria-label={t(dict, "matchDay.code.scope.courts")} className="grid gap-1 pl-6">
          {props.courts.map((c) => (
            <label key={c.court_id} className="flex min-h-11 items-center gap-2 text-sm [overflow-wrap:anywhere]">
              <input type="checkbox" data-testid="md-code-court" checked={props.courtIds.has(c.court_id)} onChange={() => props.onCourt(c.court_id)} />
              <span>{c.court_name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function CodeList(props: {
  dict: Dict;
  locale: Locale;
  today: string;
  courts: readonly MatchDayCourt[];
  codes: MatchDayCode[] | null;
  busy: Busy;
  onShow: (c: MatchDayCode) => void;
  onWithdraw: (id: string) => void;
}) {
  const { dict, locale, today, codes, busy } = props;
  const when = (c: MatchDayCode) =>
    c.day === today
      ? t(dict, "matchDay.code.today")
      : t(dict, "matchDay.code.opens", { date: fmtPublicDate(locale, "UTC", `${c.day}T12:00:00Z`, { weekday: "short", day: "numeric", month: "short" }) });
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold text-slate-900">{t(dict, "matchDay.code.list")}</h3>
      {codes === null && <p className="text-sm text-slate-600">{t(dict, "matchDay.code.loading")}</p>}
      {codes !== null && codes.length === 0 && <p className="text-sm text-slate-600">{t(dict, "matchDay.code.none")}</p>}
      {codes !== null && codes.length > 0 && (
        <ul className="grid gap-2">
          {codes.map((c) => (
            <li key={c.id} data-testid="md-code-row" className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {scopeWords(dict, c.scope, props.courts)} · {when(c)}
                {c.can_approve && ` · ${t(dict, "matchDay.code.approves")}`}
              </span>
              <button type="button" className="btn btn-ghost min-h-11" onClick={() => props.onShow(c)}>
                {t(dict, "matchDay.code.show")}
              </button>
              <button
                type="button"
                data-testid="md-code-withdraw"
                disabled={busy !== null}
                className="btn btn-ghost min-h-11"
                onClick={() => props.onWithdraw(c.id)}
              >
                {busy?.kind === "withdrawing" && busy.id === c.id ? t(dict, "matchDay.code.withdrawing") : t(dict, "matchDay.code.withdraw")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
