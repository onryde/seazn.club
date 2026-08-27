import { sql } from "@/lib/db";

/** The latest "Last updated" date across /legal/terms + /legal/privacy — bump
 *  when either text changes, so a consent stamp names the text that was shown.
 *  Also the version stamped for registration_groups.media_consent_version
 *  (registration-submit.ts) — the media-consent checkbox copy
 *  (register.consent.media.label/.hint, step-consent.tsx) links to no
 *  /legal/* page of its own, so it rides this constant instead of a second
 *  one (review ruling, RS006: no concrete reason found for a dedicated
 *  MEDIA_CONSENT_VERSION). Bump it when THAT copy changes too.
 *  (Cookie-banner consent versioning lives separately in consent.ts.)
 *  Pinned to the privacy page's own date by
 *  app/legal/__tests__/privacy-scheduling-note.test.tsx, and to the
 *  media-consent copy by
 *  app/legal/__tests__/media-consent-copy-version.test.ts. */
export const LEGAL_VERSION = "2026-08-04";

/**
 * Record clickwrap acceptance of Terms + Privacy (GDPR spec 2026-07-14): the
 * user acted under a "By continuing, you agree…" notice. First acceptance
 * wins — later logins must not move the timestamp.
 */
export async function stampTermsAcceptance(userId: string): Promise<void> {
  await sql`
    update users set
      terms_accepted_at = coalesce(terms_accepted_at, now()),
      terms_version     = coalesce(terms_version, ${LEGAL_VERSION})
    where id = ${userId}`;
}
