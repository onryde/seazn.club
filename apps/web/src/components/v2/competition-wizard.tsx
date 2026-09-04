"use client";

// Competition wizard (PROMPT-15 task 1): description, visibility, branding.
// POSTs /api/v1/competitions and lands on the competition page to add divisions.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { VisibilityPicker } from "@/components/ui/visibility-picker";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { routes } from "@/lib/routes";
import { useMsg } from "@/components/i18n/dict-provider";


export function CompetitionWizard({ orgSlug }: { orgSlug: string }) {
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
  const [degraded, setDegraded] = useState<{ name: string; slug: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPaywall(null);
    // #376: the end date is mandatory server-side, so a missing or backwards
    // one would come back as a bare 400 "Invalid input". Say it in the
    // customer's language, before the round trip. Deliberately NOT the native
    // `required` attribute: that fires the browser's own English tooltip and
    // preempts this message entirely.
    if (!endsOn) {
      setError(msg("comp.wizard.endsOn.required"));
      return;
    }
    if (startsOn && endsOn < startsOn) {
      setError(msg("comp.validation.endsBeforeStarts"));
      return;
    }
    setBusy(true);
    try {
      const created = await apiV1<{
        id: string;
        slug: string;
        visibility: string;
        public_quota_degraded?: { feature_key: string; limit: number | null };
      }>("/api/v1/competitions", {
        method: "POST",
        json: {
          name,
          description: description.trim() || null,
          visibility,
          // Same hard coupling as settings (doc 15 §1): showcase only public.
          discoverable: visibility === "public" && discoverable,
          starts_on: startsOn || null,
          ends_on: endsOn,
          // Branding (accent, logo, sponsors) lives in Settings post-create (F7).
          branding: {},
        },
      });
      // The server is the authority on what was actually created, and since T20
      // it SAYS so rather than leaving every consumer to diff the row against
      // its own request. Read off the explicit note, not a re-derivation of it:
      // `created.visibility` is still the truthful value on the resource (and
      // is what a caller ignoring the note reads), but making this component
      // check both would be two guards covering for each other, each untested.
      if (created.public_quota_degraded) {
        setDegraded({ name: name.trim(), slug: created.slug });
        return;
      }
      router.push(routes.competition(orgSlug, created.slug));
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
    return (
      <div className="card space-y-4 p-6" data-testid="public-quota-degraded">
        <h2 className="text-lg font-semibold text-slate-800">
          {msg("comp.wizard.publicDegraded.title")}
        </h2>
        <p className="text-sm leading-relaxed text-slate-600">
          {msg("comp.wizard.publicDegraded.body", { name: degraded.name })}
        </p>
        <UpgradeGate feature="dashboard.public.max" />
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

  return (
    <form onSubmit={submit} className="card space-y-5 p-6">
      <label className="block">
        <span className="label">{msg("comp.wizard.name.label")}</span>
        <input
          autoFocus
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={msg("comp.wizard.name.placeholder")}
          className="input"
        />
      </label>

      <label className="block">
        <span className="label">{msg("comp.wizard.description.label")}</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          maxLength={5000}
          placeholder={msg("comp.wizard.description.placeholder")}
          className="textarea"
        />
      </label>

      {/* v3/03 §7: the one visibility component everywhere. No share URL at
          create time (the competition has no public page yet). */}
      <VisibilityPicker value={visibility} onChange={setVisibility} />

      {/* Showcase opt-in (doc 15 §1) — same checkbox + consent copy as
          settings, gated on public visibility. */}
      <fieldset className="space-y-2 rounded-lg border border-purple-100 bg-purple-50/50 p-3">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            disabled={visibility !== "public"}
            checked={discoverable && visibility === "public"}
            onChange={(e) => setDiscoverable(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="text-sm font-semibold text-slate-700">
              {msg("showcase.label")}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-slate-500">
              {msg("showcase.consent")}
            </span>
          </span>
        </label>
        {visibility !== "public" && (
          <p className="text-xs text-amber-600">{msg("showcase.needsPublic")}</p>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <DateTimeField
          kind="date"
          label={msg("comp.wizard.startsOn")}
          value={startsOn}
          onChange={setStartsOn}
        />
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
      </div>

      {paywall && <UpgradeGate feature={paywall.feature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push(routes.orgHome(orgSlug))}
          className="btn btn-ghost"
        >
          {msg("comp.wizard.cancel")}
        </button>
        <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary">
          {busy ? msg("comp.wizard.creating") : msg("comp.wizard.create")}
        </button>
      </div>
    </form>
  );
}
