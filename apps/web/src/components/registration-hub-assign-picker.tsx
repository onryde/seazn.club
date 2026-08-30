"use client";

// RS009 — the sheet an organiser uses to put a pooled solo sign-up on a team.
//
// DESIGN NOTES, because the shape here is a decision and not a default.
//
// The organiser opening this is answering exactly one question: WHICH TEAM
// NEEDS A PLAYER. So the list is ordered by need — most room first — and the
// thing carrying the most visual weight is the roster fill, not the team
// name. Names are how you confirm the choice; fill is how you make it.
//
// Fill is drawn as DISCRETE SLOTS rather than a percentage bar, because a
// roster is a countable set of places, not a proportion: "two places left"
// is the fact an organiser acts on, and a 71%-full bar hides it. Above
// `SEGMENT_LIMIT` places the slots stop being countable at a glance and turn
// into visual noise at 320px, so wide rosters fall back to a continuous bar
// plus the numbers. Where the cap is NULL (unlimited) there is no
// denominator, so there is no meter at all — inventing one would imply a
// limit that does not exist.
//
// Blocked teams stay VISIBLE but disabled, each carrying its own reason.
// Hiding them would leave an organiser wondering where a team went; letting
// them be clicked would spend a round trip to tell them what we already
// know. The server remains authoritative — this only front-runs the two
// refusals it can predict (full, and a mixed division that would close
// single-gendered).
//
// Layout follows the ConfirmProvider pattern this product already uses:
// bottom sheet with a drag handle under `sm`, centred dialog above it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";

/** Above this many places the slots stop being countable at a glance and
 *  become noise on a 320px-wide sheet, so the meter switches to a bar. */
const SEGMENT_LIMIT = 12;

export interface AssignTarget {
  registration_id: string;
  display_name: string;
  roster_count: number;
  /** NULL means unlimited — never zero. */
  roster_cap: number | null;
  is_full: boolean;
  genders: (string | null)[];
}

export interface AssignTargetsResponse {
  division_id: string;
  division_category: string | null;
  targets: AssignTarget[];
}

export interface RegistrationHubAssignPickerProps {
  /** The pooled solo sign-up being placed. */
  registrationId: string;
  /** Their name, for the sheet's title — this is a person, not a row id. */
  registrantName: string;
  /** This entry's own gender, when known. Needed to predict the mixed rule
   *  before the click; null means we cannot predict it and must not guess. */
  registrantGender: string | null;
  /** Where they are now, when already placed — drives the Remove action. */
  currentTeamId: string | null;
  currentTeamName: string | null;
  divisionName: string;
}

/** Mirrors `compositionRefusal` in registration-assign.ts. The server is
 *  authoritative; this exists so the organiser is told BEFORE spending a
 *  click, not instead of the server checking.
 *
 *  Only `mixed` constrains composition, and only when this placement would
 *  CLOSE the roster: a mixed team of three men is still filling and must
 *  stay pickable, or an organiser placing solo sign-ups one at a time would
 *  be blocked at the very first one. */
export function mixedRuleBlocks(
  divisionCategory: string | null,
  target: AssignTarget,
  registrantGender: string | null,
): boolean {
  if (divisionCategory !== "mixed") return false;
  if (target.roster_cap === null) return false;
  if (target.roster_count + 1 < target.roster_cap) return false;
  const seen = new Set(
    [...target.genders, registrantGender].filter((g) => g === "m" || g === "f"),
  );
  return seen.size < 2;
}

/** Most room first, then teams that are merely full, then blocked ones.
 *  Ties break on name so the order is stable between renders — a list that
 *  reshuffles under the cursor is a list you misclick. */
export function orderTargets(
  targets: AssignTarget[],
  divisionCategory: string | null,
  registrantGender: string | null,
): AssignTarget[] {
  // Unlimited is compared as a RANK, never as Infinity arithmetic. The
  // previous version returned `Number.POSITIVE_INFINITY` for an unlimited cap
  // and subtracted, so two unlimited rosters produced `Infinity - Infinity` =
  // NaN; `NaN !== 0` is true, the comparator returned NaN, and V8 treats that
  // as "no opinion" — the name tiebreak below never ran and the order was
  // whatever the input happened to be. Exactly the reshuffling this function
  // exists to prevent, in the one case the file documents three times.
  const rank = (t: AssignTarget) => (t.roster_cap === null ? 1 : 0);
  const roomOf = (t: AssignTarget) => (t.roster_cap === null ? 0 : t.roster_cap - t.roster_count);
  return [...targets].sort((a, b) => {
    const aBlocked = a.is_full || mixedRuleBlocks(divisionCategory, a, registrantGender);
    const bBlocked = b.is_full || mixedRuleBlocks(divisionCategory, b, registrantGender);
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
    // Unlimited rosters first — they always have room — then by room left.
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    const room = roomOf(b) - roomOf(a);
    if (room !== 0) return room;
    return a.display_name.localeCompare(b.display_name);
  });
}

