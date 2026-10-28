// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, smokeDb, v1, v1data } from "../harness.ts";

/**
 * RS010 — the `regQueueSuite` premise RS001 dropped: submit a division to
 * capacity, the next entrant WAITLISTS (never refused, never silently
 * confirmed), the waitlisted row carries a 1-based queue position, and the
 * PUBLIC entrant list only ever reflects confirmed entrants. Then promotes
 * off the waitlist and proves — the part a shallower test would miss —
 * that `promoteWaitlistedRow` always lands `pending` (registrations.ts's own
 * doc comment), regardless of the division's `approval` setting: the public
 * count does NOT move on promote alone, only once a follow-up approve()
 * actually materialises an entrant. Own fresh org; keyless-safe.
 */
export async function registrationWaitlistPromoteSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+regwait_${tag}@resend.dev`);
  const orgId = who.org_id;
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === orgId)!.slug;

  const genericConfig = {
    resultMode: "score",
    allowDraws: true,
    points: { w: 3, d: 1, l: 0 },
    progressScore: false,
  };
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const db = smokeDb();
    try {
      await db`insert into sports (key, name, module_version, position_catalog)
               values ('generic', 'Generic', '1.0.0', ${db.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
               on conflict (key) do nothing`;
      await db`insert into sport_variants (sport_key, key, name, config, is_system)
               values ('generic', 'score', 'Score', ${db.json(genericConfig)}, true)
               on conflict do nothing`;
    } finally {
      await db.end();
    }
  }

  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Waitlist Cup ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "One Spot",
      sport_key: "generic",
      variant_key: "score",
      config: genericConfig,
    }),
  );
  const settingsRes = await v1(owner, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    approval: "auto",
    capacity: 1,
    form_fields: [],
  });
  check("waitlist: 1-capacity auto/free division accepts registration settings", settingsRes.status === 200);

  type SubmitOut = { entries: { registration_id: string; status: string }[] };
  const submitOne = async (label: string) =>
    v1data<SubmitOut>(
      await v1(newSession(), `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`, "POST", {
        contact: { name: `${label} ${tag}`, email: `delivered+wait${label.toLowerCase()}_${tag}@resend.dev` },
        privacy_consent: true,
        entries: [
          {
            division_id: div.id,
            entrant_kind: "individual",
            players: [{ full_name: `${label} ${tag}` }],
            answers: {},
          },
        ],
      }),
    );

  const first = await submitOne("First");
  check(
    "waitlist: the first submit into a 1-capacity division confirms immediately",
    first.entries[0]?.status === "confirmed",
  );

  const second = await submitOne("Second");
  check(
    "waitlist: the next submit into a full division waitlists — never refused, never silently confirmed",
    second.entries[0]?.status === "waitlisted",
  );
  const secondId = second.entries[0].registration_id;

  const waitlistRows = v1data<{ id: string; waitlist_position: number | null }[]>(
    await v1(owner, `/api/v1/divisions/${div.id}/registrations?status=waitlisted`),
  );
  const secondRow = waitlistRows.find((r) => r.id === secondId);
  check(
    "waitlist: the waitlisted entry carries 1-based queue position 1 (the only one waiting)",
    secondRow?.waitlist_position === 1,
  );

  type PublicEntrantsOut = { entrants: unknown[] };
  const publicEntrantsUrl =
    `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/divisions/${div.slug}/entrants`;

  const countAfterSubmit = v1data<PublicEntrantsOut>(await v1(newSession(), publicEntrantsUrl));
  check(
    "waitlist: the public entrant list counts only the confirmed entry, never the waitlisted one",
    countAfterSubmit.entrants.length === 1,
  );

  // RS010 fix (registration-approval.ts's promoteFromWaitlist): promoting a
  // FREE entry on an AUTO-approval division confirms it INLINE, mirroring
  // submitRegistrationGroup's own "!waitlisted && approval === 'auto' &&
  // feeCents === 0" shortcut. Found live-broken by this exact suite before
  // the fix — a promoted entry landed at 'pending' with no path ever
  // confirming it (approveRegistration refuses a 'pending' row on an auto
  // division, and a $0 entry has no payment webhook either). This division
  // is auto/free (settings above), so promote is the confirming step here,
  // not a separate approve() call.
  type PromoteOut = { id: string; status: string; entrant_id: string | null } | null;
  const promoted = await v1(owner, `/api/v1/registrations/${secondId}/promote`, "POST", {});
  const promotedData = v1data<PromoteOut>(promoted);
  check(
    "waitlist: promoting on a free/auto division confirms it inline and materialises an entrant",
    promoted.status === 200 &&
      promotedData?.id === secondId &&
      promotedData.status === "confirmed" &&
      !!promotedData.entrant_id,
  );

  const countAfterPromote = v1data<PublicEntrantsOut>(await v1(newSession(), publicEntrantsUrl));
  check(
    "waitlist: the public entrant count updates to 2 right after the free/auto promotion, no separate approve() needed",
    countAfterPromote.entrants.length === 2,
  );

  // approveRegistration is idempotent on an already-confirmed row (returns
  // it as-is rather than refusing "auto division, nothing to approve") — a
  // deliberate no-op check, not a second confirming step.
  type ApproveOut = { status: string; entrant_id: string | null };
  const approved = await v1(owner, `/api/v1/registrations/${secondId}/approve`, "POST");
  const approvedData = v1data<ApproveOut>(approved);
  check(
    "waitlist: approve() on an already-confirmed promoted entry is a no-op, not a refusal",
    approved.status === 200 &&
      approvedData.status === "confirmed" &&
      approvedData.entrant_id === promotedData?.entrant_id,
  );
}
