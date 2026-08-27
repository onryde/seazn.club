"use client";
// RS007 join page — the interactive island: slot picker, WHO + CONSENT
// (RS006's own step components, reused verbatim — see step-who.tsx's
// showSelfToggle for the one seam this needed), submit, and the designed
// success/error states (design skill: errors don't apologise and are never
// vague — say what happened and what to do next).
//
// CRITICAL — join_code is a CAPABILITY TOKEN (like the status page's own
// access token). This file NEVER renders a raw server error string: every
// failure is classified by HTTP STATUS ALONE (classifyJoinFailure,
// view-model.ts) into one of four fixed, fully-localized banners. Unlike
// pay-button.tsx/cancel-entry.tsx/resend-confirmation.tsx (which render
// `err.message` verbatim, hardcoded-English, on their catch branches — a
// known, separately-tracked gap, not this file's pattern to repeat), no
// server-provided text ever reaches this component's output, so there is
// no path by which the code — or anything else server-side — could leak
// into the page.
import { useState } from "react";
import { useT } from "@/components/i18n/dict-provider";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { StepConsent } from "@/components/public-site/register/step-consent";
import { StepWho } from "@/components/public-site/register/step-who";
import { validateConsent, validateContact } from "@/components/public-site/register/validation";
import { EMPTY_CONSENT, EMPTY_CONTACT, type ConsentState, type ContactState } from "@/components/public-site/register/types";
import { BTN_PRIMARY } from "@/components/public-site/register/styles";
import {
  buildJoinBody,
  canSubmitJoin,
  classifyJoinFailure,
  defaultSlotChoice,
  joinerCart,
  joinWhoRequirements,
  NEW_PLAYER_CHOICE,
  rosterMeterAfterJoin,
  selectionAfterRefresh,
  type JoinFailureKind,
  type JoinSlot,
  type SlotChoice,
} from "./view-model";

export interface JoinFormProps {
  orgSlug: string;
  competitionSlug: string;
  joinCode: string;
  /** The entry's own label — used only for the success state's confirmation
   *  sentence ("Your spot on {entry} is confirmed"). The "Joining X ·
   *  Division" context header lives in page.tsx, server-rendered from the
   *  same preview data, not threaded through here a second time. */
  displayName: string;
  orgName: string;
  unclaimedSlots: JoinSlot[];
  allowNewPlayer: boolean;
  requiresDob: boolean;
  requiresGender: boolean;
  totalPlayers: number;
  initialPlayerId: string | null;
}

function joinPreviewUrl(orgSlug: string, competitionSlug: string, joinCode: string): string {
  return `/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/register/join?join_code=${encodeURIComponent(joinCode)}`;
}

function joinSubmitUrl(orgSlug: string, competitionSlug: string): string {
  return `/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/register/join`;
}

