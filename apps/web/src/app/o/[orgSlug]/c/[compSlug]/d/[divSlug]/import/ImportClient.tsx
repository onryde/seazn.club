"use client";

// P11 (D6) — the division import page's client island (design doc §7). One
// screen: a .json file picker and a paste textarea feed the SAME state
// value, so what is about to be sent is always visible before Import is
// pressed. `JSON.parse` runs locally before the request — a malformed file
// is a local error naming the position, never a round trip. The response
// renders verbatim as a report table (fixture linked, status, events
// appended, outcome, error) plus a totals row; the textarea keeps its
// contents after submit, since re-running is the only way to see the
// report again (there is no separate report store — spec §4).
import { useState, type ChangeEvent } from "react";
import Link from "@/components/ui/console-link";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { routes } from "@/lib/routes";
import type { MessageKey } from "@/lib/messages";

type StreamStatus = "imported" | "skipped_duplicate" | "rejected";

interface ImportResultRow {
  fixture: string;
  status: StreamStatus;
  eventsAppended: number;
  outcome?: unknown;
  error?: {
    code: string;
    eventIndex?: number;
    engineCode?: string;
    feature?: string;
    matches?: number;
    [k: string]: unknown;
  };
}

interface ImportReport {
  importId: string;
  totals: { imported: number; skipped: number; rejected: number };
  results: ImportResultRow[];
}

const STATUS_KEY: Record<StreamStatus, MessageKey> = {
  imported: "eventImport.status.imported",
  skipped_duplicate: "eventImport.status.skipped_duplicate",
  rejected: "eventImport.status.rejected",
};

// Colour REINFORCES the status; it never carries the meaning alone (design
// doc §7) — the chip's TEXT always states imported/skipped/rejected too.
const STATUS_CLASS: Record<StreamStatus, string> = {
  imported: "bg-emerald-50 text-emerald-700",
  skipped_duplicate: "bg-slate-100 text-slate-600",
  rejected: "bg-red-50 text-red-700",
};

const CAP_KEY: Record<string, MessageKey> = {
  streams: "eventImport.cap.streams",
  eventsPerFixture: "eventImport.cap.eventsPerFixture",
  eventsPerCall: "eventImport.cap.eventsPerCall",
};

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

const OUTCOME_KEY: Record<string, MessageKey> = {
  win: "eventImport.outcome.win",
  draw: "eventImport.outcome.draw",
  tie: "eventImport.outcome.tie",
  no_result: "eventImport.outcome.no_result",
  award: "eventImport.outcome.award",
};

/**
 * `row.outcome` is the engine's MatchOutcome verbatim (packages/engine
 * core/types.ts — win/draw/tie/no_result/award). `winner`/`loser` inside it
 * are entrant ids this response cannot resolve to names (found by
 * screenshotting the live page: the cell was printing the raw payload, bare
 * UUIDs included) — an operator can't read that, and the row's own fixture
 * link is where a human goes for who won. So only `kind` renders, through
 * ONE localized label per kind; an unrecognised kind (a future engine
 * addition this page hasn't learned yet) falls back to the bare kind
 * string, never the raw payload.
 *
 * Final review (minor): the fallback used to be a bare `String(outcome)`,
 * which for the one case it exists to handle — an outcome that is an object
 * WITHOUT a `kind` — renders the literal text `[object Object]`, i.e. the
 * raw payload leaking in the ugliest available form, which is exactly what
 * the paragraph above promises never happens. Only a `kind` (or a bare
 * string outcome) is renderable; anything else renders as an empty cell,
 * which says nothing rather than saying nonsense. Unreachable today — every
 * MatchOutcome the engine produces carries a `kind`.
 */
function describeOutcome(msg: Msg, outcome: unknown): string {
  const kind =
    outcome && typeof outcome === "object" && "kind" in outcome
      ? String((outcome as { kind: unknown }).kind)
      : typeof outcome === "string"
        ? outcome
        : "";
  const key = OUTCOME_KEY[kind];
  return key ? msg(key) : kind;
}

/**
 * Every rejection code the design doc (§4) says this page must render,
 * mapped through ONE function so a per-row error cell (a stream the call
 * completed but refused) and the call-level banner (a rejection that means
 * NO per-stream result exists at all — 402/409/413) read identically. An
 * unlisted code — a future one this page hasn't learned yet, or a bare
 * transport failure — falls back to `.generic`, which names the raw code
 * rather than staying silent about it.
 *
 * The server stays English and returns these as CODES (+ a few named
 * fields); every sentence returned here is fully localized — including
 * `capLabel`/`eventRef`, themselves resolved through `msg` first, so no
 * English fragment leaks into a translated sentence.
 */
