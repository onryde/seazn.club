"use client";
// RS006 Step 2 — the cart panel (design §4 step 2). Naming a team/pair
// happens INLINE on its cart row (typed at add-time or any time after);
// there is no separate naming dialog. Self-link is PER-ENTRY (cart.ts's
// SET_ENTRY_SELF) — a registrant may check "This is me" on any number of
// entries independently (singles + doubles at the same tournament is the
// common racket-sports case); checking one does NOT uncheck another.
import { useT } from "@/components/i18n/dict-provider";
import { formatMinor, type Currency } from "@/lib/currency";
import { summarizeCart, type CartAction } from "./cart";
import { INELIGIBLE_MESSAGE_KEY, selfEligibilityForDivision } from "./eligibility-presentation";
import { BTN_TEXT } from "./styles";
import { teamNameMissing } from "./validation";
import { MAX_CART_ENTRIES, type CartEntry, type CartState, type ContactState, type DivisionLike } from "./types";

// Exported for step-review.tsx (step 5) — a cart line reads the same either
// way it's shown, so the naming fallback lives in exactly one place (same
// "reuse, do not fork" principle summarizeCart's own doc comment states for
// the subtotal math).
export const UNNAMED_KEY: Record<CartEntry["entrant_kind"], "register.entries.unnamed.team" | "register.entries.unnamed.pair" | "register.entries.unnamed.individual"> = {
  team: "register.entries.unnamed.team",
  pair: "register.entries.unnamed.pair",
  individual: "register.entries.unnamed.individual",
};

export function entryDisplayName(entry: CartEntry): string | null {
  if (entry.free_agent) return null;
  if (entry.entrant_kind === "team") return entry.team_name;
  if (entry.entrant_kind === "pair") return entry.partner_name;
  return null;
}

