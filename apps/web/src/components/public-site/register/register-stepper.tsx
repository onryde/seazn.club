"use client";
// RS006 — public stepper chassis (design §4). Owns all client state: WHO
// contact fields, the cart (steps.ts/cart.ts), the current step index, and
// sessionStorage persistence (storage.ts) so a refresh mid-flow survives.
//
// Steps 3-5 (DETAILS/roster, CONSENT, REVIEW→PAY) are NOT built this
// session — steps.ts's step order only ever contains "who"/"entries", and
// pressing Next on the last one advances stepIndex to stepOrder.length
// (one past the end), where the "more steps" end-cap renders below. A
// later session appends real steps to steps.ts's order and this file's
// step-switch; nothing here needs to change shape to support that.
//
// `?join=` deep-link (RS007): accepted as a prop and deliberately unused —
// the seam is "render nothing, don't crash on the param" (RS006 prompt).
import { useEffect, useState } from "react";
import { useT } from "@/components/i18n/dict-provider";
import {
  autoLinkObviousSelf,
  autoSeedSingleDivision,
  cartReducer,
  type CartAction,
} from "./cart";
import { seasonStartYearFrom } from "./eligibility-presentation";
import { REGISTER_STATE_VERSION, loadRegisterState, saveRegisterState } from "./storage";
import { StepEntries } from "./step-entries";
import { StepNav } from "./step-nav";
import { StepWho } from "./step-who";
import { buildStepOrder, nextStepIndex, prevStepIndex } from "./steps";
import { BTN_GHOST, BTN_PRIMARY } from "./styles";
import { EMPTY_CART, EMPTY_CONTACT, type CartState, type ContactState, type DivisionLike } from "./types";
import { validateContact, validateEntries, whoFieldRequirements } from "./validation";

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
      setContact(saved.contact);
      setImPlaying(saved.imPlaying);
      setCart(saved.cart);
      setStepIndex(Math.min(saved.stepIndex, stepOrder.length));
    }
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
  // explicit choice.
  useEffect(() => {
    setCart((prev) => autoLinkObviousSelf(prev, imPlaying));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imPlaying, cart.entries.length]);

  function dispatchCart(action: CartAction) {
    setCart((prev) => cartReducer(prev, action));
  }

  // whoFieldRequirements filters to open divisions ITSELF (validation.ts) —
  // passed the full list here, matching its tested contract, rather than
  // pre-filtering and relying on a second filter pass being a harmless
  // no-op.
  const requirements = whoFieldRequirements(info.divisions, imPlaying);
  const contactValidation = validateContact(contact, requirements);
  const entriesValidation = validateEntries(cart);

  const clampedIndex = Math.min(stepIndex, stepOrder.length);
  const currentStep = stepOrder[clampedIndex];
  const canGoNext =
    currentStep === "who"
      ? contactValidation.valid
      : currentStep === "entries"
        ? entriesValidation.valid
        : false;

  function goNext() {
    if (currentStep === "who") setWhoAttempted(true);
    if (currentStep === "entries") setEntriesAttempted(true);
    if (!canGoNext) return;
    setStepIndex((i) => nextStepIndex(i, stepOrder));
  }
  function goBack() {
    setStepIndex((i) => prevStepIndex(i, stepOrder));
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
          {entriesAttempted && !entriesValidation.valid && (
            <p role="alert" className="text-sm text-red-600">
              {t("register.errors.cartEmpty")}
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

      <div className="flex items-center justify-between">
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
