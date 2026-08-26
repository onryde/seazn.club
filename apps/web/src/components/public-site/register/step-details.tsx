"use client";
// RS006 Step 3 — DETAILS (design §4 step 3). Orchestrates one EntryDetails
// card per cart entry, in cart order — mirrors step-entries.tsx's own shape
// (a thin map over cart state, no logic of its own beyond the lookup).
import { useT } from "@/components/i18n/dict-provider";
import type { CartAction } from "./cart";
import { EntryDetails } from "./entry-details";
import type { CartState, ContactState, DivisionLike } from "./types";

export function StepDetails({
  divisions,
  cart,
  dispatch,
  contact,
  seasonStartYear,
}: {
  divisions: readonly DivisionLike[];
  cart: CartState;
  dispatch: (action: CartAction) => void;
  contact: ContactState;
  seasonStartYear: number;
}) {
  const t = useT();
  const byId = new Map(divisions.map((d) => [d.division_id, d]));

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
        <h2 className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
          {t("register.details.heading")}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">{t("register.details.subtitle")}</p>
      </div>

      <div className="space-y-4">
        {cart.entries.map((entry) => (
          <EntryDetails
            key={entry.id}
            entry={entry}
            division={byId.get(entry.division_id)}
            contact={contact}
            isSelfEntry={cart.selfEntryId === entry.id}
            selfPlayerIndex={cart.selfPlayerIndex}
            seasonStartYear={seasonStartYear}
            dispatch={dispatch}
          />
        ))}
      </div>
    </div>
  );
}
