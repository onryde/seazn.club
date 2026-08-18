"use client";

// Court multi-picker (P9 scope item 5) — replaces the free-text court list in
// schedule setup (settings-panel.tsx, division-builder.tsx) with a multi-select
// of the org's REAL courts (`courts.id`, since P9 pass 1's CourtId cutover —
// `ScheduleConfig.courts` is `z.array(CourtId)`, schemas.ts). Grouped by
// venue, archived courts hidden, selection ORDER preserved and shown —
// `config.courts`' array position IS the wire index the solver reads, so it
// is never sorted by id.
//
// Copy-free, like DateTimeField/TagChipInput: every string is a prop,
// resolved by the caller's own useMsg(). Two callers (settings-panel.tsx,
// division-builder.tsx) need IDENTICAL selection/reorder/archived-filter
// behaviour, so it lives here once — same reasoning tag-chip-input.tsx's
// header gives for TagChipInput living once instead of twice.
//
// `Venue`/`Court` types imported TYPE-ONLY from venues-panel.tsx (P8) rather
// than redeclared: same wire shape (`listVenues`, server/usecases/venues.ts),
// reusing the existing repo primitive. The archived-filter helpers there
// (`filterVenuesByArchived`/`filterCourtsByArchived`) are deliberately NOT
// imported as values, though — that would statically pull venues-panel.tsx's
// whole module graph (1000+ lines, ConfirmProvider, TagChipInput, ...) into
// the schedule board and division-wizard bundles, which never otherwise load
// it. The filter itself is three lines; reimplemented inline below instead.
import Link from "next/link";
import type { Venue, Court } from "@/components/v2/venues-panel";
import { buildCourtDirectory } from "@/lib/court-directory";

/** Non-archived venues, each holding only its non-archived courts; a venue
 *  left with zero courts after that is dropped so no empty group heading
 *  renders. Server order (`sort, name, id` — venues.ts `listVenues`) is
 *  trusted and never re-sorted here — sorting by id is the defect this
 *  session's brief calls out as already having appeared five times. */
export function courtGroups(venues: readonly Venue[]): { venue: Venue; courts: Court[] }[] {
  return venues
    .filter((v) => v.archived_at === null)
    .map((venue) => ({ venue, courts: venue.courts.filter((c) => c.archived_at === null) }))
    .filter((group) => group.courts.length > 0);
}

/** Every selectable (non-archived) court across every non-archived venue, in
 *  the same server order `courtGroups` renders — the pool a "pick the next
 *  unselected court" caller (the capacity card's add_court suggestion) draws
 *  from. */
export function flattenCourts(venues: readonly Venue[]): Court[] {
  return courtGroups(venues).flatMap((g) => g.courts);
}

/**
 * id -> display name for every (non-archived) court across `venues`,
 * venue-qualified ("Name (Venue)") wherever the bare name collides across
 * venues — REUSES `buildCourtDirectory` (schedule-ai.ts's AI-pack rule,
 * lifted to the client-safe `@/lib/court-directory` in P9 pass 4d) rather
 * than a second "is this name ambiguous" implementation. Archived courts are
 * excluded (via `courtGroups`) so an archived court's freed name never forces
 * an unnecessary venue suffix onto its active namesake.
 *
 * The board's own `courtNamesById` (schedule-board.tsx) and stages-panel.tsx's
 * fixture editor/badges both build their id->name map through this one
 * function — see P9 pass 4d.
 */
export function resolveCourtNames(venues: readonly Venue[]): Record<string, string> {
  const rows = courtGroups(venues).flatMap(({ venue, courts }) =>
    courts.map((c) => ({ id: c.id, name: c.name, venue_name: venue.name, tags: c.tags })),
  );
  const directory = buildCourtDirectory(rows);
  const map: Record<string, string> = {};
  for (const [id, info] of directory) map[id] = info.label;
  return map;
}

/** Toggle one court id in/out of the ordered selection. Checking APPENDS —
 *  the organiser's pick order becomes the array order; unchecking removes it
 *  and closes the gap, never leaving a hole. A `max` cap (the Pro
 *  multi-venue gate, division-builder.tsx) makes a check past the cap a
 *  no-op — the caller renders WHY separately (UpgradeGate); this just
 *  refuses the write. */
export function toggleCourtSelection(
  selected: readonly string[],
  courtId: string,
  max?: number,
): string[] {
  if (selected.includes(courtId)) return selected.filter((id) => id !== courtId);
  if (max !== undefined && selected.length >= max) return [...selected];
  return [...selected, courtId];
}

/** Swap the entry at `index` with its neighbour in `direction`. A no-op past
 *  either end, so callers can wire it straight to an unconditionally-mounted
 *  button and disable it using the SAME bounds check. */
export function reorderSelection(
  selected: readonly string[],
  index: number,
  direction: -1 | 1,
): string[] {
  const target = index + direction;
  if (index < 0 || index >= selected.length || target < 0 || target >= selected.length) {
    return [...selected];
  }
  const next = [...selected];
  const a = next[index]!;
  const b = next[target]!;
  next[index] = b;
  next[target] = a;
  return next;
}

