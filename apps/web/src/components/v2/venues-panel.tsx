"use client";

// Venues & courts (P8/D5a) — Directory tab, mirroring persons-panel.tsx's
// shape: "use client", CRUD via apiV1, inline useState<string|null> for
// error/success (this repo has no toast component), useMsg() for copy. No
// server actions anywhere in this repo.
//
// Venue list -> courts per venue -> per-court calendar editor, per the design
// doc's UI section (A2/A4/A5 amendments,
// docs/superpowers/specs/bench-product-value/designs/2026-08-13-venues-courts-design.md).
//
// ARCHIVED COURTS (A5, gap closed): `listVenues(auth, {includeArchived:true})`
// (server/usecases/venues.ts) threads the SAME flag into both the venues AND
// the nested courts query, and directory/page.tsx's VenuesTab always fetches
// with it on — so the full court list (active + archived) is already in the
// `venues` prop. The one "Show archived" toggle below is a client-side
// filter applied at BOTH levels (`filterVenuesByArchived` /
// `filterCourtsByArchived`): off hides archived rows entirely; on shows them
// greyed with an Unarchive action, same idiom at both levels.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { TagChipInput } from "@/components/ui/tag-chip-input";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { minutesOfDay, hhmmOfMinutes } from "@/components/v2/shared/time-options";

// ---------------------------------------------------------------------------
// Types (structurally match the API's Venue/Court/CourtCalendar schemas —
// server/api-v1/schemas.ts — but declared locally rather than imported: that
// server module tree is off limits this session and this is a client
// component besides).
// ---------------------------------------------------------------------------

export interface CourtHours {
  weekday: number;
  open_min: number;
  close_min: number;
}

export interface CourtException {
  date: string;
  closed: boolean;
  open_min: number | null;
  close_min: number | null;
}

export interface Court {
  id: string;
  venue_id: string;
  name: string;
  sort: number;
  tags: string[];
  archived_at: string | null;
  created_at: string;
  hours: CourtHours[];
  exceptions: CourtException[];
}

export interface Venue {
  id: string;
  name: string;
  address: string | null;
  sort: number;
  archived_at: string | null;
  created_at: string;
  courts: Court[];
}

type Msg = ReturnType<typeof useMsg>;
type Plural = ReturnType<typeof usePlural>;
type Confirm = ReturnType<typeof useConfirm>;
type RunFn = (fn: () => Promise<unknown>, successText?: string) => void;

const WEEKDAY_KEYS = [
  "venues.weekday.sun",
  "venues.weekday.mon",
  "venues.weekday.tue",
  "venues.weekday.wed",
  "venues.weekday.thu",
  "venues.weekday.fri",
  "venues.weekday.sat",
] as const;

// ---------------------------------------------------------------------------
// Pure helpers — no React, no DOM. apps/web is vitest `environment: "node"`
// with no jsdom (see components/v2/shared/time-options.ts), so this is the
// genuinely testable surface; see __tests__/venues-panel.test.ts.
// ---------------------------------------------------------------------------

/** The "Show archived" toggle's filter, applied to top-level venues. */
export function filterVenuesByArchived(venues: readonly Venue[], showArchived: boolean): Venue[] {
  if (showArchived) return [...venues];
  return venues.filter((v) => v.archived_at === null);
}

/** The SAME "Show archived" toggle, applied one level down to a venue's
 *  nested courts (A5) — one flag, same off/on behaviour at both levels. */
export function filterCourtsByArchived(courts: readonly Court[], showArchived: boolean): Court[] {
  if (showArchived) return [...courts];
  return courts.filter((c) => c.archived_at === null);
}

/** "Copy this day to all days" — replaces the WHOLE week with seven copies of
 *  `sourceWeekday`'s ranges (closed included: a source day with zero ranges
 *  clears every day). Ranges are re-tagged to each weekday, never shared by
 *  reference, so editing one day afterwards can never mutate another's. */
export function copyHoursToAllDays(hours: readonly CourtHours[], sourceWeekday: number): CourtHours[] {
  const sourceRanges = hours
    .filter((h) => h.weekday === sourceWeekday)
    .map((h) => ({ open_min: h.open_min, close_min: h.close_min }));
  const out: CourtHours[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (const r of sourceRanges) out.push({ weekday, ...r });
  }
  return out;
}

