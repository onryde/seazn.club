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
import type { Venue as FullVenue, Court as FullCourt } from "@/components/v2/venues-panel";

/** P9: the board side needs court IDENTITY and display only — never the
 *  calendar. `hours`/`exceptions` are the Directory calendar editor's
 *  business (and P10's lattice input); shipping them to every board render
 *  put the five-division RSC payload 33KB over its budget
 *  (board-v3.spec.ts:287). Narrowing the TYPE rather than blanking the arrays
 *  keeps this honest: a future consumer cannot read a calendar that the board
 *  prop does not carry. `FullCourt` remains assignable to `Court` here, so the
 *  Directory can pass its richer rows unchanged. */
export type Court = Omit<FullCourt, "hours" | "exceptions">;
export type Venue = Omit<FullVenue, "courts"> & { courts: Court[] };
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

/** Every court across every venue, INCLUDING archived venues and archived
 *  courts — the rows `resolveCourtNames` needs (review finding #6, P9). Never
 *  used for the selectable option list: `courtGroups` stays archived-filtered
 *  for that. Server order is preserved but not load-bearing here — the rows
 *  feed `buildCourtDirectory`, which sorts (name, venue_name, id) itself. */
function allCourtRows(
  venues: readonly Venue[],
): { id: string; name: string; venue_name: string; tags: readonly string[] }[] {
  return venues.flatMap((venue) =>
    venue.courts.map((c) => ({ id: c.id, name: c.name, venue_name: venue.name, tags: c.tags })),
  );
}

/**
 * id -> display name for EVERY court across `venues`, including archived
 * venues and archived courts, venue-qualified ("Name (Venue)") wherever the
 * bare name collides with another court's — active or archived alike.
 * REUSES `buildCourtDirectory` (schedule-ai.ts's AI-pack rule, lifted to the
 * client-safe `@/lib/court-directory` in P9 pass 4d) rather than a second
 * "is this name ambiguous" implementation.
 *
 * Archived rows are deliberately INCLUDED (review finding #6, P9): a fixture
 * placed before its court — or its whole venue — was archived still needs
 * that court's name to render, which is why the schedule page fetches
 * `listVenues(auth, { includeArchived: true })` in the first place; dropping
 * archived rows here (the old bug) defeated that fetch and left the board
 * rendering a bare uuid. An archived court sharing a bare name with another
 * court (active or archived, same or different venue) counts toward
 * ambiguity exactly like an active one, so two different courts are never
 * shown identical text. This is a NAME-resolution widening ONLY — the
 * selectable option list (`courtGroups`, above) stays archived-filtered; an
 * archived court must still never be offered as a new choice.
 *
 * The board's own `courtNamesById` (schedule-board.tsx), stages-panel.tsx's
 * fixture editor/badges, and this component's own selected-order strip
 * (review finding #13) all build their id->name map through this one
 * function — see P9 pass 4d.
 */
export function resolveCourtNames(venues: readonly Venue[]): Record<string, string> {
  const directory = buildCourtDirectory(allCourtRows(venues));
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
  // Venue-qualified, same as the board's columns and the AI pack (review
  // finding #13) — two courts named "Court 1" in different venues are legal
  // (the unique index is per-venue) and must not render as indistinguishable
  // text in the flat, unheaded selected-order strip below. Also covers an
  // archived selected court (finding #6): it still resolves to a real name
  // here instead of falling through to unknownCourtLabel.
  const nameById = resolveCourtNames(venues);
  // The strip renders the venue on its OWN line rather than inside the label,
  // so the qualification survives a narrow viewport. At 320px a single
  // truncating "Court 1 (Riverside Centre)" clips to "Court 1 (Riversid…" —
  // and two venues whose names share a prefix ("Riverside Centre" / "Riverside
  // Hall") then clip to IDENTICAL text, which defeats the whole point of
  // qualifying at exactly the width the project mandates. Verified by
  // screenshot, not assumed: the flat label really does clip there.
  //
  // `buildCourtDirectory` already decides WHETHER a name is ambiguous, so this
  // does not re-derive that rule — a court whose bare name is unique keeps a
  // single line and no venue.
  const rowsById = new Map(allCourtRows(venues).map((r) => [r.id, r] as const));
  const venueLineFor = (id: string): string | null => {
    const row = rowsById.get(id);
    const label = nameById[id];
    if (row === undefined || label === undefined || label === row.name) return null;
    // Review wave 3: read the venue off the ROW rather than recovering it by
    // slicing the label. The qualified form is usually `${name} (${venue})`,
    // but `buildCourtDirectory` appends a ` #<id8>` tie-breaker for the
    // residual case it exists to disambiguate (an archived and an active court
    // sharing BOTH a venue and a name) — and against that the old parse
    // produced `(Riverside Hall) #a1b2c3d4`, parentheses and all.
    return row.venue_name;
  };
  const atCap = maxSelected !== undefined && value.length >= maxSelected;

  // Review wave 2: the empty state is only correct when there is ALSO nothing
  // selected. `courtGroups` drops archived venues and courts, so a division
  // that already had courts configured, whose venue was later archived, hit
  // this early return and showed the organiser a Directory pointer and nothing
  // else — while `config.courts` still held those ids and the solver still
  // scheduled on them. Unremovable, and invisible. With a selection present we
  // fall through to the normal render: the strip still resolves names (that
  // map is archived-INCLUSIVE by design, finding #6) so the organiser can see
  // and remove them, and the option list below is simply empty.
  if (groups.length === 0 && value.length === 0) {
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
            const name = nameById[id] ?? unknownCourtLabel;
            const venueLine = venueLineFor(id);
            const courtLine = venueLine === null ? name : (rowsById.get(id)?.name ?? name);
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-md border border-purple-100 bg-purple-50/50 px-2 py-1.5 text-sm"
              >
                <span aria-hidden className="w-4 shrink-0 text-center text-xs text-purple-400">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 text-slate-700">
                  <span className="block truncate">{courtLine}</span>
                  {venueLine !== null && (
                    <span className="block truncate text-xs text-slate-500">{venueLine}</span>
                  )}
                </span>
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