export function EntryCart({
  cart,
  divisions,
  dispatch,
  locale,
  contact,
  imPlaying,
  seasonStartYear,
}: {
  cart: CartState;
  divisions: readonly DivisionLike[];
  dispatch: (action: CartAction) => void;
  locale: string;
  /** For the self-linked line's own eligibility verdict (fix wave finding
   *  #3) — the SAME predicate DivisionCard already greys the division
   *  with, not a second evaluation. */
  contact: ContactState;
  /** Gates the "This is me" checkbox (fix wave finding #2): a contact who
   *  hasn't said they're playing has nothing to link, and showing the
   *  control anyway is how a stale self-link survived un-toggling it. */
  imPlaying: boolean;
  seasonStartYear: number;
}) {
  const t = useT();
  // RS006 §C: summarizeCart is the ONE subtotal/waitlist computation shared
  // with step-review.tsx (step 5) — see that function's own doc comment
  // (cart.ts) for why this must not fork back into a second copy.
  const summary = summarizeCart(cart, divisions);
  const { subtotalCents, currency } = summary;

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
      <h2 className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
        {t("register.entries.cart.heading")}
      </h2>

      {cart.entries.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">{t("register.entries.cart.empty")}</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {summary.lines.map(({ entry, division, waitlisted: willWaitlist, staleClosed: isStaleClosed }) => {
            const isSelf = entry.registering_self;
            const name = entryDisplayName(entry);
            // Fix wave finding #3: the self-linked entry's OWN eligibility
            // verdict, via the SAME predicate DivisionCard greys the
            // division with — never a second evaluation.
            const selfVerdict = isSelf && division ? selfEligibilityForDivision(division, contact, seasonStartYear) : null;
            return (
              <li key={entry.id} className="rounded-lg border border-zinc-200 bg-canvas p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-display text-sm font-semibold uppercase tracking-wide text-ink">
                      {division?.name ?? entry.division_id}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {entry.free_agent
                        ? t("register.entries.cart.freeAgentBadge")
                        : name || t(UNNAMED_KEY[entry.entrant_kind])}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      className={BTN_TEXT}
                      onClick={() => dispatch({ type: "DUPLICATE_ENTRY", sourceId: entry.id, newId: crypto.randomUUID() })}
                      disabled={cart.entries.length >= MAX_CART_ENTRIES}
                    >
                      {t("register.entries.cart.duplicate")}
                    </button>
                    <button type="button" className={BTN_TEXT} onClick={() => dispatch({ type: "REMOVE_ENTRY", id: entry.id })}>
                      {t("register.entries.cart.remove")}
                    </button>
                  </div>
                </div>

                {!entry.free_agent && (entry.entrant_kind === "team" || entry.entrant_kind === "pair") && (
                  <input
                    type="text"
                    maxLength={120}
                    className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
                    /* A placeholder is NOT an accessible name, and it vanishes
                       the moment someone types — leaving an unlabelled text
                       field, on what is now a REQUIRED one for teams. Naming
                       it off the same key keeps the two in step, and follows
                       RosterTable's convention where the accessible name
                       doubles as the test locator, so a broken match here is a
                       real a11y regression rather than a stale selector. */
                    aria-label={t(
                      entry.entrant_kind === "team" ? "register.entries.teamName.placeholder" : "register.entries.partnerName.placeholder",
                    )}
                    aria-invalid={teamNameMissing(entry) || undefined}
                    placeholder={t(
                      entry.entrant_kind === "team" ? "register.entries.teamName.placeholder" : "register.entries.partnerName.placeholder",
                    )}
                    value={(entry.entrant_kind === "team" ? entry.team_name : entry.partner_name) ?? ""}
                    onChange={(e) =>
                      dispatch({
                        type: "UPDATE_ENTRY",
                        id: entry.id,
                        patch:
                          entry.entrant_kind === "team"
                            ? { team_name: e.target.value || null }
                            : { partner_name: e.target.value || null },
                      })
                    }
                  />
                )}

                {/* A team entry with no name 422s the WHOLE cart at submit
                    ("A team name is required", naming neither the step nor
                    which of up to ten entries). Say so here, against the
                    field that fixes it, using validation.ts's own predicate
                    so this cannot drift from the rule that blocks Next. */}
                {teamNameMissing(entry) && (
                  <p role="alert" className="mt-1.5 text-xs font-medium text-red-700">
                    {t("register.entries.cart.teamNameRequired")}
                  </p>
                )}

                {willWaitlist && <p className="mt-1.5 text-xs text-amber-700">{t("register.entries.cart.waitlistNote")}</p>}
                {/* Review finding 2 (2026-08-27): this note now BLOCKS
                    "Next" (validateEntries's staleClosedEntryId) rather than
                    being purely informational, so its copy is the stronger,
                    action-directed closedBlocking string (not the softer
                    closedNote step-review.tsx still uses for its read-only,
                    nothing-to-remove-from-there summary) — role="alert" to
                    match register-stepper.tsx's own error-banner convention
                    for a state that blocks progress. The Remove button right
                    above in this same row is "a way to remove it and
                    continue" — no separate control needed. */}
                {isStaleClosed && (
                  <p role="alert" className="mt-1.5 text-xs font-medium text-red-700">
                    {t("register.entries.cart.closedBlocking")}
                  </p>
                )}

                {selfVerdict && !selfVerdict.eligible && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {selfVerdict.issues
                      .map((issue) => INELIGIBLE_MESSAGE_KEY[issue.code])
                      .filter((key): key is string => Boolean(key))
                      .map((key) => (
                        <p key={key}>{t(key)}</p>
                      ))}
                  </div>
                )}

                {/* Gated on imPlaying (fix wave finding #2) — a contact who
                    hasn't said they're playing has nothing to link, so the
                    control is absent rather than merely disabled (same
                    "absent, not disabled" convention as steps.ts's
                    collapsed ENTRIES step). ALSO gated on !free_agent (RS006
                    §D, known gap): a free-agent entry has no roster UI to
                    ever resolve self_player_index — cart.ts's SET_ENTRY_SELF
                    refuses the state this checkbox would otherwise produce,
                    so the control itself is absent rather than offering a
                    choice that would 422 at submit. */}
                {imPlaying && !entry.free_agent && (
                  <label className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-accent"
                      checked={isSelf}
                      onChange={(e) => dispatch({ type: "SET_ENTRY_SELF", id: entry.id, isSelf: e.target.checked })}
                    />
                    {t("register.entries.cart.self")}
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {cart.entries.length >= MAX_CART_ENTRIES && (
        <p className="mt-2 text-xs text-ink-muted">{t("register.entries.cart.max", { max: MAX_CART_ENTRIES })}</p>
      )}

      {cart.entries.length > 0 && (
        <div className="mt-4 flex items-center justify-between border-t border-zinc-200 pt-3">
          <span className="font-display text-xs font-semibold uppercase tracking-wider text-ink-muted">
            {t("register.entries.cart.subtotal")}
          </span>
          <span className="font-display text-lg font-bold text-ink">
            {subtotalCents === 0 || !currency ? t("register.entries.free") : formatMinor(subtotalCents, currency as Currency, locale)}
          </span>
        </div>
      )}
    </div>
  );
}