/** Client-side immediate feedback ONLY — the server's `assertNoHoursOverlap`
 *  (server/usecases/venues.ts) stays the authority (422 COURT_HOURS_OVERLAP).
 *  Reimplemented rather than imported: that module is `import "server-only"`
 *  and would break the client bundle. Same rule: two ranges on the same
 *  weekday overlap if one starts before the other closes; equal start times
 *  count; back-to-back (one's close == the next's open) does not. */
export function hasHoursOverlap(hours: readonly CourtHours[]): boolean {
  const byWeekday = new Map<number, CourtHours[]>();
  for (const h of hours) {
    const list = byWeekday.get(h.weekday) ?? [];
    list.push(h);
    byWeekday.set(h.weekday, list);
  }
  for (const ranges of byWeekday.values()) {
    const sorted = [...ranges].sort((a, b) => a.open_min - b.open_min);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.open_min < sorted[i - 1]!.close_min) return true;
    }
  }
  return false;
}

/** Also client-side feedback only (server: `CourtHourRangeInput`'s
 *  `open_min < close_min` refine, server/usecases/venues.ts) — a lone range
 *  with open at or after close never trips `hasHoursOverlap` (nothing to
 *  overlap against on an otherwise-empty day), so it needs its own check to
 *  give feedback before the round trip instead of only after a 422. */
export function hasInvalidRange(hours: readonly CourtHours[]): boolean {
  return hours.some((h) => h.open_min >= h.close_min);
}

/** Tag suggestions "ranked by count" (design doc, "Tag suggestions"): every
 *  tag currently used by any court in the org, most-used first, alphabetical
 *  on a tie. Courts nested under an archived venue still count — their tags
 *  are real usage, and `listVenues` only ever returns active courts anyway
 *  (see the file header). */
