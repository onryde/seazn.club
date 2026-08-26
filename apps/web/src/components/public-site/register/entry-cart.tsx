"use client";
// RS006 Step 2 — the cart panel (design §4 step 2). Naming a team/pair
// happens INLINE on its cart row (typed at add-time or any time after);
// there is no separate naming dialog. Self-link is single-select
// cart-wide (cart.ts's SET_SELF_ENTRY) — rendered as individual checkboxes
// that behave like a radio group (checking one unchecks any other).
import { useT } from "@/components/i18n/dict-provider";
import { formatMinor, type Currency } from "@/lib/currency";
import type { CartAction } from "./cart";
import { BTN_TEXT } from "./styles";
import { MAX_CART_ENTRIES, type CartEntry, type CartState, type DivisionLike } from "./types";

const UNNAMED_KEY: Record<CartEntry["entrant_kind"], "register.entries.unnamed.team" | "register.entries.unnamed.pair" | "register.entries.unnamed.individual"> = {
  team: "register.entries.unnamed.team",
  pair: "register.entries.unnamed.pair",
  individual: "register.entries.unnamed.individual",
};

function entryDisplayName(entry: CartEntry): string | null {
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
}: {
  cart: CartState;
  divisions: readonly DivisionLike[];
  dispatch: (action: CartAction) => void;
  locale: string;
}) {
  const t = useT();
  const byId = new Map(divisions.map((d) => [d.division_id, d]));

  let subtotalCents = 0;
  let currency: string | null = null;
  for (const entry of cart.entries) {
    const division = byId.get(entry.division_id);
    if (!division) continue;
    if (division.closed_reason === "full") continue; // waitlisted — not charged now
    subtotalCents += division.fee_cents;
    currency = division.currency;
  }

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
      <h2 className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
        {t("register.entries.cart.heading")}
      </h2>

      {cart.entries.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">{t("register.entries.cart.empty")}</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {cart.entries.map((entry) => {
            const division = byId.get(entry.division_id);
            const willWaitlist = division?.closed_reason === "full";
            const isSelf = cart.selfEntryId === entry.id;
            const name = entryDisplayName(entry);
            return (
              <li key={entry.id} className="rounded-lg border border-zinc-200 bg-canvas p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-display text-sm font-semibold uppercase tracking-wide text-ink">
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

                {willWaitlist && <p className="mt-1.5 text-xs text-amber-700">{t("register.entries.cart.waitlistNote")}</p>}

                <label className="mt-2 flex items-center gap-2 text-xs text-ink-muted">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent"
                    checked={isSelf}
                    onChange={(e) => dispatch({ type: "SET_SELF_ENTRY", id: e.target.checked ? entry.id : null })}
                  />
                  {t("register.entries.cart.self")}
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {cart.entries.length >= MAX_CART_ENTRIES && (
        <p className="mt-2 text-xs text-ink-muted">{t("register.entries.cart.max", { max: MAX_CART_ENTRIES })}</p>
      )}

      {cart.selfEntryId && (
        <p className="mt-2 text-xs text-ink-muted">{t("register.entries.cart.selfHint")}</p>
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