export interface CourtMultiPickerProps {
  /** Org venues with nested courts (`listVenues` shape, venues.ts) — fetched
   *  server-side by the page and threaded down, the same pattern
   *  `VenuesPanel`'s own `venues` prop already uses. Archived venues/courts
   *  are filtered HERE regardless of what the caller passed (defence in
   *  depth — see `courtGroups`), so a caller that fetched with
   *  `includeArchived` by mistake still cannot leak an archived court into
   *  the option list. */
  venues: readonly Venue[];
  /** `config.courts` — real `courts.id` uuids, in solver-wire order. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** The Pro multi-venue gate (division-builder.tsx only): checking a court
   *  past this count is refused. `undefined` = unlimited (still capped at 50
   *  by the caller's own save path, unchanged from the free-text era). */
  maxSelected?: number;
  label: string;
  description?: string;
  /** Shown INSTEAD of the picker when the org has no (unarchived) courts at
   *  all — never an empty box (design requirement). */
  emptyTitle: string;
  emptyBody: string;
  directoryLinkLabel: string;
  /** Already resolved with the count interpolated (`msg("courtPicker.selected",
   *  { n: value.length })`) — copy-free component, see file header. */
  selectedLabel: string;
  noneSelectedLabel: string;
  /** A `value` entry with no matching court (deleted since, or a legacy
   *  free-text label from before this picker existed) still renders as SOME
   *  row in the order strip rather than silently vanishing or crashing. */
  unknownCourtLabel: string;
  moveUpLabel: string;
  moveDownLabel: string;
  /** Position-parameterised (1-based), matching `boardset.removeVenue`'s
   *  existing `{ n }` shape — the free-text list's own remove button used
   *  the identical convention. */
  removeLabelFor: (position: number) => string;
}

export function CourtMultiPicker({
  venues,
  value,
  onChange,
  disabled = false,
  maxSelected,
  label,
  description,
  emptyTitle,
  emptyBody,
  directoryLinkLabel,
  selectedLabel,
  noneSelectedLabel,
  unknownCourtLabel,
  moveUpLabel,
  moveDownLabel,
  removeLabelFor,
}: CourtMultiPickerProps) {
  const groups = courtGroups(venues);
  const byId = new Map(flattenCourts(venues).map((c) => [c.id, c] as const));
  const atCap = maxSelected !== undefined && value.length >= maxSelected;

  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm">
        <p className="font-medium text-slate-700">{emptyTitle}</p>
        <p className="mt-1 text-slate-500">{emptyBody}</p>
        <Link
          href="/directory?tab=venues"
          prefetch={false}
          className="mt-2 inline-block font-medium text-purple-600 hover:underline"
        >
          {directoryLinkLabel} →
        </Link>
      </div>
    );
  }

  return (
    <div>
      <span className="label">{label}</span>
      {description && <p className="mb-2 text-xs text-slate-400">{description}</p>}

      {/* Selection order — the array position the solver reads. A numbered
          list (not just checkbox state) because ORDER is the information
          here; reorder is up/down buttons, not drag — the same choice P8's
          own court editor made (venues-panel.tsx's CourtRow) for the same
          reason: it has to work with a thumb at 320px, not just a mouse. */}
      <p className="text-xs font-medium text-slate-600">{selectedLabel}</p>
      {value.length === 0 ? (
        <p className="mb-2 text-xs text-slate-400">{noneSelectedLabel}</p>
      ) : (
        <ol className="mb-2 list-none space-y-1.5">
          {value.map((id, i) => {
            const court = byId.get(id);
            const name = court?.name ?? unknownCourtLabel;
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-md border border-purple-100 bg-purple-50/50 px-2 py-1.5 text-sm"
              >
                <span aria-hidden className="w-4 shrink-0 text-center text-xs text-purple-400">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-700">{name}</span>
                {!disabled && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => onChange(reorderSelection(value, i, -1))}
                      aria-label={moveUpLabel}
                      className="btn btn-ghost px-1.5 py-1 text-xs disabled:opacity-30"
                    >
                      {"↑"}
                    </button>
                    <button
                      type="button"
                      disabled={i === value.length - 1}
                      onClick={() => onChange(reorderSelection(value, i, 1))}
                      aria-label={moveDownLabel}
                      className="btn btn-ghost px-1.5 py-1 text-xs disabled:opacity-30"
                    >
                      {"↓"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange(value.filter((v) => v !== id))}
                      aria-label={removeLabelFor(i + 1)}
                      className="rounded-md px-2 py-1 text-sm text-red-500 hover:bg-red-50"
                    >
                      {"✕"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/* Available courts, grouped by venue — a per-row list at every width
          (no grid): the same mobile-first call P8's calendar editor made. */}
      <div className="space-y-3">
        {groups.map(({ venue, courts }) => (
          <div key={venue.id}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{venue.name}</p>
            <ul className="mt-1 space-y-1">
              {courts.map((court) => {
                const checked = value.includes(court.id);
                const rowDisabled = disabled || (!checked && atCap);
                return (
                  <li key={court.id}>
                    <label
                      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${
                        checked ? "border-purple-300 bg-purple-50/40" : "border-slate-200 bg-white"
                      } ${rowDisabled ? "opacity-50" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={rowDisabled}
                        onChange={() => onChange(toggleCourtSelection(value, court.id, maxSelected))}
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate text-slate-700">{court.name}</span>
                      {court.tags.length > 0 && (
                        <span className="flex shrink-0 flex-wrap justify-end gap-1">
                          {court.tags.map((tag) => (
                            <span key={tag} className="chip lowercase">
                              {tag}
                            </span>
                          ))}
                        </span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
