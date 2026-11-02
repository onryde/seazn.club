"use client";

// Competition wizard (PROMPT-15 task 1; reshaped by Match Day C8): one column —
// Name, Dates, Visibility, Who will find it, Showcase, Description, Create.
// POSTs /api/v1/competitions, then shows "Add your first division".
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import type { ViewerPlan } from "@/lib/viewer-plan";
import {
  publicDashboardGain,
  PUBLIC_DASHBOARD_FEATURE,
  type PublicDashboardUpgrade,
} from "@/lib/public-dashboard-upgrade";
import { VisibilitySegmented } from "@/components/ui/visibility-segmented";
import { ProseEditor } from "@/components/prose-editor";
import { CompetitionReach } from "@/components/v2/competition-reach";
import { ShowcaseOptIn } from "@/components/v2/showcase-optin";
import { FirstDivisionPrompt, type CreatedCompetition } from "@/components/v2/first-division-prompt";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { createBlocker, endsOnAfterStartChange, type CreateBlocker } from "@/lib/new-competition-form";
import { routes } from "@/lib/routes";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

/** The sentence beside a disabled Create, one per thing that can be missing. */
const BLOCKER_KEY: Record<CreateBlocker, MessageKey> = {
  name: "comp.wizard.missing.name",
  endsOn: "comp.wizard.missing.endsOn",
  both: "comp.wizard.missing.both",
  order: "comp.validation.endsBeforeStarts",
};

