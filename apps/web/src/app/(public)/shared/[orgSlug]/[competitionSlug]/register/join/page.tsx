export const dynamic = "force-dynamic";
// RS007 — the public JOIN page (design §4 "Join flow", `_INDEX.md` ruling
// 2026-08-27 "join becomes CLAIM-first"). Built to match the link
// register/status/entry-card.tsx (and its own view-model's claimHref) ALREADY
// emits: `/shared/<org>/<comp>/register/join?join_code=<code>[&player_id=<id>]`
// — this route did not exist before, so every registrant's claim link 404'd
// (the critical finding of the adversarial review; see _INDEX.md's REVIEWER
// GAP LIST item 1).
//
// Server component: resolves the join_code via previewJoinEntry (the SAME
// direct-usecase-call convention register/page.tsx and register/status/
// page.tsx already use — this bypasses the GET route's own rate limit
// entirely, exactly as those two pages bypass their own usecases' HTTP
// surface; the GET route exists for the CLIENT island's post-conflict
// refresh, see join-form.tsx), then hands the picker to the client island
// (join-form.tsx) for the interactive part.
import Link from "next/link";
import type { Metadata } from "next";
import { previewJoinEntry } from "@/server/usecases/registration-submit";
import { HttpError } from "@/lib/errors";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";
import { JoinForm } from "./join-form";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
  searchParams: Promise<{ join_code?: string; player_id?: string }>;
};

export default async function RegisterJoinPage({ params, searchParams }: Props) {
  const { orgSlug, competitionSlug } = await params;
  const { join_code, player_id } = await searchParams;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  // A missing join_code is the SAME outcome as previewJoinEntry's own 404 —
  // one designed "not valid" render, not two (matches register/status/
  // page.tsx's own "missing rid/token is the SAME outcome as groupById's
  // 404" convention). Never leaks whether ANY code was ever typed: the
  // unknown-code and dead-code cases inside previewJoinEntry already return
  // the identical 404-shape (its own doc comment), so this branch cannot
  // distinguish "no code" from "wrong code" from "code once existed" either.
  let preview: Awaited<ReturnType<typeof previewJoinEntry>> | null = null;
  if (join_code) {
    try {
      preview = await previewJoinEntry(join_code);
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }

  if (!preview) {
    return (
      <DictProvider dict={ui} locale={locale}>
        <div className="flex min-h-[60vh] flex-col items-center justify-center bg-canvas px-4 py-16 text-center">
          <div aria-hidden className="mb-6 h-0.5 w-10 bg-accent" />
          <h1 className="font-display text-2xl font-semibold text-ink">{t(ui, "register.join.invalid.heading")}</h1>
          <p className="mt-2 max-w-sm text-sm text-ink-muted">{t(ui, "register.join.invalid.body")}</p>
          <Link
            href={`/shared/${orgSlug}/${competitionSlug}`}
            className="mt-6 text-sm font-medium text-accent-strong underline underline-offset-2"
          >
            {t(ui, "register.join.back.cta")}
          </Link>
        </div>
      </DictProvider>
    );
  }

  // A real, live link — but nothing left to do here: every captain-entered
  // slot is already claimed AND the sport's roster cap is already met, so
  // there is no "add someone new" fallback either. Rendered from KNOWN,
  // already-public data (the entry/division names this page's own heading
  // shows), unlike the 404 branch above — no row is inserted, no form shown.
  const rosterFull = preview.unclaimed_slots.length === 0 && !preview.allow_new_player;

  return (
    <DictProvider dict={ui} locale={locale}>
      <div
        // Bottom clearance for the fixed cookie-consent banner — same fix,
        // same measured footprint, as register/status/page.tsx's own
        // wrapper (that page's header has the full measurement comment).
        className="mx-auto max-w-2xl px-4 pt-8 pb-[calc(280px+env(safe-area-inset-bottom))] sm:px-6 sm:pb-[calc(200px+env(safe-area-inset-bottom))]"
      >
        <p className="text-xs text-ink-muted">
          <Link
            href={`/shared/${preview.org_slug}/${preview.competition_slug}`}
            className="hover:text-accent-strong hover:underline"
          >
            {preview.competition_name}
          </Link>
        </p>
        <h1 className="mt-1 font-display text-2xl font-semibold text-ink">
          {t(ui, "register.join.heading", { entry: preview.display_name, division: preview.division_name })}
        </h1>

        {/* RS007/V380 defect #3 — the wizard's custom rule was written and
            shown nowhere. Same organiser-speaking template as the main
            register page's DivisionCard, rendered server-side straight from
            KNOWN, already-public preview data (this page's own header
            comment) — organiser-authored free text, plain TEXT, never
            HTML/markdown. Shown regardless of rosterFull: it is general
            division information, not conditional on there being a slot
            left to claim. */}
        {preview.eligibility_note && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
            {t(ui, "register.organiserNote", { note: preview.eligibility_note })}
          </p>
        )}

        {rosterFull ? (
          <div className="mt-6 rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
            <h2 className="font-display text-lg font-semibold text-ink">{t(ui, "register.join.full.heading")}</h2>
            <p className="mt-2 text-sm text-ink-muted">{t(ui, "register.join.full.body")}</p>
            <Link
              href={`/shared/${preview.org_slug}/${preview.competition_slug}`}
              className="mt-4 inline-block text-sm font-medium text-accent-strong underline underline-offset-2"
            >
              {t(ui, "register.join.back.cta")}
            </Link>
          </div>
        ) : (
          <div className="mt-6">
            <JoinForm
              orgSlug={preview.org_slug}
              competitionSlug={preview.competition_slug}
              joinCode={join_code!}
              displayName={preview.display_name}
              orgName={preview.org_name}
              unclaimedSlots={preview.unclaimed_slots}
              allowNewPlayer={preview.allow_new_player}
              requiresDob={preview.requires_dob}
              requiresGender={preview.requires_gender}
              totalPlayers={preview.total_players}
              initialPlayerId={player_id ?? null}
            />
          </div>
        )}
      </div>
    </DictProvider>
  );
}
