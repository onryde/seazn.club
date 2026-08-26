"use client";
// RS006 — public stepper chassis (design §4). Owns all client state: WHO
// contact fields, the cart (steps.ts/cart.ts), the current step index, and
// sessionStorage persistence (storage.ts) so a refresh mid-flow survives.
//
// Steps 4-5 (CONSENT, REVIEW→PAY) are NOT built this session — steps.ts's
// step order tops out at "details", and pressing Next on the last one
// advances stepIndex to stepOrder.length (one past the end), where the
// "more steps" end-cap renders below. A later session appends real steps
// to steps.ts's order and this file's step-switch; nothing here needs to
// change shape to support that (steps.test.ts's "hypothetical" case proved
// this for steps.ts itself; the same generic index math is used here).
//
// `?join=` deep-link (RS007): accepted as a prop and deliberately unused —
// the seam is "render nothing, don't crash on the param" (RS006 prompt).
import { useEffect, useState } from "react";
import { useT } from "@/components/i18n/dict-provider";
import {
  autoLinkObviousSelf,
  autoSeedSingleDivision,
  cartReducer,
  clearSelfLinkWhenNotPlaying,
  type CartAction,
} from "./cart";
import { seasonStartYearFrom } from "./eligibility-presentation";
import { REGISTER_STATE_VERSION, loadRegisterState, saveRegisterState } from "./storage";
import { StepDetails } from "./step-details";
import { StepEntries } from "./step-entries";
import { StepNav } from "./step-nav";
import { StepWho } from "./step-who";
import { buildStepOrder, nextStepIndex, prevStepIndex } from "./steps";
import { BTN_GHOST, BTN_PRIMARY } from "./styles";
import { EMPTY_CART, EMPTY_CONTACT, type CartState, type ContactState, type DivisionLike } from "./types";
import {
  validateContact,
  validateDetails,
  validateEntries,
  whoFieldRequirements,
  type DetailsValidation,
  type EntriesValidation,
} from "./validation";

/** validation.ts's EntriesValidation error codes don't share a naming
 *  scheme with the register.errors.* dictionary keys — same reasoning as
 *  step-who.tsx's ERROR_KEY, an explicit map avoids silently building a key
 *  that doesn't exist. */
const ENTRIES_ERROR_KEY: Record<NonNullable<EntriesValidation["error"]>, string> = {
  cartEmpty: "register.errors.cartEmpty",
  selfIneligible: "register.errors.selfIneligible",
};

/** Same reasoning as ENTRIES_ERROR_KEY above. DETAILS_ERROR_KEY has only
 *  one code ("incomplete") deliberately: per-entry detail already renders
 *  inline (roster rows, the mixed meter, required-field markers all show
 *  their own state live) — this banner just confirms something up there is
 *  blocking, it doesn't re-enumerate every reason. */
const DETAILS_ERROR_KEY: Record<NonNullable<DetailsValidation["error"]>, string> = {
  incomplete: "register.errors.detailsIncomplete",
};

export interface RegisterInfo {
  competition: { name: string; starts_on: string | null };
  divisions: DivisionLike[];
}