function describeError(msg: Msg, code: string, extra: Record<string, unknown>): string {
  switch (code) {
    case "import.fixture_started":
      return msg("eventImport.error.fixture_started");
    case "import.fixture_unknown":
      return msg("eventImport.error.fixture_unknown", { matches: Number(extra.matches ?? 0) });
    case "import.fold_rejected": {
      const eventIndex = extra.eventIndex;
      const eventRef =
        typeof eventIndex === "number"
          ? msg("eventImport.eventRef.withIndex", { eventIndex })
          : msg("eventImport.eventRef.unknown");
      return msg("eventImport.error.fold_rejected", { eventRef, engineCode: String(extra.engineCode ?? "") });
    }
    case "import.not_decided":
      return msg("eventImport.error.not_decided");
    case "import.entitlement":
      return msg("eventImport.error.entitlement", { feature: String(extra.feature ?? "") });
    case "import.slots_unfilled":
      return msg("eventImport.error.slots_unfilled");
    case "import.too_large": {
      const cap = String(extra.cap ?? "");
      const capKey = CAP_KEY[cap];
      const capLabel = capKey ? msg(capKey) : cap;
      return msg("eventImport.error.too_large", {
        capLabel,
        actual: Number(extra.actual ?? 0),
        limit: Number(extra.limit ?? 0),
      });
    }
    case "import.concurrent":
      return msg("eventImport.error.concurrent");
    case "import.division_not_started":
      return msg("eventImport.error.division_not_started", { divisionStatus: String(extra.divisionStatus ?? "") });
    // The catch-all row (final review I-4): a stream that failed for a reason
    // the importer did not anticipate. It carries no named fields — by
    // definition nobody knew what to put in them — so the sentence's job is to
    // say what IS known: this fixture wrote nothing, its siblings are fine.
    case "import.stream_failed":
      return msg("eventImport.error.stream_failed");
    // Call-level 402. Two distinct refusals arrive under this one transport
    // code (http.ts:79/221): the over-quota competition FREEZE that the batch
    // importer now enforces alongside live scoring — which is not about a
    // missing feature at all, and whose fix is archiving a competition rather
    // than upgrading — and every other plan gate, which is. Falling through to
    // `.generic` printed the bare "Import failed (PAYMENT_REQUIRED)." for both.
    case "PAYMENT_REQUIRED": {
      const feature = String(extra.feature ?? extra.feature_key ?? "");
      return feature === "competitions.max_active"
        ? msg("eventImport.error.competition_frozen")
        : msg("eventImport.error.entitlement", { feature });
    }
    default:
      return msg("eventImport.error.generic", { code });
  }
}

interface ImportClientProps {
  divisionId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  /** Fixture id -> per-division display ordinal, resolved server-side
   *  (page.tsx) — `routes.fixture` addresses a fixture by that ordinal, not
   *  by id, so a reference this page cannot resolve here (an unimported
   *  ext_key, or any id outside this division) renders as plain text rather
   *  than a link into nothing. */
  fixtureNoById: Record<string, number>;
}

export function ImportClient({ divisionId, orgSlug, compSlug, divSlug, fixtureNoById }: ImportClientProps) {
  const msg = useMsg();
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so re-selecting the SAME filename later still fires onChange.
    e.target.value = "";
    if (!file) return;
    const contents = await file.text();
    setText(contents);
  }

  async function handleSubmit() {
    setParseError(null);
    setCallError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setParseError(msg("eventImport.parseError", { message: err instanceof Error ? err.message : String(err) }));
      return;
    }
    setBusy(true);
    try {
      const data = await apiV1<ImportReport>(`/api/v1/divisions/${divisionId}/events/import`, {
        method: "POST",
        json: parsed,
      });
      setReport(data);
    } catch (err) {
      if (err instanceof ApiV1Error) {
        setCallError(describeError(msg, err.code, err.extra));
      } else {
        setCallError(msg("eventImport.error.generic", { code: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">{msg("eventImport.title")}</h1>
        <p className="mt-1 text-sm text-slate-500">{msg("eventImport.subtitle")}</p>
      </div>

      <section className="card space-y-3 p-4">
        <label className="block text-sm font-medium text-slate-700" htmlFor="event-import-file">
          {msg("eventImport.field.file")}
        </label>
        <input
          id="event-import-file"
          type="file"
          accept=".json,application/json"
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
          disabled={busy}
          onChange={handleFile}
        />

        <label className="block text-sm font-medium text-slate-700" htmlFor="event-import-paste">
          {msg("eventImport.field.paste")}
        </label>
        <textarea
          id="event-import-paste"
          className="input h-64 w-full font-mono text-xs"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />

        {parseError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
            {parseError}
          </p>
        )}
        {callError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
            {callError}
          </p>
        )}

        <button type="button" className="btn btn-primary" disabled={busy} onClick={handleSubmit}>
          {busy ? msg("eventImport.submitting") : msg("eventImport.submit")}
        </button>
      </section>

      {!report && (
        <p className="text-sm text-slate-500">{msg("eventImport.empty")}</p>
      )}

      {report && (
        <section className="card space-y-3 p-4">
          <p className="text-sm font-medium text-slate-700">
            {msg("eventImport.totals.summary", {
              imported: report.totals.imported,
              skipped: report.totals.skipped,
              rejected: report.totals.rejected,
            })}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1 pr-3">{msg("eventImport.table.fixture")}</th>
                  <th className="py-1 pr-3">{msg("eventImport.table.status")}</th>
                  <th className="py-1 pr-3">{msg("eventImport.table.eventsAppended")}</th>
                  <th className="py-1 pr-3">{msg("eventImport.table.outcome")}</th>
                  <th className="py-1 pr-3">{msg("eventImport.table.error")}</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((row, i) => {
                  const no = fixtureNoById[row.fixture];
                  return (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {no !== undefined ? (
                          <Link className="underline" href={routes.fixture(orgSlug, compSlug, divSlug, no)}>
                            {msg("eventImport.table.fixtureLabel", { no })}
                          </Link>
                        ) : (
                          row.fixture
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[row.status]}`}>
                          {msg(STATUS_KEY[row.status])}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3">{row.eventsAppended}</td>
                      <td className="py-1.5 pr-3">{row.outcome ? describeOutcome(msg, row.outcome) : "—"}</td>
                      <td className="py-1.5 pr-3">{row.error ? describeError(msg, row.error.code, row.error) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