export function rankTagsByCount(venues: readonly Venue[]): string[] {
  const counts = new Map<string, number>();
  for (const v of venues) {
    for (const c of v.courts) {
      for (const tag of c.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function friendlyError(err: unknown, msg: Msg): string {
  if (err instanceof ApiV1Error) {
    switch (err.code) {
      case "VENUE_NOT_EMPTY":
        return msg("venues.error.VENUE_NOT_EMPTY");
      case "VENUE_IN_USE":
        return msg("venues.error.VENUE_IN_USE");
      case "COURT_IN_USE":
        return msg("venues.error.COURT_IN_USE");
      case "COURT_NAME_TAKEN":
        return msg("venues.error.COURT_NAME_TAKEN");
      case "COURT_HOURS_OVERLAP":
        return msg("venues.error.COURT_HOURS_OVERLAP");
      case "COURT_EXCEPTION_DUPLICATE_DATE":
        return msg("venues.error.COURT_EXCEPTION_DUPLICATE_DATE");
      default:
        return err.message || msg("venues.error.generic");
    }
  }
  return err instanceof Error ? err.message : msg("venues.error.generic");
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function VenuesPanel({
  venues,
  orgId,
  canEdit,
}: {
  venues: Venue[];
  orgId: string;
  canEdit: boolean;
}) {
  const msg = useMsg();
  const plural = usePlural();
  const confirm = useConfirm();
  const router = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run: RunFn = (fn, successText) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    fn()
      .then(() => {
        if (successText) setNotice(successText);
        router.refresh();
      })
      .catch((err: unknown) => setError(friendlyError(err, msg)))
      .finally(() => setBusy(false));
  };

  const visibleVenues = filterVenuesByArchived(venues, showArchived);
  const tagSuggestions = rankTagsByCount(venues);

  const addVenue = (name: string, address: string) =>
    run(
      () => apiV1(`/api/v1/orgs/${orgId}/venues`, { method: "POST", json: { name, address: address || null } }),
      msg("venues.notice.venueAdded"),
    );

  return (
    <div className="space-y-4">
      {canEdit && <AddVenueForm busy={busy} onSubmit={addVenue} msg={msg} />}

      {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
          className="h-4 w-4 rounded border-purple-200 accent-purple-600"
        />
        {msg("venues.showArchived")}
      </label>

      {visibleVenues.length === 0 ? (
        <p className="card p-6 text-center text-sm text-slate-400">{msg("venues.empty")}</p>
      ) : (
        <div className="space-y-3">
          {visibleVenues.map((venue) => (
            <VenueCard
              key={venue.id}
              venue={venue}
              orgId={orgId}
              canEdit={canEdit}
              busy={busy}
              run={run}
              msg={msg}
              plural={plural}
              confirm={confirm}
              tagSuggestions={tagSuggestions}
              showArchived={showArchived}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AddVenueForm({
  busy,
  onSubmit,
  msg,
}: {
  busy: boolean;
  onSubmit: (name: string, address: string) => void;
  msg: Msg;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  return (
    <form
      className="card grid w-full grid-cols-1 gap-3 p-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit(name.trim(), address.trim());
        setName("");
        setAddress("");
      }}
    >
      <label className="block">
        <span className="label">{msg("venues.add.name")}</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={msg("venues.add.namePlaceholder")}
          className="input"
        />
      </label>
      <label className="block">
        <span className="label">{msg("venues.add.address")}</span>
        <input value={address} onChange={(e) => setAddress(e.target.value)} className="input" />
      </label>
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="btn btn-primary w-full sm:col-span-2 sm:w-auto sm:justify-self-start"
      >
        {busy ? msg("venues.add.submitting") : msg("venues.add.submit")}
      </button>
    </form>
  );
}

function VenueCard({
  venue,
  orgId,
  canEdit,
  busy,
  run,
  msg,
  plural,
  confirm,
  tagSuggestions,
  showArchived,
}: {
  venue: Venue;
  orgId: string;
  canEdit: boolean;
  busy: boolean;
  run: RunFn;
  msg: Msg;
  plural: Plural;
  confirm: Confirm;
  tagSuggestions: string[];
  showArchived: boolean;
}) {
  const [name, setName] = useState(venue.name);
  const [address, setAddress] = useState(venue.address ?? "");
  const archived = venue.archived_at !== null;
  const dirty = name.trim() !== venue.name || address.trim() !== (venue.address ?? "");
  // Same toggle as the venue level, one level down (A5) — off hides archived
  // courts entirely; moveCourt's array-position math below operates on THIS
  // (visible) list, not the raw venue.courts, so "up"/"down" always target
  // what's actually adjacent on screen rather than skipping over a hidden row.
  const visibleCourts = filterCourtsByArchived(venue.courts, showArchived);

  const saveVenue = () =>
    run(
      () =>
        apiV1(`/api/v1/orgs/${orgId}/venues/${venue.id}`, {
          method: "PATCH",
          json: { name: name.trim(), address: address.trim() || null },
        }),
      msg("venues.notice.venueUpdated"),
    );

  const archiveVenue = async () => {
    const ok = await confirm({
      title: msg("venues.venue.confirmArchive.title"),
      body: msg("venues.venue.confirmArchive.body"),
      confirmLabel: msg("venues.venue.confirmArchive.confirm"),
    });
    if (!ok) return;
    run(
      () => apiV1(`/api/v1/orgs/${orgId}/venues/${venue.id}/archive`, { method: "POST" }),
      msg("venues.notice.venueArchived"),
    );
  };

  const unarchiveVenue = () =>
    run(
      () => apiV1(`/api/v1/orgs/${orgId}/venues/${venue.id}/archive`, { method: "DELETE" }),
      msg("venues.notice.venueUnarchived"),
    );

  const deleteVenue = async () => {
    const ok = await confirm({
      title: msg("venues.venue.confirmDelete.title"),
      body: msg("venues.venue.confirmDelete.body"),
      confirmLabel: msg("venues.venue.confirmDelete.confirm"),
      tone: "danger",
    });
    if (!ok) return;
    run(() => apiV1(`/api/v1/orgs/${orgId}/venues/${venue.id}`, { method: "DELETE" }), msg("venues.notice.venueDeleted"));
  };

  const addCourt = (courtName: string) =>
    run(
      () => apiV1(`/api/v1/orgs/${orgId}/venues/${venue.id}/courts`, { method: "POST", json: { name: courtName } }),
      msg("venues.notice.courtAdded"),
    );

  const moveCourt = (courtId: string, direction: "up" | "down") => {
    const idx = visibleCourts.findIndex((c) => c.id === courtId);
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || swapWith < 0 || swapWith >= visibleCourts.length) return;
    const a = visibleCourts[idx]!;
    const b = visibleCourts[swapWith]!;
    // Target sort = the two ARRAY POSITIONS being swapped, not each other's
    // existing `sort` value: new courts default to sort 0, so two untouched
    // courts have equal sort and swapping their values would be a no-op —
    // clicking "up" and seeing nothing move. Positions are always distinct
    // and match the VISIBLE list's own display order (server: `order by
    // sort, name, id`, then the archived filter above), so this also
    // self-heals any earlier ties as it goes.
    run(async () => {
      await Promise.all([
        apiV1(`/api/v1/orgs/${orgId}/courts/${a.id}`, { method: "PATCH", json: { sort: swapWith } }),
        apiV1(`/api/v1/orgs/${orgId}/courts/${b.id}`, { method: "PATCH", json: { sort: idx } }),
      ]);
    });
  };

  return (
    <section className={`card space-y-3 p-4 ${archived ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center">
          <input
            value={name}
            disabled={!canEdit || archived}
            onChange={(e) => setName(e.target.value)}
            className="input min-w-0 flex-1 font-semibold"
            aria-label={msg("venues.venue.editName")}
          />
          <input
            value={address}
            disabled={!canEdit || archived}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={msg("venues.venue.addressPlaceholder")}
            className="input min-w-0 flex-1 text-sm text-slate-500"
            aria-label={msg("venues.venue.addressLabel")}
          />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {archived && <span className="badge bg-slate-200 text-slate-500">{msg("venues.venue.archived")}</span>}
          {canEdit && dirty && !archived && (
            <button type="button" disabled={busy || !name.trim()} onClick={saveVenue} className="btn btn-primary px-2.5 py-1.5 text-xs">
              {msg("venues.venue.save")}
            </button>
          )}
          {canEdit && archived && (
            <button type="button" disabled={busy} onClick={unarchiveVenue} className="btn btn-ghost px-2.5 py-1.5 text-xs">
              {msg("venues.venue.unarchive")}
            </button>
          )}
          {canEdit && !archived && (
            <button type="button" disabled={busy} onClick={archiveVenue} className="text-xs text-slate-500 underline hover:text-slate-700">
              {msg("venues.venue.archive")}
            </button>
          )}
          {canEdit && (
            <button type="button" disabled={busy} onClick={deleteVenue} className="text-xs text-red-500 underline hover:text-red-700">
              {msg("venues.venue.delete")}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2 border-t border-slate-100 pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{msg("venues.courts.title")}</p>
        {visibleCourts.length === 0 ? (
          <p className="text-xs text-slate-400">{msg("venues.courts.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {visibleCourts.map((court, i) => (
              <CourtRow
                key={court.id}
                court={court}
                orgId={orgId}
                canEdit={canEdit && !archived}
                busy={busy}
                run={run}
                msg={msg}
                plural={plural}
                confirm={confirm}
                tagSuggestions={tagSuggestions}
                isFirst={i === 0}
                isLast={i === visibleCourts.length - 1}
                onMoveUp={() => moveCourt(court.id, "up")}
                onMoveDown={() => moveCourt(court.id, "down")}
              />
            ))}
          </ul>
        )}
        {canEdit && !archived && <AddCourtForm busy={busy} onSubmit={addCourt} msg={msg} />}
      </div>
    </section>
  );
}

function AddCourtForm({ busy, onSubmit, msg }: { busy: boolean; onSubmit: (name: string) => void; msg: Msg }) {
  const [name, setName] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2 pt-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit(name.trim());
        setName("");
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-slate-500">
        {msg("venues.court.add.name")}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={msg("venues.court.add.namePlaceholder")}
          className="input"
        />
      </label>
      <button type="submit" disabled={busy || !name.trim()} className="btn btn-ghost px-3 py-2 text-xs">
        {busy ? msg("venues.court.add.submitting") : msg("venues.court.add.submit")}
      </button>
    </form>
  );
}

function CourtRow({
  court,
  orgId,
  canEdit,
  busy,
  run,
  msg,
  plural,
  confirm,
  tagSuggestions,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
}: {
  court: Court;
  orgId: string;
  canEdit: boolean;
  busy: boolean;
  run: RunFn;
  msg: Msg;
  plural: Plural;
  confirm: Confirm;
  tagSuggestions: string[];
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [name, setName] = useState(court.name);
  const [expanded, setExpanded] = useState(false);
  const dirty = name.trim() !== court.name;
  const archived = court.archived_at !== null;

  const saveName = () =>
    run(
      () => apiV1(`/api/v1/orgs/${orgId}/courts/${court.id}`, { method: "PATCH", json: { name: name.trim() } }),
      msg("venues.notice.courtUpdated"),
    );

  const setTags = (tags: string[]) =>
    run(() => apiV1(`/api/v1/orgs/${orgId}/courts/${court.id}`, { method: "PATCH", json: { tags } }));

  const archiveCourt = async () => {
    const ok = await confirm({
      title: msg("venues.court.confirmArchive.title"),
      body: msg("venues.court.confirmArchive.body"),
      confirmLabel: msg("venues.court.confirmArchive.confirm"),
    });
    if (!ok) return;
    run(
      () => apiV1(`/api/v1/orgs/${orgId}/courts/${court.id}/archive`, { method: "POST" }),
      msg("venues.notice.courtArchived"),
    );
  };

  const unarchiveCourt = () =>
    run(
      () => apiV1(`/api/v1/orgs/${orgId}/courts/${court.id}/archive`, { method: "DELETE" }),
      msg("venues.notice.courtUnarchived"),
    );

  const deleteCourt = async () => {
    const ok = await confirm({
      title: msg("venues.court.confirmDelete.title"),
      body: msg("venues.court.confirmDelete.body"),
      confirmLabel: msg("venues.court.confirmDelete.confirm"),
      tone: "danger",
    });
    if (!ok) return;
    run(() => apiV1(`/api/v1/orgs/${orgId}/courts/${court.id}`, { method: "DELETE" }), msg("venues.notice.courtDeleted"));
  };

  return (
    <li className={`rounded-lg border border-slate-200 bg-white p-3 ${archived ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            value={name}
            disabled={!canEdit || archived}
            onChange={(e) => setName(e.target.value)}
            className="input min-w-0 flex-1 text-sm font-medium"
            aria-label={msg("venues.court.editName")}
          />
          {archived && <span className="badge bg-slate-200 text-slate-500">{msg("venues.court.archived")}</span>}
          {canEdit && dirty && !archived && (
            <button type="button" disabled={busy || !name.trim()} onClick={saveName} className="btn btn-primary shrink-0 px-2.5 py-1.5 text-xs">
              {msg("venues.venue.save")}
            </button>
          )}
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={busy || isFirst || archived}
              onClick={onMoveUp}
              aria-label={msg("venues.court.moveUp")}
              className="btn btn-ghost px-2 py-1 text-xs"
            >
              {"↑"}
            </button>
            <button
              type="button"
              disabled={busy || isLast || archived}
              onClick={onMoveDown}
              aria-label={msg("venues.court.moveDown")}
              className="btn btn-ghost px-2 py-1 text-xs"
            >
              {"↓"}
            </button>
          </div>
        )}
      </div>

      <div className="mt-2">
        <TagChipInput
          value={court.tags}
          onChange={setTags}
          suggestions={tagSuggestions}
          disabled={!canEdit || busy || archived}
          label={msg("venues.court.tagsLabel")}
          placeholder={msg("tags.placeholder")}
          addLabel={msg("tags.add")}
          removeLabelFor={(tag) => msg("tags.remove", { tag })}
          suggestionsLabel={msg("tags.suggestions")}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-2 text-xs">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="font-medium text-purple-700 underline"
        >
          {expanded ? msg("venues.court.hideHours") : msg("venues.court.editHours")}
        </button>
        {canEdit && archived && (
          <button type="button" disabled={busy} onClick={unarchiveCourt} className="text-slate-500 underline hover:text-slate-700">
            {msg("venues.court.unarchive")}
          </button>
        )}
        {canEdit && !archived && (
          <button type="button" disabled={busy} onClick={archiveCourt} className="text-slate-500 underline hover:text-slate-700">
            {msg("venues.court.archive")}
          </button>
        )}
        {canEdit && (
          <button type="button" disabled={busy} onClick={deleteCourt} className="text-red-500 underline hover:text-red-700">
            {msg("venues.court.delete")}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3">
          <CourtCalendarEditor
            court={court}
            orgId={orgId}
            canEdit={canEdit && !archived}
            busy={busy}
            run={run}
            msg={msg}
            plural={plural}
          />
        </div>
      )}
    </li>
  );
}

function DayHoursBar({ ranges }: { ranges: { open_min: number; close_min: number }[] }) {
  return (
    <div aria-hidden className="relative h-2 w-full overflow-hidden rounded-full bg-slate-100">
      {ranges.map((r, i) => (
        <div
          key={i}
          className="absolute inset-y-0 rounded-full bg-purple-400"
          style={{
            left: `${(r.open_min / 1440) * 100}%`,
            width: `${Math.max(0, ((r.close_min - r.open_min) / 1440) * 100)}%`,
          }}
        />
      ))}
    </div>
  );
}

function WeekdayRow({
  weekday,
  ranges,
  msg,
  disabled,
  onAddRange,
  onRemoveRange,
  onUpdateRange,
  onCopyToAllDays,
}: {
  weekday: number;
  ranges: { h: CourtHours; index: number }[];
  msg: Msg;
  disabled: boolean;
  onAddRange: () => void;
  onRemoveRange: (index: number) => void;
  onUpdateRange: (index: number, field: "open_min" | "close_min", hhmm: string) => void;
  onCopyToAllDays: () => void;
}) {
  return (
    <div className="space-y-1.5 border-t border-slate-100 pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <span className="w-9 shrink-0 text-xs font-semibold text-slate-500">{msg(WEEKDAY_KEYS[weekday]!)}</span>
        <div className="min-w-0 flex-1">
          <DayHoursBar ranges={ranges.map(({ h }) => h)} />
        </div>
        {!disabled && (
          <button
            type="button"
            onClick={onCopyToAllDays}
            className="shrink-0 text-[11px] text-purple-600 underline hover:text-purple-800"
          >
            {msg("venues.calendar.copyToAllDays")}
          </button>
        )}
      </div>
      {ranges.length === 0 ? (
        <p className="pl-11 text-xs text-slate-400">{msg("venues.calendar.dayClosed")}</p>
      ) : (
        <ul className="space-y-1.5 pl-11">
          {ranges.map(({ h, index }) => (
            <li key={index} className="flex flex-wrap items-center gap-1.5">
              <DateTimeField
                kind="time"
                label={msg("venues.calendar.openLabel")}
                labelHidden
                value={hhmmOfMinutes(h.open_min)}
                disabled={disabled}
                onChange={(v) => onUpdateRange(index, "open_min", v)}
              />
              <span aria-hidden className="text-xs text-slate-400">
                {"–"}
              </span>
              <DateTimeField
                kind="time"
                label={msg("venues.calendar.closeLabel")}
                labelHidden
                value={hhmmOfMinutes(h.close_min)}
                disabled={disabled}
                onChange={(v) => onUpdateRange(index, "close_min", v)}
              />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onRemoveRange(index)}
                  className="text-xs text-red-500 underline hover:text-red-700"
                >
                  {msg("venues.calendar.removeRange")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <button type="button" onClick={onAddRange} className="ml-11 text-xs text-purple-600 underline hover:text-purple-800">
          {msg("venues.calendar.addRange")}
        </button>
      )}
    </div>
  );
}

function ExceptionsEditor({
  exceptions,
  msg,
  disabled,
  onAdd,
  onRemove,
  onUpdate,
}: {
  exceptions: CourtException[];
  msg: Msg;
  disabled: boolean;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<CourtException>) => void;
}) {
  return (
    <div className="space-y-2">
      {exceptions.length === 0 ? (
        <p className="text-xs text-slate-400">{msg("venues.calendar.noExceptions")}</p>
      ) : (
        <ul className="space-y-2">
          {exceptions.map((e, index) => (
            <li key={index} className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-2">
              <DateTimeField
                kind="date"
                label={msg("venues.calendar.exceptionDate")}
                labelHidden
                value={e.date}
                disabled={disabled}
                onChange={(v) => onUpdate(index, { date: v })}
              />
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={e.closed}
                  disabled={disabled}
                  onChange={(ev) =>
                    onUpdate(
                      index,
                      ev.target.checked
                        ? { closed: true, open_min: null, close_min: null }
                        : { closed: false, open_min: 9 * 60, close_min: 17 * 60 },
                    )
                  }
                  className="h-4 w-4 rounded border-purple-200 accent-purple-600"
                />
                {msg("venues.calendar.exceptionClosed")}
              </label>
              {!e.closed && (
                <>
                  <DateTimeField
                    kind="time"
                    label={msg("venues.calendar.openLabel")}
                    labelHidden
                    value={e.open_min !== null ? hhmmOfMinutes(e.open_min) : ""}
                    disabled={disabled}
                    onChange={(v) => {
                      const m = minutesOfDay(v);
                      if (m !== null) onUpdate(index, { open_min: m });
                    }}
                  />
                  <span aria-hidden className="text-xs text-slate-400">
                    {"–"}
                  </span>
                  <DateTimeField
                    kind="time"
                    label={msg("venues.calendar.closeLabel")}
                    labelHidden
                    value={e.close_min !== null ? hhmmOfMinutes(e.close_min) : ""}
                    disabled={disabled}
                    onChange={(v) => {
                      const m = minutesOfDay(v);
                      if (m !== null) onUpdate(index, { close_min: m });
                    }}
                  />
                </>
              )}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  className="ml-auto text-xs text-red-500 underline hover:text-red-700"
                >
                  {msg("venues.calendar.removeException")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <button type="button" onClick={onAdd} className="text-xs text-purple-600 underline hover:text-purple-800">
          {msg("venues.calendar.addException")}
        </button>
      )}
    </div>
  );
}

function CourtCalendarEditor({
  court,
  orgId,
  canEdit,
  busy,
  run,
  msg,
  plural,
}: {
  court: Court;
  orgId: string;
  canEdit: boolean;
  busy: boolean;
  run: RunFn;
  msg: Msg;
  plural: Plural;
}) {
  const [hours, setHours] = useState<CourtHours[]>(court.hours);
  const [exceptions, setExceptions] = useState<CourtException[]>(court.exceptions);
  const [stranded, setStranded] = useState<number | null>(null);
  const disabled = !canEdit;

  const overlap = hasHoursOverlap(hours);
  const invalidRange = hasInvalidRange(hours);
  const hasEmptyExceptionDate = exceptions.some((e) => !e.date);

  const rangesFor = (weekday: number) =>
    hours.map((h, index) => ({ h, index })).filter(({ h }) => h.weekday === weekday);

  const updateRangeField = (index: number, field: "open_min" | "close_min", hhmm: string) => {
    const m = minutesOfDay(hhmm);
    if (m === null) return;
    setHours(hours.map((h, i) => (i === index ? { ...h, [field]: m } : h)));
  };

  const saveCalendar = () => {
    setStranded(null);
    run(async () => {
      const result = await apiV1<{ strandedFixtureCount: number }>(
        `/api/v1/orgs/${orgId}/courts/${court.id}/calendar`,
        { method: "PUT", json: { hours, exceptions } },
      );
      setStranded(result.strandedFixtureCount);
    }, msg("venues.calendar.saved"));
  };

  return (
    <div className="space-y-4 rounded-lg bg-slate-50 p-3">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {msg("venues.calendar.weeklyHours")}
        </p>
        <div className="space-y-2">
          {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
            <WeekdayRow
              key={weekday}
              weekday={weekday}
              ranges={rangesFor(weekday)}
              msg={msg}
              disabled={disabled}
              onAddRange={() => setHours([...hours, { weekday, open_min: 9 * 60, close_min: 17 * 60 }])}
              onRemoveRange={(index) => setHours(hours.filter((_, i) => i !== index))}
              onUpdateRange={updateRangeField}
              onCopyToAllDays={() => setHours(copyHoursToAllDays(hours, weekday))}
            />
          ))}
        </div>
        {overlap && (
          <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
            {msg("venues.calendar.overlapWarning")}
          </p>
        )}
        {invalidRange && (
          <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
            {msg("venues.calendar.invalidRangeWarning")}
          </p>
        )}
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {msg("venues.calendar.exceptions")}
        </p>
        <p className="mb-2 text-xs text-slate-500">{msg("venues.calendar.exceptionsDesc")}</p>
        <ExceptionsEditor
          exceptions={exceptions}
          msg={msg}
          disabled={disabled}
          onAdd={() => setExceptions([...exceptions, { date: "", closed: true, open_min: null, close_min: null }])}
          onRemove={(index) => setExceptions(exceptions.filter((_, i) => i !== index))}
          onUpdate={(index, patch) => setExceptions(exceptions.map((e, i) => (i === index ? { ...e, ...patch } : e)))}
        />
      </div>

      {stranded !== null && stranded > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {plural("venues.calendar.stranded", stranded)}
        </p>
      )}

      {canEdit && (
        <button
          type="button"
          disabled={busy || overlap || invalidRange || hasEmptyExceptionDate}
          onClick={saveCalendar}
          className="btn btn-primary text-xs"
        >
          {msg("venues.calendar.save")}
        </button>
      )}
    </div>
  );
}