export function RegisterStepper({
  orgSlug,
  competitionSlug,
  info,
  locale,
  joinCode,
}: {
  orgSlug: string;
  competitionSlug: string;
  info: RegisterInfo;
  locale: string;
  /** RS007's seam — see the file header. Carried onto the root element as a
   *  data attribute (never rendered as content) so it is a concrete,
   *  inspectable hook rather than a prop nothing ever reads. */
  joinCode?: string | null;
}) {
  const t = useT();
  const openDivisions = info.divisions.filter((d) => d.open);
  const stepOrder = buildStepOrder(openDivisions.length);
  const seasonStartYear = seasonStartYearFrom(info.competition.starts_on);

  const [hydrated, setHydrated] = useState(false);
  const [contact, setContact] = useState<ContactState>(EMPTY_CONTACT);
  const [imPlaying, setImPlaying] = useState(false);
  const [cart, setCart] = useState<CartState>(() =>
    openDivisions.length === 1
      ? { ...EMPTY_CART, entries: autoSeedSingleDivision(openDivisions[0]!, crypto.randomUUID()) }
      : EMPTY_CART,
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [whoAttempted, setWhoAttempted] = useState(false);
  const [entriesAttempted, setEntriesAttempted] = useState(false);
  const [detailsAttempted, setDetailsAttempted] = useState(false);
  // Step 3's paste-roster drafts, keyed by entry id — top-level state, NOT
  // persisted (storage.ts's snapshot never includes it), same reasoning as
  // `website` below: see roster-table.tsx's header for why this lives here
  // rather than as that component's own local state.
  const [importTextByEntry, setImportTextByEntry] = useState<Record<string, string>>({});
  // Honeypot (design §4 step 5 / RS003's route.ts): hidden from real users,
  // a filled value is a bot. The route checks `input.website` server-side
  // (already shipped) — this chassis only needs to carry the field through
  // to whichever session wires the final submit body.
  const [website, setWebsite] = useState("");

  // Hydrate from sessionStorage once, client-only. The initial useState
  // values above are deterministic (same on server and first client
  // render), so this effect — which only ever runs in the browser — is
  // what makes a mid-flow refresh survive without an SSR/CSR mismatch.
  useEffect(() => {
    const saved = loadRegisterState(orgSlug, competitionSlug);
    if (saved) {
      // react-hooks/set-state-in-effect flags this as a cascade risk in
      // general, but there is no other correct place to do it: reading
      // sessionStorage during the render itself (e.g. a useState lazy
      // initializer) would make the CLIENT's first-pass markup diverge
      // from what the SERVER rendered (sessionStorage doesn't exist
      // server-side) and React would discard the mismatched client tree.
      // Applying the restored snapshot here, strictly after the identical
      // first paint, is the standard fix for this exact class of problem.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContact(saved.contact);
      setImPlaying(saved.imPlaying);
      setCart(saved.cart);
      setStepIndex(Math.min(saved.stepIndex, stepOrder.length));
    }
    // A restored field the rep hasn't touched YET (this visit) must render
    // as pristine helper text, never a submitted-state error (fix wave
    // finding #5) — reset explicitly so restore is correct BY CONSTRUCTION,
    // rather than relying on these already defaulting to false from
    // whichever mount path got here.
    setWhoAttempted(false);
    setEntriesAttempted(false);
    setDetailsAttempted(false);
    setHydrated(true);
    // Intentionally empty deps: hydration runs exactly once, at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveRegisterState(orgSlug, competitionSlug, {
      version: REGISTER_STATE_VERSION,
      contact,
      imPlaying,
      cart,
      stepIndex,
    });
  }, [hydrated, orgSlug, competitionSlug, contact, imPlaying, cart, stepIndex]);

  // See cart.ts's autoLinkObviousSelf doc comment: links the one cart entry
  // to "I'm playing" only when there is no ambiguity, never overriding an
  // explicit choice. A reactive convenience over user input (the toggle,
  // the cart shrinking/growing to exactly one entry), not a derivation of
  // props/state that could be computed during render instead — genuinely
  // effect-shaped. clearSelfLinkWhenNotPlaying is the inverse direction
  // (fix wave finding #2): un-toggling "I'm playing" must clear ANY
  // self-link, auto- or explicitly-made, or a stale registering_self:true
  // with no dob collected reaches submit. Composing the two is safe in
  // either order — each is a no-op exactly when the other one applies.
  //
  // `if (!hydrated) return` guards a hydration race (RS006 regression, found
  // by manual browser verification against a restored multi-self-link
  // snapshot): on the FIRST render — before the hydration effect above has
  // applied its restored imPlaying/cart — this effect already fires once
  // with imPlaying's STALE pre-hydration value (false). Its functional
  // `setCart` updater still chains onto the hydration effect's newly-queued
  // cart value (React applies same-tick updates to one state variable in
  // call order), so clearSelfLinkWhenNotPlaying sees "imPlaying is false"
  // plus a cart that already has self-linked entries, and clears every one
  // of them — before the restored imPlaying:true ever commits. This was
  // invisible under the OLD cart-wide single-self-link model: with exactly
  // ONE entry, the SECOND invocation (once the real post-hydration values
  // commit) silently re-links it via autoLinkObviousSelf's own "exactly
  // one, unambiguous" rule, masking the bug. With 2+ self-linked entries
  // that second invocation's auto-link never fires (ambiguous), so the
  // damage from the stale first invocation stands. Matching the save
  // effect's own guard above is the fix: this effect has nothing correct to
  // do before hydration has applied the real values.
  useEffect(() => {
    if (!hydrated) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCart((prev) => clearSelfLinkWhenNotPlaying(autoLinkObviousSelf(prev, imPlaying), imPlaying));
  }, [hydrated, imPlaying, cart.entries.length]);

  function dispatchCart(action: CartAction) {
    setCart((prev) => cartReducer(prev, action));
  }

  // whoFieldRequirements filters to open divisions ITSELF (validation.ts) —
  // passed the full list here, matching its tested contract, rather than
  // pre-filtering and relying on a second filter pass being a harmless
  // no-op.
  const requirements = whoFieldRequirements(info.divisions, imPlaying);
  const contactValidation = validateContact(contact, requirements);
  const entriesValidation = validateEntries(cart, info.divisions, contact, seasonStartYear);
  const detailsValidation = validateDetails(cart, info.divisions, contact, seasonStartYear);

  const clampedIndex = Math.min(stepIndex, stepOrder.length);
  const currentStep = stepOrder[clampedIndex];
  const canGoNext =
    currentStep === "who"
      ? contactValidation.valid
      : currentStep === "entries"
        ? entriesValidation.valid
        : currentStep === "details"
          ? detailsValidation.valid
          : false;

  function goNext() {
    if (currentStep === "who") setWhoAttempted(true);
    if (currentStep === "entries") setEntriesAttempted(true);
    if (currentStep === "details") setDetailsAttempted(true);
    if (!canGoNext) return;
    setStepIndex((i) => nextStepIndex(i, stepOrder));
  }
  function goBack() {
    setStepIndex((i) => prevStepIndex(i));
  }

  return (
    <div className="space-y-4" data-join-code={joinCode ?? undefined}>
      <StepNav order={stepOrder} currentIndex={clampedIndex} />

      {currentStep === "who" && (
        <StepWho
          contact={contact}
          onChange={(patch) => setContact((c) => ({ ...c, ...patch }))}
          imPlaying={imPlaying}
          onImPlayingChange={setImPlaying}
          requirements={requirements}
          errors={whoAttempted ? contactValidation.errors : {}}
        />
      )}

      {currentStep === "entries" && (
        <>
          <StepEntries
            divisions={info.divisions}
            cart={cart}
            dispatch={dispatchCart}
            contact={contact}
            imPlaying={imPlaying}
            seasonStartYear={seasonStartYear}
            locale={locale}
          />
          {entriesAttempted && !entriesValidation.valid && entriesValidation.error && (
            <p role="alert" className="text-sm text-red-600">
              {t(ENTRIES_ERROR_KEY[entriesValidation.error])}
            </p>
          )}
        </>
      )}

      {currentStep === "details" && (
        <>
          <StepDetails
            divisions={info.divisions}
            cart={cart}
            dispatch={dispatchCart}
            contact={contact}
            seasonStartYear={seasonStartYear}
            importTextByEntry={importTextByEntry}
            onImportTextChange={(entryId, text) => setImportTextByEntry((m) => ({ ...m, [entryId]: text }))}
          />
          {detailsAttempted && !detailsValidation.valid && detailsValidation.error && (
            <p role="alert" className="text-sm text-red-600">
              {t(DETAILS_ERROR_KEY[detailsValidation.error])}
            </p>
          )}
        </>
      )}

      {clampedIndex >= stepOrder.length && (
        <div className="rounded-xl border border-accent-line bg-accent-soft p-5 text-center">
          <p className="font-display text-lg font-semibold uppercase tracking-wide text-accent-strong">
            {t("register.nav.comingSoon.title")}
          </p>
          <p className="mt-1 text-sm text-ink-muted">{t("register.nav.comingSoon.body")}</p>
        </div>
      )}

      {/* relative z-50: the SAME escape hatch cookie-consent.tsx documents
          for dialogs (its own header comment — "nothing needs to sit above
          a modal") — z-50 matches the confirm-dialog tier so the fixed,
          z-40 cookie banner never wins the tie and swallows a click on
          Back/Next (fix wave finding #6; regression-pinned in
          register-stepper-interaction.test.tsx via the SAME z-index
          source-contract convention as cookie-consent-below-dialogs.test.ts). */}
      <div className="relative z-50 flex items-center justify-between">
        <button type="button" onClick={goBack} disabled={stepIndex === 0} className={BTN_GHOST}>
          {t("register.nav.back")}
        </button>
        {clampedIndex < stepOrder.length && (
          <button type="button" onClick={goNext} className={BTN_PRIMARY}>
            {t("register.nav.next")}
          </button>
        )}
      </div>

      {/* Honeypot — hidden and out of the tab order/accessibility tree, so
          no genuine visitor (sighted, keyboard, or screen-reader) ever
          reaches it; a filled value is a bot (route.ts checks it server-
          side already — RS003). */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>
    </div>
  );
}