export function JoinForm({
  orgSlug,
  competitionSlug,
  joinCode,
  displayName,
  orgName,
  unclaimedSlots,
  allowNewPlayer,
  requiresDob,
  requiresGender,
  totalPlayers,
  initialPlayerId,
}: JoinFormProps) {
  const t = useT();
  const [slots, setSlots] = useState(unclaimedSlots);
  const [allowNew, setAllowNew] = useState(allowNewPlayer);
  const [selected, setSelected] = useState<SlotChoice | null>(() =>
    defaultSlotChoice(unclaimedSlots, allowNewPlayer, initialPlayerId),
  );
  const [contact, setContact] = useState<ContactState>(EMPTY_CONTACT);
  const [consent, setConsent] = useState<ConsentState>(EMPTY_CONSENT);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<JoinFailureKind | null>(null);
  const [meter, setMeter] = useState<{ claimed: number; total: number } | null>(null);

  const requirements = joinWhoRequirements(requiresDob, requiresGender);
  const contactValidation = validateContact(contact, requirements);
  const cart = joinerCart(contact);
  const consentValidation = validateConsent(cart, contact, consent, new Date());
  const canSubmit = canSubmitJoin(selected) && contactValidation.valid && consentValidation.valid;

  async function refreshSlots() {
    setRefreshing(true);
    try {
      const fresh = await apiV1<{ unclaimed_slots: JoinSlot[]; allow_new_player: boolean }>(
        joinPreviewUrl(orgSlug, competitionSlug, joinCode),
      );
      setSlots(fresh.unclaimed_slots);
      setAllowNew(fresh.allow_new_player);
      // FIX 4 (RS007 review): NEW_PLAYER_CHOICE is never a real player_id,
      // so a bare "still in the fresh list" check always read it as gone —
      // selectionAfterRefresh (view-model.ts) special-cases it against
      // `fresh.allow_new_player` instead.
      setSelected((prev) => selectionAfterRefresh(prev, fresh.unclaimed_slots, fresh.allow_new_player));
      setFailure(null);
    } catch {
      // Best-effort — a failed refresh leaves the stale list up rather than
      // compounding one error banner with another; Join itself can still be
      // retried, which surfaces a fresh classified failure on its own.
    } finally {
      setRefreshing(false);
    }
  }

  async function submit() {
    setAttempted(true);
    if (!canSubmit) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await apiV1(joinSubmitUrl(orgSlug, competitionSlug), {
        method: "POST",
        json: buildJoinBody(joinCode, selected!, contact, consent),
      });
      setMeter(rosterMeterAfterJoin(totalPlayers, slots.length, selected === NEW_PLAYER_CHOICE));
    } catch (err) {
      const status = err instanceof ApiV1Error ? err.status : undefined;
      setFailure(classifyJoinFailure(status));
      setSubmitting(false);
    }
  }

  if (meter) {
    return (
      <div role="status" className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
        <div aria-hidden className="mb-3 h-0.5 w-10 bg-accent" />
        <h2 className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
          {t("register.join.success.heading")}
        </h2>
        <p className="mt-2 text-sm text-ink">{t("register.join.success.body", { entry: displayName })}</p>
        <p className="mt-1 text-sm text-ink-muted">
          {t("register.status.roster.meter", { claimed: meter.claimed, total: meter.total })}
        </p>
        <a
          href={`/shared/${orgSlug}/${competitionSlug}`}
          className="mt-4 inline-block text-sm font-medium text-accent-strong underline underline-offset-2"
        >
          {t("register.join.back.cta")}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <fieldset className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
        <legend className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
          {t("register.join.slot.heading")}
        </legend>
        <div className="mt-4 space-y-2">
          {slots.map((slot) => (
            <label
              key={slot.player_id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-canvas px-3.5 py-3"
            >
              <input
                type="radio"
                name="join-slot"
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                checked={selected === slot.player_id}
                onChange={() => setSelected(slot.player_id)}
              />
              <span className="text-sm font-medium text-ink">{slot.full_name}</span>
            </label>
          ))}
          {allowNew && (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-canvas px-3.5 py-3">
              <input
                type="radio"
                name="join-slot"
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                checked={selected === NEW_PLAYER_CHOICE}
                onChange={() => setSelected(NEW_PLAYER_CHOICE)}
              />
              <span className="text-sm font-medium text-ink">{t("register.join.slot.newOption")}</span>
            </label>
          )}
        </div>
        {attempted && selected === null && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {t("register.join.slot.error")}
          </p>
        )}
      </fieldset>

      <StepWho
        contact={contact}
        onChange={(patch) => setContact((c) => ({ ...c, ...patch }))}
        imPlaying={true}
        onImPlayingChange={() => {}}
        requirements={requirements}
        errors={attempted ? contactValidation.errors : {}}
        showSelfToggle={false}
      />

      <StepConsent
        contact={contact}
        onContactChange={(patch) => setContact((c) => ({ ...c, ...patch }))}
        consent={consent}
        onConsentChange={(patch) => setConsent((c) => ({ ...c, ...patch }))}
        cart={cart}
        orgName={orgName}
        errors={attempted ? consentValidation.errors : {}}
      />

      {failure && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700">
          <p>{t(FAILURE_KEY[failure])}</p>
          {failure === "conflict" && (
            <button
              type="button"
              onClick={refreshSlots}
              disabled={refreshing}
              className="mt-2 text-xs font-semibold uppercase tracking-wide text-red-700 underline underline-offset-2 disabled:opacity-50"
            >
              {refreshing ? t("register.join.error.refreshing") : t("register.join.error.refresh")}
            </button>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button type="button" onClick={submit} disabled={submitting} className={BTN_PRIMARY}>
          {submitting ? t("register.join.submit.busy") : t("register.join.submit.cta")}
        </button>
      </div>
    </div>
  );
}

/** register.submit.error is the SAME generic "please try again" copy the
 *  main register flow's own retry bucket uses (submit.ts's
 *  classifySubmitFailure) — genuinely domain-neutral, reused rather than
 *  duplicated. The other three are join-specific designed states. */
const FAILURE_KEY: Record<JoinFailureKind, string> = {
  retry: "register.submit.error",
  notFound: "register.join.invalid.body",
  conflict: "register.join.error.claimed",
  rejected: "register.join.error.rejected",
};
