"use client";
// RS006 — public stepper chassis (design §4). Owns all client state: WHO
// contact fields, the cart (steps.ts/cart.ts), CONSENT's two cart-wide
// choices, the current step index, and sessionStorage persistence
// (storage.ts) so a refresh mid-flow survives.
//
// All five steps are built as of this session: steps.ts's order runs
// who -> [entries] -> details -> consent -> review, and "review" is a
// genuine final step with its own Submit action (handleSubmit below) — not
// a step before a "more steps" end-cap. There is therefore no longer a
// one-past-the-end position to render (steps.test.ts's own "hypothetical"
// case predicted exactly this generic index math, unchanged from earlier
// waves).
//
// `?join=` deep-link (RS007): accepted as a prop and deliberately unused —
// the seam is "render nothing, don't crash on the param" (RS006 prompt).
import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/i18n/dict-provider";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useHydrated } from "@/lib/use-client-snapshot";
import { formatMinor, type Currency } from "@/lib/currency";
import {
  autoLinkObviousSelf,
  autoSeedSingleDivision,
  cartReducer,
  clearSelfLinkWhenNotPlaying,
  payableDivision,
  summarizeCart,
  type CartAction,
} from "./cart";
import { lichessLinkStartHref } from "@/lib/lichess-link";
import { seasonStartYearFrom } from "./eligibility-presentation";
import { clearRegisterState, REGISTER_STATE_VERSION, loadRegisterState, saveRegisterState } from "./storage";
import {
  buildSubmitBody,
  classifySubmitFailure,
  resolvePostSubmitNavigation,
  type SubmitFailureKind,
  type SubmitResultShape,
} from "./submit";
import { StepConsent } from "./step-consent";
import { onlineDivisionNames, registerReturnPath, type RegisterLichessState } from "./register-lichess-card";
import { StepDetails } from "./step-details";
import { StepEntries } from "./step-entries";
import { StepNav } from "./step-nav";
import { StepReview } from "./step-review";
import { StepWho } from "./step-who";
import { buildStepOrder, nextStepIndex, prevStepIndex, shouldCollapseEntries, stepFocusTransition } from "./steps";
import { BTN_GHOST, BTN_PRIMARY } from "./styles";
import {
  EMPTY_CART,
  EMPTY_CONSENT,
  EMPTY_CONTACT,
  type CartState,
  type ConsentState,
  type ContactState,
  type DivisionLike,
} from "./types";
import {
  validateConsent,
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
  // The one blocker with no inline state of its own to point at, so this
  // banner has to name it rather than defer upward — see DetailsValidation's
  // own comment (validation.ts).
  selfRowUnnamed: "register.errors.selfPlayerRequired",
};

export interface RegisterInfo {
  competition: { name: string; starts_on: string | null };
  /** Widened at step 4 (CONSENT) — `org.name` interpolates into the GDPR
   *  data-processing sentence (register.consent.data). The real
   *  PublicRegistrationInfo the server hands page.tsx already carries this
   *  (schemas.ts:2354); narrowed here the same way `divisions` already is. */
  org: { name: string };
  divisions: DivisionLike[];
}

