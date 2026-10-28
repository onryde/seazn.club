import type { Metadata } from "next";

export const metadata: Metadata = { title: "Changelog & versioning" };

// One entry per meaningful API change — newest first. Keep entries additive
// and dated; this page IS the versioning promise (v3/08 §3).
const ENTRIES: { date: string; title: string; lines: string[] }[] = [
  {
    date: "2026-10-28",
    title: "Breaking: a short-set tie-break ends at 5–4 (Fast4 and short-sets)",
    lines: [
      "A tennis set may carry its own tie-break margin, set.tiebreakWinBy (optional). Absent, a set tie-break plays to tiebreak.winBy as before; the match tie-break always does.",
      "A Fast4 division created from this release on, and the new short-sets format (tie-break at 4-all), play ITF Appendix VI's short-set tie-break: first to 5 with a deciding point at 4–4. A tennis.point at 4–4 ends the set; a summary of 4–3 with tb 5–4 is accepted; a tb block of 6–4 or 6–5 is refused 422 INVALID_EVENT.",
      "Any tie-break played to a margin of one (set.tiebreakWinBy 1 or tiebreak.winBy 1) refuses a tb block or match tie-break summary past its target (8–7 to seven) with INVALID_EVENT, on POST /fixtures/{id}/events and events/import alike.",
      "Fast4 divisions created before this release keep a two-point margin: the release's migration writes set.tiebreakWinBy 2 into them. Summaries recorded before the change still replay as recorded. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a tennis set score no set can reach is refused",
    lines: [
      "POST /fixtures/{id}/events refuses a tennis.set_summary in plain games whose score no set can reach under its tie-break (8–6 or 9–7 with the tie-break at 6-all, 5–3 in a Fast4 set) with 422 SET_SCORE_UNREACHABLE, and nothing is written.",
      "POST /divisions/{id}/events/import rejects such a stream the same way: error.code import.fold_rejected, error.engineCode SET_SCORE_UNREACHABLE, nothing written for its fixture.",
      "A summary whose score before its last game was already a finished set (7–0, 8–0, 9–3, in any set including an advantage set) was refused INVALID_EVENT and is now refused SET_SCORE_UNREACHABLE.",
      "Send the score that was played; a set that went to the tie-break is 7–6 (or 4–3 in Fast4) with its tb points. Summaries recorded before the change still replay as recorded.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a match-ending sanction must be followed by its ending",
    lines: [
      "After a badminton disqualification (black card) or a tennis default, POST /fixtures/{id}/events refuses every event but core.forfeit and core.abandon with 422 ENDING_SANCTION_PENDING, and nothing is written.",
      "POST /divisions/{id}/events/import rejects such a stream the same way: error.code import.fold_rejected, error.engineCode ENDING_SANCTION_PENDING, nothing written for its fixture.",
      "Send the ending, core.forfeit with by the sanctioned entrant and reason \"disqualified\", or void the sanction. Ledgers recorded before the change still replay as recorded. Every other sanction level and sport is unchanged.",
      "A device link or an official scorer may now send that ending itself (201, was 403), but only as the event right after the sanction, against the same side; after a volleyball expulsion or disqualification the same holds for core.forfeit with reason \"retired\". Every other forfeit from a scorer is still 403 FORBIDDEN.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: the standings export refuses a table with no results",
    lines: [
      "GET /divisions/{id}/exports/standings with no stored table now answers 404 STANDINGS_NOT_AVAILABLE (\"no standings yet\"), not 404 NOT_FOUND.",
      "A division whose stored tables are all empty, or have no counted result yet, now gets the same 404 instead of a document with no rows or with the seed order printed as ranks. If a later stage's table is empty, the export prints the newest stage table that has results.",
      "Chess and other half-point tables now print Pts as the public table does (\"1½\", not the stored 3); in XLSX that cell is text. Whole-point sports keep a numeric Pts cell.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: an imported hockey goal must record its type",
    lines: [
      "POST /divisions/{id}/events/import now rejects a stream whose hockey.goal has no payload.kind, as POST /fixtures/{id}/events does since 2026-10-27.",
      "The call still returns 200. That stream's result is rejected with error.code import.fold_rejected and error.engineCode GOAL_KIND_REQUIRED, and nothing is written for its fixture. Other streams in the call are judged on their own.",
      "Send kind: \"fg\" if the type is unknown. Ice hockey and every other sport are unchanged.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-27",
    title: "Breaking: a hockey goal must record its type",
    lines: [
      "POST /fixtures/{id}/events with type hockey.goal now requires payload.kind: fg (field goal), pc (penalty corner), stroke (penalty stroke) or og (own goal, credited to the other side).",
      "An untyped hockey goal is refused with 422 GOAL_KIND_REQUIRED (\"a goal in this sport must record its type\") and nothing is written. Send kind: \"fg\" if the type is unknown — what an untyped goal always counted as.",
      "Untyped goals already recorded still replay as field goals and can still be voided. Ice hockey and every other sport are unchanged.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-07-11",
    title: "Scoped keys, pins and rate-limit headers",
    lines: [
      "Key scopes are now read / score / manage (existing write keys migrated to manage — nothing breaks).",
      "New optional competition pin on keys: a pinned key 403s outside its competition.",
      "Every response carries X-RateLimit-Limit / -Remaining / -Reset; the per-key budget is 60 rpm (300 rpm on Pro).",
      "Published spec now documents x-required-scope per operation; session-only endpoints left the public spec.",
    ],
  },
  {
    date: "2026-07-10",
    title: "Registration v2 references",
    lines: [
      "Public self-withdraw by reference number: POST /public/registrations/by-ref/{ref}/withdraw.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        Changelog &amp; versioning
      </h1>
      <div className="mt-4 rounded-2xl bg-purple-50/60 p-5 text-sm leading-relaxed text-slate-700">
        <p className="font-semibold text-slate-900">The promise</p>
        <p className="mt-1">
          Additive changes (new endpoints, new optional fields) land in place and
          are announced here. Breaking changes are rare. Each one is listed here
          with its date, what changed and what to send instead.
        </p>
      </div>

      <ol className="mt-10 space-y-8 border-l-2 border-purple-100 pl-6">
        {ENTRIES.map((e) => (
          <li key={e.date + e.title} className="relative">
            <span
              aria-hidden
              className="absolute -left-[31px] top-1.5 h-2.5 w-2.5 rounded-full bg-purple-400 ring-4 ring-white"
            />
            <p className="font-mono text-xs uppercase tracking-wider text-slate-400">
              {e.date}
            </p>
            <h2 className="mt-1 font-semibold text-slate-900">{e.title}</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
              {e.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