export function CompetitionWizard({
  orgSlug,
  orgId,
  publicDashboardUpgrade,
  viewerPlan,
}: {
  orgSlug: string;
  /** The org the description editor uploads images to. */
  orgId: string;
  /**
   * What the next plan up hosts for `dashboard.public.max`, read out of
   * `plan_entitlements` by the Server Component page.
   *
   * REQUIRED, not optional, and passed down rather than derived here: this is a
   * "use client" island with no database in reach, and an optional prop is how
   * the figure quietly stops arriving — the whole class of defect this thread
   * exists to close. `tsc` names every caller instead.
   */
  publicDashboardUpgrade: PublicDashboardUpgrade | null;
  viewerPlan: ViewerPlan;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // PUBLIC BY DEFAULT (entitlements v18 W2 T15/F, owner ruling 2026-09-03). A
  // competition nobody can see does not grow the product, and the organiser who
  // wants private says so. Safe as a default only because the server DEGRADES
  // over the public-dashboard cap instead of refusing — see `degraded` below.
  const [visibility, setVisibility] = useState<string>("public");
  const [discoverable, setDiscoverable] = useState(false);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<{ feature: string; reason?: string } | null>(null);
  // Set when the org asked for a public competition and the server created a
  // private one because its public dashboards are all in use. NOT an error —
  // the competition exists — so it replaces the redirect with a note and a way
  // onward, rather than an error banner over a form that already succeeded.
  // `limit` is the cap the create was refused BY — the server resolved it
  // against this org's own plan and says so on the 201, so the card can name
  // the number instead of gesturing at it.
  const [degraded, setDegraded] = useState<
    { name: string; slug: string; limit: number | null } | null
  >(null);
  // Set when the create succeeded and the competition has no division yet: the
  // form is replaced by "Add your first division".
  const [created, setCreated] = useState<CreatedCompetition | null>(null);
  const [busy, setBusy] = useState(false);

  // Showcase is only real on Public; elsewhere it can never be on. Leaving
  // Public switches it off (consent is given again on the way back).
  const showcaseOn = visibility === "public" && discoverable;
  const blocker = createBlocker({ name, startsOn, endsOn });

  function pickVisibility(next: string) {
    setVisibility(next);
    if (next !== "public") setDiscoverable(false);
  }

  /** Ends follows Starts (see `endsOnAfterStartChange`). */
  function pickStart(next: string) {
    setEndsOn(endsOnAfterStartChange({ prevStart: startsOn, nextStart: next, endsOn }));
    setStartsOn(next);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPaywall(null);
    // The Create button is disabled for each of these, and says why beside it;
    // this is the same answer for a submit that gets past it (Enter in a field).
    // #376: the end date is mandatory server-side, so a missing or backwards
    // one would come back as a bare 400 "Invalid input". Say it in the
    // customer's language, before the round trip. Deliberately NOT the native
    // `required` attribute: that fires the browser's own English tooltip and
    // preempts this message entirely.
    if (blocker === "endsOn" || blocker === "both") {
      setError(msg("comp.wizard.endsOn.required"));
      return;
    }
    if (blocker) {
      setError(msg(BLOCKER_KEY[blocker]));
      return;
    }
    setBusy(true);
    try {
      const made = await apiV1<{
        id: string;
        slug: string;
        visibility: string;
        discoverable: boolean;
        public_quota_degraded?: { feature_key: string; limit: number | null };
      }>("/api/v1/competitions", {
        method: "POST",
        json: {
          name,
          description: description.trim() || null,
          visibility,
          // Same hard coupling as settings (doc 15 §1): showcase only public.
          discoverable: showcaseOn,
          starts_on: startsOn || null,
          ends_on: endsOn,
          // Branding (accent, logo, sponsors) lives in Settings post-create (F7).
          branding: {},
        },
      });
      // The server is the authority on what was actually created, and since T20
      // it SAYS so rather than leaving every consumer to diff the row against
      // its own request. Read off the explicit note, not a re-derivation of it:
      // `made.visibility` is still the truthful value on the resource (and
      // is what a caller ignoring the note reads), but making this component
      // check both would be two guards covering for each other, each untested.
      if (made.public_quota_degraded) {
        setDegraded({
          name: name.trim(),
          slug: made.slug,
          limit: made.public_quota_degraded.limit,
        });
        return;
      }
      setCreated({
        name: name.trim(),
        slug: made.slug,
        // The server's answer, not the request: it is the truthful one.
        visibility: made.visibility,
        discoverable: made.discoverable,
        startsOn,
        endsOn,
      });
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall({
          feature: String(err.extra.feature_key ?? ""),
          reason: typeof err.extra.reason === "string" ? err.extra.reason : undefined,
        });
      } else {
        setError(err instanceof Error ? err.message : msg("comp.wizard.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  // The create SUCCEEDED — this replaces the form rather than sitting under it,
  // because leaving an armed "Create competition" button under a competition
  // that already exists is how the same night gets created twice.
  if (degraded) {
    // BOTH numbers, or as many of them as are true: the cap they hit and what
    // the next plan up hosts. See lib/public-dashboard-upgrade.ts for when the
    // second one is suppressed — a Pro org at Pro's own cap must not read
    // "Pro hosts 10" as an offer.
    const gain = publicDashboardGain(degraded.limit, publicDashboardUpgrade);
    return (
      <div className="card space-y-4 p-6" data-testid="public-quota-degraded">
        <h2 className="text-lg font-semibold text-slate-800">
          {msg("comp.wizard.publicDegraded.title")}
        </h2>
        <p className="text-sm leading-relaxed text-slate-600">
          {msg("comp.wizard.publicDegraded.body", { name: degraded.name })}
        </p>
        {degraded.limit !== null && (
          <p className="text-sm font-medium text-slate-700" data-testid="public-quota-caps">
            {gain !== null && publicDashboardUpgrade
              ? msg("comp.wizard.publicDegraded.caps", {
                  limit: degraded.limit,
                  plan: publicDashboardUpgrade.plan,
                  upgrade: gain,
                })
              : msg("comp.wizard.publicDegraded.capsOwn", { limit: degraded.limit })}
          </p>
        )}
        <UpgradeGate feature={PUBLIC_DASHBOARD_FEATURE} viewerPlan={viewerPlan} />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => router.push(routes.competition(orgSlug, degraded.slug))}
            className="btn btn-primary"
          >
            {msg("comp.wizard.publicDegraded.continue")}
          </button>
        </div>
      </div>
    );
  }

  if (created) return <FirstDivisionPrompt orgSlug={orgSlug} created={created} />;

  return (
    <div className="max-w-2xl">
      <form onSubmit={submit} data-testid="new-competition-form" className="card space-y-5 p-5 sm:p-6">
        <label className="block">
          <span className="label">{msg("comp.wizard.name.label")}</span>
          <input
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={msg("comp.wizard.name.placeholder")}
            className="input min-h-11"
          />
        </label>

        {/* Side by side from 360px; at 320 they stack, because two native date
            inputs at ~124px each clip their own text. `[&_input]:min-h-11` is
            the phone tap floor for the shared date control. */}
        <div className="grid gap-5 min-[360px]:grid-cols-2 [&_input]:min-h-11">
          <DateTimeField
            kind="date"
            label={msg("comp.wizard.startsOn")}
            value={startsOn}
            onChange={pickStart}
          />
          <div>
            {/* #376: mandatory — see submit() for why the message is ours and not
                the browser's native `required` tooltip. `required` here is exactly
                that policy: DateTimeField emits `aria-required` and never the
                native attribute, so the screen-reader signal survives without the
                tooltip that would preempt our localized message. */}
            <DateTimeField
              kind="date"
              label={`${msg("comp.wizard.endsOn")} *`}
              required
              min={startsOn || undefined}
              value={endsOn}
              onChange={setEndsOn}
            />
            {!endsOn && (
              <p className="mt-1 text-xs text-slate-500">{msg("comp.wizard.endsOn.help")}</p>
            )}
          </div>
        </div>

        <div className="space-y-5 border-y border-purple-100 py-5">
          <VisibilitySegmented value={visibility} onChange={pickVisibility} />
          <CompetitionReach visibility={visibility} discoverable={showcaseOn} />
          <div className="border-t border-dashed border-purple-200 pt-4">
            <ShowcaseOptIn visibility={visibility} checked={showcaseOn} onChange={setDiscoverable} />
          </div>
        </div>

        <div>
          <span className="label">{msg("comp.wizard.description.label")}</span>
          {/* The editor competition settings uses after creation: TipTap,
              Markdown in and out, Preview through the public pipeline. 10rem
              minimum (its `min-h-40`), then it grows with the text. */}
          <ProseEditor
            value={description}
            onChange={setDescription}
            orgId={orgId}
            placeholder={msg("comp.wizard.description.placeholder")}
            touch
          />
        </div>

        {paywall && <UpgradeGate feature={paywall.feature} viewerPlan={viewerPlan} />}
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p
            id="create-blocker"
            data-testid="create-blocker"
            aria-live="polite"
            className="min-w-0 flex-1 text-sm text-slate-700 max-sm:text-center"
          >
            {blocker ? msg(BLOCKER_KEY[blocker]) : ""}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
            <button
              type="button"
              onClick={() => router.push(routes.orgHome(orgSlug))}
              className="btn btn-ghost min-h-11"
            >
              {msg("comp.wizard.cancel")}
            </button>
            <button
              type="submit"
              disabled={busy || blocker !== null}
              aria-describedby="create-blocker"
              className="btn btn-primary min-h-11"
            >
              {busy ? msg("comp.wizard.creating") : msg("comp.wizard.create")}
            </button>
          </div>
        </div>
      </form>
      <p className="mt-3.5 px-1 text-[13px] text-slate-600">{msg("comp.wizard.nextNote")}</p>
    </div>
  );
}