function FillMeter({ count, cap }: { count: number; cap: number | null }) {
  const msg = useMsg();
  if (cap === null) {
    // No denominator, so no meter. A bar here would draw a limit that does
    // not exist.
    return (
      <span className="shrink-0 text-xs tabular-nums text-slate-500">
        {msg("reg.hub.registrants.assign.fillUnlimited", { count })}
      </span>
    );
  }
  const filled = Math.min(count, cap);
  const label = msg("reg.hub.registrants.assign.srFill", { count: filled, cap });
  return (
    <span className="flex shrink-0 items-center gap-2">
      {cap <= SEGMENT_LIMIT ? (
        <span aria-hidden className="flex items-center gap-[3px]">
          {Array.from({ length: cap }, (_, i) => (
            <span
              key={i}
              className={`h-3 w-1.5 rounded-[2px] ${i < filled ? "bg-purple-500" : "bg-slate-200"}`}
            />
          ))}
        </span>
      ) : (
        <span aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
          <span
            className="block h-full rounded-full bg-purple-500"
            style={{ width: `${Math.round((filled / cap) * 100)}%` }}
          />
        </span>
      )}
      <span className="text-xs tabular-nums text-slate-600">
        <span className="sr-only">{label}</span>
        <span aria-hidden>
          {filled}/{cap}
        </span>
      </span>
    </span>
  );
}

