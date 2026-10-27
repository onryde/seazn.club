import type { Metadata } from "next";

export const metadata: Metadata = { title: "Changelog & versioning" };

// One entry per meaningful API change — newest first. Keep entries additive
// and dated; this page IS the versioning promise (v3/08 §3).
const ENTRIES: { date: string; title: string; lines: string[] }[] = [
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
          are announced here. Breaking changes never land in place — they get a
          new version path (<code className="font-mono text-xs">/api/v2</code>)
          and the old one keeps working through a sunset window announced months
          ahead, with <code className="font-mono text-xs">Sunset</code> headers on
          deprecated routes.
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
