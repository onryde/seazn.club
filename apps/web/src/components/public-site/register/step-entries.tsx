"use client";
// RS006 Step 2 — ENTRIES (design §4 step 2). Orchestrates the division
// cards + the cart panel; owns nothing itself beyond wiring cart.ts's
// actions to fresh ids (crypto.randomUUID() — kept out of the pure reducer
// on purpose, see cart.ts's header) and computing each division's
// self-eligibility once per render.
import { useT } from "@/components/i18n/dict-provider";
import { canAddEntry, type CartAction } from "./cart";
import { DivisionCard } from "./division-card";
import { selfEligibilityForDivision } from "./eligibility-presentation";
import { EntryCart } from "./entry-cart";
import type { CartState, ContactState, DivisionLike } from "./types";

export function StepEntries({
  divisions,
  cart,
  dispatch,
  contact,
  imPlaying,
  seasonStartYear,
  locale,
}: {
  divisions: readonly DivisionLike[];
  cart: CartState;
  dispatch: (action: CartAction) => void;
  contact: ContactState;
  imPlaying: boolean;
  seasonStartYear: number;
  locale: string;
}) {
  const t = useT();
  const canAdd = canAddEntry(cart);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px] lg:items-start">
      {/* min-w-0: Tailwind's arbitrary grid-cols-[...] syntax (unlike
          grid-cols-N) does NOT imply minmax(0,1fr) — without this, a long,
          space-less organiser-authored division name several levels down
          (division-card.tsx's own <h3>) can inflate this whole 1fr track
          past its fair share (review finding #3, LOW). */}
      <div className="min-w-0 rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
        <h2 tabIndex={-1} className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
          {t("register.entries.heading")}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">{t("register.entries.subtitle")}</p>

        <div className="mt-4 space-y-3">
          {divisions.map((division) => {
            const selfEligibility = imPlaying
              ? selfEligibilityForDivision(division, contact, seasonStartYear)
              : null;
            // free_agent starts false for every kind here — the solo-signup
            // handler below sets it via a SEPARATE UPDATE_ENTRY dispatch
            // right after adding, rather than this helper branching on it.
            const addAt = (kind: DivisionLike["entrant_kind"]) => () =>
              dispatch({
                type: "ADD_ENTRY",
                id: crypto.randomUUID(),
                division_id: division.division_id,
                entrant_kind: kind,
              });
            return (
              <DivisionCard
                key={division.division_id}
                division={division}
                locale={locale}
                selfEligibility={selfEligibility}
                imPlaying={imPlaying}
                onAddTeam={canAdd && division.entrant_kind === "team" ? addAt("team") : undefined}
                onAddPair={canAdd && division.entrant_kind === "pair" ? addAt("pair") : undefined}
                onAddIndividual={canAdd && division.entrant_kind === "individual" ? addAt("individual") : undefined}
                onAddSoloSignup={
                  canAdd && division.entrant_kind === "team" && division.allow_free_agents
                    ? () => {
                        const id = crypto.randomUUID();
                        dispatch({ type: "ADD_ENTRY", id, division_id: division.division_id, entrant_kind: "team" });
                        dispatch({ type: "UPDATE_ENTRY", id, patch: { free_agent: true } });
                      }
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>

      <EntryCart
        cart={cart}
        divisions={divisions}
        dispatch={dispatch}
        locale={locale}
        contact={contact}
        imPlaying={imPlaying}
        seasonStartYear={seasonStartYear}
      />
    </div>
  );
}
