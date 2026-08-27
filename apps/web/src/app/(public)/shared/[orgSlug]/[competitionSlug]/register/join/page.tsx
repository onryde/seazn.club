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
//
// RS007 follow-up: `join_code` is a `generateRefCode()` value (30^6 ≈ 729M,
// lib/ref-code.ts) and this preview renders real roster names — bypassing
// the GET route's own rate limit (above) left this page itself unthrottled,
// a PII enumeration surface over that whole space. Limited HERE, per-IP,
// same bucket key as the sibling route (`regjoinpreview:${ip}`, 5/300s —
// api/v1/.../register/join/route.ts's GET, also spent by join-form.tsx's
// own refreshSlots()) so this page cannot be used to bypass that route's
// own budget. Checked BEFORE the lookup, never after: a throttled visit
// never even runs previewJoinEntry, so its response cannot depend on
// whether join_code is missing, wrong, or genuinely live — a
// distinguishable throttle response would itself be a new oracle.
//
// RS007 review defect #15 (MEDIUM): that byte-identical-to-what requirement
// used to be satisfied by reusing the invalid-link markup verbatim, which
// conflated two different facts — "this link is dead" and "you're going too
// fast" — into one message, so a throttled teammate was told their link had
// expired. Fixed: throttled now renders its OWN designed state (below),
// still computed from `throttled` alone before any lookup, so it keeps the
// oracle-proof property above while finally saying the true, actionable
// thing.
//
// Judgment call on the shared bucket itself (left unchanged): the preview
// GET and refreshSlots() spending the SAME budget is what makes "3 of 5
// gone before a throttled visit even happens" possible on one shared IP
// (venue wifi, CGNAT) — but splitting them would let this page's own
// reloads bypass the sibling route's budget entirely, recreating the exact
// PII-enumeration bypass the per-IP limit above exists to close. Loosening
// the limit to compensate would weaken the same protection from the other
// side. Neither trade is worth taking to fix a wording bug — the throttled
// state above fixes the LIE, not the limit.
import Link from "next/link";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { previewJoinEntry } from "@/server/usecases/registration-submit";
import { HttpError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";
import { JoinForm } from "./join-form";

/** Same extraction the sibling API route's own `clientIp` uses
 *  (register/join/route.ts) and `publicRateLimit` (server/usecases/public.ts)
 *  — kept local rather than shared, since a Server Component reads it off
 *  `headers()` (the Next request-scoped store) instead of a route's own
 *  `Request`. `headers()` throws SYNCHRONOUSLY outside a real request — the
 *  shape of this page called directly in tests (no jsdom; see
 *  resolve-locale.ts's identical guard) — so this falls back to "unknown"
 *  the same way that module does, rather than breaking every existing test
 *  here that renders the page with no join_code at all. */
async function clientIp(): Promise<string> {
  try {
    const h = await headers();
    return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "unknown";
  } catch {
    return "unknown";
  }
}

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
  let throttled = false;
  if (join_code) {
    try {
      await rateLimit(`regjoinpreview:${await clientIp()}`, { max: 5, windowSeconds: 300 });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 429)) throw err;
      throttled = true;
    }
    if (!throttled) {
      try {
        preview = await previewJoinEntry(join_code);
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 404)) throw err;
      }
    }
  }

  // RS007 review defect #15 (MEDIUM): a throttled visit used to fall
  // straight into the `!preview` branch below and render the exact same
  // "This join link isn't valid" copy as a dead code — a teammate who hit
  // the shared per-IP budget (CGNAT/venue wifi, or the picker's own
  // refreshSlots() spending the same bucket) was told their link was dead
  // rather than that they'd tried too many times. This is its OWN designed
  // state now, checked BEFORE `!preview` — but still computed from
  // `throttled` ALONE, decided above before any lookup ever ran, so it
  // stays exactly as oracle-proof as the invalid-link branch: identical
  // output whether join_code is missing, wrong, or a genuinely live code
  // (see "must not become a new oracle" in this page's own test suite).
  if (throttled) {
    return (
      <DictProvider dict={ui} locale={locale}>
        <div className="flex min-h-[60vh] flex-col items-center justify-center bg-canvas px-4 py-16 text-center">
          <div aria-hidden className="mb-6 h-0.5 w-10 bg-accent" />
          <h1 className="font-display text-2xl font-semibold text-ink">{t(ui, "register.join.throttled.heading")}</h1>
          <p className="mt-2 max-w-sm text-sm text-ink-muted">{t(ui, "register.join.throttled.body")}</p>
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
