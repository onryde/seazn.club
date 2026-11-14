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
  orgName,
  importTextByEntry,
  onImportTextChange,
}: {
  divisions: readonly DivisionLike[];
  cart: CartState;
  dispatch: (action: CartAction) => void;
  contact: ContactState;
  seasonStartYear: number;
  /** The organiser's name, for each card's "Questions from {org}" heading. */
  orgName: string;
  /** Keyed by entry id — see roster-table.tsx's header for why the paste
   *  draft lives here (RegisterStepper) rather than as RosterTable's own
   *  local state. */
  importTextByEntry: Record<string, string>;
  onImportTextChange: (entryId: string, text: string) => void;
}) {
  const t = useT();
  const byId = new Map(divisions.map((d) => [d.division_id, d]));

  return (
    <div className="space-y-4">
      {/* The step's heading and its one line of help, with no card of their own (B2 T9, spec 7.3): the cards below are the entries,
          one each. The heading stays the step's level-2 heading and the focus target of a step change (register-stepper.tsx). */}
      <div>
        <h2 tabIndex={-1} className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
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
            isSelfEntry={entry.registering_self}
            selfPlayerIndex={entry.self_player_index}
            seasonStartYear={seasonStartYear}
            orgName={orgName}
            dispatch={dispatch}
            importText={importTextByEntry[entry.id] ?? ""}
            onImportTextChange={(text) => onImportTextChange(entry.id, text)}
          />
        ))}
      </div>
    </div>
  );
}