export function RegistrationHubAssignPicker({
  registrationId,
  registrantName,
  registrantGender,
  currentTeamId,
  currentTeamName,
  divisionName,
}: RegistrationHubAssignPickerProps) {
  const msg = useMsg();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AssignTargetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Why the LIST could not be shown. Separate from `actionError` on
   *  purpose: sharing one state meant a refused assign (a lost race for the
   *  last place, a mixed-composition refusal, a 409) blanked every target,
   *  so the organiser could not pick a different team without closing and
   *  reopening the sheet — the refusal took away the very thing they needed
   *  to act on it. */
  const [error, setError] = useState<string | null>(null);
  /** Why the last assign/unassign was refused. Shown ABOVE the list, which
   *  stays on screen. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        // `/api/v1/...` in full: apiV1 is a thin fetch wrapper around the
        // envelope and prepends NOTHING (see client-v1.ts). Every sibling
        // call in registration-hub-registrant-actions.tsx spells the prefix
        // out for the same reason. Without it this fetched
        // `/registrations/…` and every open of the sheet 404'd — with a
        // 5481-test suite green, because no unit test issues a real request
        // and the route tests call the handler directly.
        await apiV1<AssignTargetsResponse>(`/api/v1/registrations/${registrationId}/assign-targets`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [registrationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Esc closes and focus returns to the button that opened it — the same
  // contract ConfirmProvider gives, so the two sheets behave identically.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Restore focus to the opener ONLY when the sheet actually closes. The
  // first version ran on mount too — `open` is already false then — so simply
  // expanding a registrant's detail panel threw focus onto "Assign to a team"
  // and scrolled it into view, away from whatever the organiser was reading.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) openerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  async function assign(target: AssignTarget) {
    setBusyId(target.registration_id);
    setActionError(null);
    try {
      await apiV1(`/api/v1/registrations/${registrationId}/assign`, {
        method: "POST",
        // `json:` rather than a hand-stringified `body:` — the wrapper does
        // the serialising and sets the content type, same as every sibling.
        json: { target_registration_id: target.registration_id },
      });
      setFeedback(
        msg("reg.hub.registrants.assign.assigned", { team: target.display_name }),
      );
      setOpen(false);
      router.refresh();
    } catch (err) {
      // The server's own message, verbatim. It already says which team is
      // full or why a mixed roster refuses — rewording it here would give
      // the organiser a second, vaguer account of the same refusal. Also
      // re-load: a refusal usually means the roster moved under us, so the
      // fill numbers on screen are already stale.
      setActionError(err instanceof Error ? err.message : String(err));
      void load();
    } finally {
      setBusyId(null);
    }
  }

  async function unassign() {
    setBusyId("unassign");
    setActionError(null);
    try {
      await apiV1(`/api/v1/registrations/${registrationId}/unassign`, { method: "POST" });
      setFeedback(msg("reg.hub.registrants.assign.unassigned"));
      router.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const ordered = data
    ? orderTargets(data.targets, data.division_category, registrantGender)
    : [];

  return (
    // `contents` — see the matching comment in
    // registration-hub-registrant-actions.tsx. These controls belong in the
    // same wrap row as the other row actions, not on a line below them.
    <div data-registration-hub-assign className="contents">
      <div className="contents">
        {currentTeamId ? (
          <>
            <span
              data-registration-hub-assign-current
              className="inline-flex items-center rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-800"
            >
              {msg("reg.hub.registrants.assign.currentlyOn", { team: currentTeamName ?? "" })}
            </span>
            <button
              type="button"
              data-registration-hub-assign-action="unassign"
              className="btn btn-ghost text-xs"
              disabled={busyId !== null}
              onClick={unassign}
            >
              {busyId === "unassign"
                ? msg("reg.hub.registrants.assign.unassigning")
                : msg("reg.hub.registrants.assign.unassign")}
            </button>
          </>
        ) : (
          <button
            type="button"
            ref={openerRef}
            data-registration-hub-assign-action="open"
            className="btn btn-primary text-xs"
            onClick={() => setOpen(true)}
          >
            {msg("reg.hub.registrants.assign.cta")}
          </button>
        )}
      </div>

      {feedback && (
        <p className="w-full text-xs font-medium text-green-700" role="status">
          {feedback}
        </p>
      )}
      {actionError && !open && (
        <p className="w-full text-xs font-medium text-red-600" role="alert">
          {actionError}
        </p>
      )}

      {open && (
        <div
          className="fixed inset-x-0 top-0 z-50 flex h-dvh items-end justify-center bg-purple-950/30 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
        >
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={msg("reg.hub.registrants.assign.title", { name: registrantName })}
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-purple-100 bg-white shadow-2xl sm:max-w-md sm:rounded-2xl"
          >
            <div className="shrink-0 px-6 pt-6">
              <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-slate-200 sm:hidden" />
              <h2 className="text-base font-semibold text-slate-900">
                {msg("reg.hub.registrants.assign.title", { name: registrantName })}
              </h2>
              <p className="mt-1 text-sm text-slate-600">{divisionName}</p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {loading && (
                <p className="text-sm text-slate-500">
                  {msg("reg.hub.registrants.assign.loading")}
                </p>
              )}
              {actionError && (
                <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700" role="alert">
                  {actionError}
                </p>
              )}
              {!loading && error && (
                <p className="text-sm font-medium text-red-600" role="alert">
                  {error}
                </p>
              )}
              {!loading && !error && ordered.length === 0 && (
                <p className="text-sm text-slate-600">
                  {msg("reg.hub.registrants.assign.empty")}
                </p>
              )}
              {!loading && !error && ordered.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {ordered.map((t) => {
                    const mixedBlocked = mixedRuleBlocks(
                      data?.division_category ?? null,
                      t,
                      registrantGender,
                    );
                    const blocked = t.is_full || mixedBlocked;
                    return (
                      <li key={t.registration_id}>
                        <button
                          type="button"
                          data-registration-hub-assign-target={t.registration_id}
                          disabled={blocked || busyId !== null}
                          onClick={() => void assign(t)}
                          className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
                            blocked
                              ? "cursor-not-allowed bg-slate-50 opacity-70"
                              : "hover:bg-purple-50 focus-visible:bg-purple-50"
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-slate-900">
                              {t.display_name}
                            </span>
                            {blocked && (
                              <span className="mt-0.5 block text-xs text-slate-500">
                                {t.is_full
                                  ? msg("reg.hub.registrants.assign.full")
                                  : msg("reg.hub.registrants.assign.mixedBlocked")}
                              </span>
                            )}
                            {busyId === t.registration_id && (
                              <span className="mt-0.5 block text-xs text-slate-500">
                                {msg("reg.hub.registrants.assign.assigning")}
                              </span>
                            )}
                          </span>
                          <FillMeter count={t.roster_count} cap={t.roster_cap} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="shrink-0 border-t border-slate-100 px-6 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <button type="button" className="btn btn-ghost w-full" onClick={() => setOpen(false)}>
                {msg("reg.hub.registrants.assign.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