export function RegisterStepper({
  orgSlug,
  competitionSlug,
  info,
  locale,
  joinCode,
  lichess = null,
}: {
  orgSlug: string;
  competitionSlug: string;
  info: RegisterInfo;
  locale: string;
  /** RS007's seam — see the file header. Carried onto the root element as a
   *  data attribute (never rendered as content) so it is a concrete,
   *  inspectable hook rather than a prop nothing ever reads. */
  joinCode?: string | null;
  /** I5 (T16 fix round 1): this viewer's Lichess link state, read by the page only when a division plays online;
   *  null ⇒ no division does, and no card is offered. */
  lichess?: RegisterLichessState | null;
}) {
  const t = useT();
  // I5: where a Lichess link start comes back to — this registration, its join code kept (the draft is in
  // sessionStorage, so the player lands back on the step they left).
  const lichessReturn = registerReturnPath(orgSlug, competitionSlug, joinCode ?? null);
  const openDivisions = info.divisions.filter((d) => d.open);
  // The collapse now depends on the single division's entrant kind, not just
  // the count — see shouldCollapseEntries. Both this and the auto-seed below
  // must ask the SAME predicate: they used to state the rule independently
  // (`openDivisions.length === 1` inline), which is how a collapsed step 2
  // and a seeded-but-unnameable team entry could disagree.
  const collapseEntries = shouldCollapseEntries(openDivisions.length, openDivisions[0]?.entrant_kind);
  const stepOrder = buildStepOrder(openDivisions.length, openDivisions[0]?.entrant_kind);
  const seasonStartYear = seasonStartYearFrom(info.competition.starts_on);

  // `false` on the server and in the hydration render, `true` from the render after (and on the first render of a
  // client-side mount) — a read through a store, so nothing has to set it from an effect.
  const hydrated = useHydrated();
  const [contact, setContact] = useState<ContactState>(EMPTY_CONTACT);
  const [imPlaying, setImPlaying] = useState(false);
  // FIX 2 (RS006 fix wave) — this used to be a lazy initializer that called
  // `crypto.randomUUID()` directly for the single-open-division auto-seed
  // (design §4: "step 2 collapses..."). That id genuinely differs between
  // the server pass and the client's first render, which made the
  // post-hydration restore's own "deterministic (same on server and first
  // client render)" claim below false for this one case. Nothing on step 0
  // rendered an entry-derived id, so no mismatch was visible YET — but it
  // was one entry-id-keyed key/data-* away from a real hydration mismatch
  // that discards the whole client tree. EMPTY_CART is trivially identical
  // either side; the auto-seed (with a REAL id) now happens in the
  // post-hydration restore below instead, which — like the sessionStorage
  // restore it sits beside — only ever runs client-side, after the
  // identical hydration render.
  const [cart, setCart] = useState<CartState>(EMPTY_CART);
  const [stepIndex, setStepIndex] = useState(0);
  const [whoAttempted, setWhoAttempted] = useState(false);
  const [entriesAttempted, setEntriesAttempted] = useState(false);
  const [detailsAttempted, setDetailsAttempted] = useState(false);
  const [consentAttempted, setConsentAttempted] = useState(false);
  // Step 4's two cart-wide choices (design §4 step 4) — a separate
  // top-level slice from `contact`, matching ConsentState's own doc comment
  // (types.ts): these are SIBLING fields on the wire request, not nested
  // under `contact` the way guardian_name/guardian_consent are.
  const [consent, setConsent] = useState<ConsentState>(EMPTY_CONSENT);
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
  // Step 5's submit — NOT persisted (a refresh mid-submit should retry, not
  // silently resume a stale "submitting" state).
  const [submitting, setSubmitting] = useState(false);
  // FIX 3 (RS006 fix wave) — was a bare `string | null` (whatever
  // `err.message` happened to be, rendered as-is, the ONLY thing the
  // registrant saw). `kind` (classifySubmitFailure, submit.ts) picks which
  // of the two LOCALIZED recovery messages is PRIMARY; `detail` is the raw
  // server message, still shown, but only ever as secondary text — server
  // errors are English-only by design (no server-side i18n), so it must
  // never be the primary thing a registrant reads.
  const [submitError, setSubmitError] = useState<{
    kind: SubmitFailureKind;
    detail: string;
    code?: string;
  } | null>(null);
  // Review finding #2 (MEDIUM) — focus management across step transitions.
  // `containerRef` scopes the DOM query the focus effect below runs
  // (mirrors modal.tsx's own `dialogRef`/`querySelectorAll` pattern);
  // `stepFocusArmed` is that effect's OWN memory of whether it has already
  // seen its first post-hydration commit — see stepFocusTransition's own
  // doc comment (steps.ts) for exactly what it decides and why.
  const containerRef = useRef<HTMLDivElement>(null);
  const stepFocusArmed = useRef(false);

  // Hydrate from sessionStorage once, client-only, in the FIRST render after
  // hydration (or the first render of a client-side mount). The initial useState
  // values above are genuinely deterministic (same on server and first client
  // render — FIX 2, see the cart useState's own comment), so the markup that
  // hydrates matches the server's; this render-phase adjustment — React throws
  // the pass away and re-renders at once, so the unrestored state is never
  // committed or painted — is what makes a mid-flow refresh survive, AND (the
  // `else` branch below) what seeds a single-open-division cart's real id,
  // without an SSR/CSR mismatch either way. It used to be a mount effect that
  // set all of this (and `hydrated` itself) after the paint.
  //
  // Nothing is saved before it has run: the save effect below is guarded by
  // `hydrated`, which is only ever true in a render that has restored.
  const [restored, setRestored] = useState(false);
  if (hydrated && !restored) {
    setRestored(true);
    const saved = loadRegisterState(orgSlug, competitionSlug);
    if (saved) {
      setContact(saved.contact);
      setImPlaying(saved.imPlaying);
      // A restored snapshot can carry an EMPTY cart — the visitor advanced
      // past WHO without adding an entry, or a division closed since they
      // saved. When entries is collapsed there is no step on which to add
      // one, so restoring that emptiness verbatim walks them to REVIEW with
      // nothing to submit and a `.min(1)` 422 they cannot act on. The seed
      // is therefore keyed on "the cart is empty and entries is collapsed",
      // NOT on "this is a fresh visit" — the `else if` below only covers
      // the fresh case, which is what left this route open.
      setCart(
        collapseEntries && saved.cart.entries.length === 0
          ? { ...EMPTY_CART, entries: autoSeedSingleDivision(openDivisions[0]!, crypto.randomUUID()) }
          : saved.cart,
      );
      setConsent(saved.consent);
      // Clamped to the LAST real step, never stepOrder.length itself —
      // "review" (step 5) has its own Submit action, not a "coming soon"
      // end-cap one past it (storage.ts's own doc comment on this field).
      setStepIndex(Math.min(saved.stepIndex, stepOrder.length - 1));
    } else if (collapseEntries) {
      // FIX 2 (RS006 fix wave) — design §4: "step 2 collapses when the
      // competition has one open division," so that one division is
      // auto-added on a FRESH visit (no saved snapshot to restore
      // instead) so the cart is never empty once WHO is complete. This
      // used to happen in the cart's OWN useState lazy initializer,
      // generating the id with `crypto.randomUUID()` right there — see
      // that state's own comment for why calling it here, post-hydration,
      // client-only, is what actually fixes the determinism this block's
      // header now correctly claims.
      setCart({ ...EMPTY_CART, entries: autoSeedSingleDivision(openDivisions[0]!, crypto.randomUUID()) });
    }
    // A restored field the rep hasn't touched YET (this visit) must render
    // as pristine helper text, never a submitted-state error (fix wave
    // finding #5) — reset explicitly so restore is correct BY CONSTRUCTION,
    // rather than relying on these already defaulting to false from
    // whichever mount path got here.
    setWhoAttempted(false);
    setEntriesAttempted(false);
    setDetailsAttempted(false);
    setConsentAttempted(false);
  }

  useEffect(() => {
    if (!hydrated) return;
    saveRegisterState(orgSlug, competitionSlug, {
      version: REGISTER_STATE_VERSION,
      contact,
      imPlaying,
      cart,
      consent,
      stepIndex,
    });
  }, [hydrated, orgSlug, competitionSlug, contact, imPlaying, cart, consent, stepIndex]);

  // See cart.ts's autoLinkObviousSelf doc comment: links the one cart entry to
  // "I'm playing" only when there is no ambiguity, never overriding an explicit
  // choice. clearSelfLinkWhenNotPlaying is the inverse direction (fix wave
  // finding #2): un-toggling "I'm playing" must clear ANY self-link, auto- or
  // explicitly-made, or a stale registering_self:true with no dob collected
  // reaches submit. Composing the two is safe in either order — each is a no-op
  // exactly when the other one applies.
  //
  // Re-evaluated when its inputs change — the toggle, or the cart's SIZE (the
  // old effect's own triggers) — as a render-phase adjustment, not an effect
  // that re-set the cart after the paint. It looks at the SETTLED state, which
  // is why it is not folded into each handler: solo signup is one event with two
  // dispatches (ADD_ENTRY a team, then UPDATE_ENTRY free_agent:true), and
  // linking after the first would make a free agent the contact's own row.
  //
  // It waits for the restore (`restored`): the old effect fired once on the first
  // render with imPlaying's STALE pre-restore value, cleared every restored
  // self-link, and only a lone entry's second invocation masked it (RS006
  // regression, found against a restored multi-self-link snapshot). On a
  // client-side mount `hydrated` is true on the very first render, where this
  // branch would read the pre-restore cart and set it over the restored one.
  const linkSeed = `${imPlaying}|${cart.entries.length}`;
  const [linkedFor, setLinkedFor] = useState("");
  if (restored && linkedFor !== linkSeed) {
    setLinkedFor(linkSeed);
    setCart(clearSelfLinkWhenNotPlaying(autoLinkObviousSelf(cart, imPlaying), imPlaying));
  }

  // Review finding #2 (MEDIUM) — move focus to the new step's own heading
  // on a REAL step transition (goNext/goBack), never on the initial mount
  // (including a restored snapshot that lands straight on a later step —
  // stepFocusTransition's own doc comment, steps.ts, has the full
  // reasoning). Each Step* component's own `<h2>` already carries the
  // right copy for its step; `tabIndex={-1}` there is what makes it a
  // valid programmatic focus target without joining the natural Tab order.
  // DOM-only side effect, no jsdom in this workspace — pinned at the
  // source level only (register-stepper-interaction.test.tsx), same split
  // modal.tsx/modal.test.ts already established for the modal's own focus
  // trap.
  useEffect(() => {
    const decision = stepFocusTransition(hydrated, stepFocusArmed.current);
    stepFocusArmed.current = decision.armed;
    if (decision.focus) {
      containerRef.current?.querySelector<HTMLHeadingElement>("h2")?.focus();
    }
  }, [hydrated, stepIndex]);

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
  const consentValidation = validateConsent(cart, contact, consent, new Date());
  // Computed unconditionally every render, same convention as the three
  // validations above — cheap for a cart capped at MAX_CART_ENTRIES, and
  // both StepReview's own line items AND the submit button's label
  // (handleSubmit/the nav row below) read this ONE result, never a second
  // computation (summarizeCart's own doc comment).
  const reviewSummary = summarizeCart(cart, info.divisions);
  // Submit button label (design §4 step 5's three cases): free, pay-by-card-
  // now, or pay-the-organiser-later. Reads `payableDivision` — the SAME
  // lookup StepReview's own payment-method note reads — so the two can
  // never disagree (payableDivision's own doc comment).
  const reviewPayable = payableDivision(reviewSummary);
  const submitLabel =
    reviewSummary.subtotalCents === 0 || !reviewSummary.currency
      ? t("register.submit.free")
      : t(reviewPayable?.payment_method === "stripe" ? "register.submit.card" : "register.submit.fee", {
          fee: formatMinor(reviewSummary.subtotalCents, reviewSummary.currency as Currency, locale),
        });

  // Clamped to the LAST real step, never stepOrder.length — "review" is a
  // genuine final step with its own Submit action, not a position before a
  // "coming soon" end-cap (matches the post-hydration restore's own clamp above).
  // Re-clamped on EVERY render, not just at hydration: a division flipping
  // `open` live (e.g. its window just closed) can shrink stepOrder between
  // renders, and a stale stepIndex must not point past the new, shorter list.
  const clampedIndex = Math.min(stepIndex, stepOrder.length - 1);
  const currentStep = stepOrder[clampedIndex];
  const canGoNext =
    currentStep === "who"
      ? contactValidation.valid
      : currentStep === "entries"
        ? entriesValidation.valid
        : currentStep === "details"
          ? detailsValidation.valid
          : currentStep === "consent"
            ? consentValidation.valid
            : false; // "review" advances via handleSubmit, never goNext

  function goNext() {
    if (currentStep === "who") setWhoAttempted(true);
    if (currentStep === "entries") setEntriesAttempted(true);
    if (currentStep === "details") setDetailsAttempted(true);
    if (currentStep === "consent") setConsentAttempted(true);
    if (!canGoNext) return;
    setStepIndex((i) => nextStepIndex(i, stepOrder));
  }
  function goBack() {
    setStepIndex((i) => prevStepIndex(i));
  }

  /**
   * Design §4 step 5: submit the whole cart. `checkout_url` non-null ->
   * redirect to Stripe (window.location.assign, matching
   * registration-actions.tsx's own precedent); null (free/offline) ->
   * straight to the group status page, by id + token (resolvePostSubmit
   * Navigation — the SAME `?rid=&token=` convention buildCartMail/
   * createRegistrationCheckout already mint). The sessionStorage draft is
   * cleared on EITHER success path: the cart is committed server-side
   * either way, so nothing here should ever be replayed. `submitting` is
   * deliberately left `true` on the success path — the page is about to
   * navigate away, so there is no further interaction to unblock; only the
   * catch branch resets it, so a failed attempt can be retried.
   *
   * FIX 3 (RS006 fix wave) — the catch branch used to render `err.message`
   * verbatim as the ONLY thing the registrant saw: a bare server string
   * (English-only, no server-side i18n — see `lib/errors.ts`) with no
   * distinction between "retry the exact same click" (a 409 checkout-mint
   * conflict, any 5xx) and "something about THIS submission needs to
   * change first" (the honeypot's 400 included — indistinguishable, from
   * here, from any other 400/422). `classifySubmitFailure` (submit.ts)
   * makes that call from the HTTP status alone (via `ApiV1Error.status` —
   * `apiV1`, `lib/client-v1.ts`). Neither `contact`/`consent`/`cart`/
   * `website` state is ever touched in this catch branch, so whatever the
   * registrant filled in across all five steps is still exactly there to
   * resubmit — nothing is lost on a failed attempt.
   */
  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await apiV1<SubmitResultShape>(
        `/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/register`,
        { method: "POST", json: buildSubmitBody(contact, consent, cart, website) },
      );
      clearRegisterState(orgSlug, competitionSlug);
      const nav = resolvePostSubmitNavigation(result, orgSlug, competitionSlug);
      window.location.assign(nav.url);
    } catch (err) {
      const status = err instanceof ApiV1Error ? err.status : undefined;
      setSubmitError({
        kind: classifySubmitFailure(status),
        detail: err instanceof Error ? err.message : String(err),
        code: err instanceof ApiV1Error ? err.code : undefined,
      });
      setSubmitting(false);
    }
  }

  return (
    <div ref={containerRef} className="space-y-4">
      {/* The RS007 seam marker. `ph-no-capture` on its OWN empty element, not on this root: the join code is a capability
          (anyone holding it can join the entry), PostHog replay records attributes before the `before_send` scrub can see
          them, and its recorder blocks only this class on the element that carries the value, which here would be the
          whole registration form. `hidden`, so it takes no space. */}
      {joinCode ? <span hidden className="ph-no-capture" data-join-code={joinCode} /> : null}
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

      {currentStep === "consent" && (
        <StepConsent
          lichess={(() => {
            const divisions = lichess === null ? [] : onlineDivisionNames(cart, info.divisions);
            return lichess === null || divisions.length === 0
              ? null
              : { divisions, orgSlug, next: lichessReturn, state: lichess };
          })()}
          contact={contact}
          onContactChange={(patch) => setContact((c) => ({ ...c, ...patch }))}
          consent={consent}
          onConsentChange={(patch) => setConsent((c) => ({ ...c, ...patch }))}
          cart={cart}
          orgName={info.org.name}
          errors={consentAttempted ? consentValidation.errors : {}}
        />
      )}

      {currentStep === "review" && (
        <>
          <StepReview summary={reviewSummary} locale={locale} />
          {submitError &&
            (submitError.code === "LICHESS_LINK_REQUIRED" || submitError.code === "LICHESS_RECONSENT_REQUIRED" ? (
              // A Lichess reason says WHAT is wrong and WHAT to do, so it stands alone: the generic "check your details"
              // line would send a player with correct details hunting for a mistake they have not made. The amber is the
              // Lichess card's own "needs reconnecting" colour (register-lichess-card.tsx), the one place this is said
              // before the submit; the sentence is the localized copy, never the server's English.
              <div
                role="alert"
                data-testid="reg-lichess-refusal"
                className="flex min-w-0 items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0">
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                  <path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                </svg>
                {submitError.code === "LICHESS_LINK_REQUIRED" ? (
                  <p className="m-0 min-w-0">
                    {t("register.lichessLinkRequired")}{" "}
                    {/* `ph-no-capture`: the return path carries the team's join code (`?join=`), url-encoded into this href. */}
                    <a href={lichessLinkStartHref(orgSlug, lichessReturn)} className="ph-no-capture font-medium underline" data-testid="register-lichess-link">
                      {t("register.lichessLinkCta")}
                    </a>
                  </p>
                ) : (
                  // The link is there but cannot play (the registration gate refuses what the seat gate refuses): the same
                  // start, back to this registration, under the reconnect words.
                  <p className="m-0 min-w-0">
                    {t("register.lichessReconnectRequired")}{" "}
                    <a href={lichessLinkStartHref(orgSlug, lichessReturn)} className="ph-no-capture font-medium underline" data-testid="register-lichess-reconnect-link">
                      {t("register.lichess.reconnect.cta")}
                    </a>
                  </p>
                )}
              </div>
            ) : (
              <div role="alert" className="space-y-1">
                {/* Primary — localized, actionable, never the raw server
                    string (FIX 3: server errors are English-only by design,
                    see handleSubmit's own doc comment above). */}
                <p className="text-sm text-red-600">
                  {t(submitError.kind === "retry" ? "register.submit.error" : "register.submit.errorRejected")}
                </p>
                {/* Secondary — the raw detail, de-emphasized: useful context
                    (e.g. "another checkout was just started"), never the
                    primary thing read. */}
                <p className="text-xs text-ink-muted">{submitError.detail}</p>
              </div>
            ))}
        </>
      )}

      {/* relative z-50: the SAME escape hatch cookie-consent.tsx documents
          for dialogs (its own header comment — "nothing needs to sit above
          a modal") — z-50 matches the confirm-dialog tier so the fixed,
          z-40 cookie banner never wins the tie and swallows a click on
          Back/Next (fix wave finding #6; regression-pinned in
          register-stepper-interaction.test.tsx via the SAME z-index
          source-contract convention as cookie-consent-below-dialogs.test.ts). */}
      <div className="relative z-50 flex items-center justify-between">
        <button
          type="button"
          data-testid="reg-back"
          onClick={goBack}
          disabled={stepIndex === 0}
          className={BTN_GHOST}
        >
          {t("register.nav.back")}
        </button>
        {currentStep === "review" ? (
          <button
            type="button"
            data-testid="reg-submit"
            onClick={handleSubmit}
            disabled={submitting}
            className={BTN_PRIMARY}
          >
            {submitLabel}
          </button>
        ) : (
          <button type="button" data-testid="reg-next" onClick={goNext} className={BTN_PRIMARY}>
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
