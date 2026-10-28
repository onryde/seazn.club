// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, checkOutboxRow, smokeDb, v1, v1data } from "../harness.ts";

// ---------------------------------------------------------------------------
// RS010 — registration core-flow smoke, rebuilt against the CURRENT
// group-cart endpoints (RS006/RS007). RS001 (2026-08-17, the schema rebuild)
// deleted the equivalent sections from `regQueueSuite` and `gapSuite` — both
// functions still exist above (search their names) but now cover unrelated
// ground (regQueueSuite: org-currency echo + a stale "registration closed"
// page probe left over from before RS006 shipped a submit endpoint at all;
// gapSuite: device links/lineups). Nothing here resurrects their old code —
// every request below is built fresh against `PublicRegisterGroupRequest`/
// `PublicJoinRequest` (schemas.ts), the group shape, not the deleted flat
// single-entry one. `delivered+selflink_${tag}@resend.dev` was already present,
// orphaned, in cleanup()'s emails array with a #402/gapSuite comment naming
// exactly this suite's shape — reused rather than renamed.
// ---------------------------------------------------------------------------

/**
 * RS010 — open-signup-confirms-an-entrant (gapSuite's dropped premise) vs an
 * approval-required division (organiser must approve() before an entrant
 * exists). Own fresh org; two "individual" divisions in one competition,
 * differing only in `approval`. Keyless-safe (fee_cents 0 throughout).
 */
export async function registrationOpenFlowSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+regopen_${tag}@resend.dev`);
  const orgId = who.org_id;
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === orgId)!.slug;

  // Defensive sports seed (registrationPaidLoopSuite/poolSummarySuite's own
  // fallback): CI runs sync:sports, this only matters for a local DB that
  // hasn't.
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
      name: `Open Flow Cup ${tag}`,
      visibility: "public",
    }),
  );

  type SubmitOut = { group_id: string; entries: { registration_id: string; status: string }[] };

  // --- FREE path: auto approval + zero fee confirms INLINE, no approve() ---
  const freeDiv = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Free Entry",
      sport_key: "generic",
      variant_key: "score",
      config: genericConfig,
    }),
  );
  const freeSettings = await v1(owner, `/api/v1/divisions/${freeDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    approval: "auto",
    form_fields: [],
  });
  check("open flow: free/auto division accepts registration settings", freeSettings.status === 200);

  const freeSubmitted = await v1(
    newSession(),
    `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      contact: { name: `Free Entrant ${tag}`, email: `delivered+openflow_free_${tag}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: freeDiv.id,
          entrant_kind: "individual",
          players: [{ full_name: `Free Entrant ${tag}` }],
          answers: {},
        },
      ],
    },
  );
  const freeOut = v1data<SubmitOut>(freeSubmitted);
  check(
    "open flow: a free auto-approval division confirms the entrant at submit — no approve() needed",
    freeSubmitted.status === 201 && freeOut.entries[0]?.status === "confirmed",
  );

  const freeConfirmedList = v1data<{ id: string; entrant_id: string | null }[]>(
    await v1(owner, `/api/v1/divisions/${freeDiv.id}/registrations?status=confirmed`),
  );
  check(
    "open flow: the auto-confirmed entry materialises a real entrant (entrant_id resolves to a row)",
    freeConfirmedList.some(
      (r) => r.id === freeOut.entries[0].registration_id && !!r.entrant_id,
    ),
  );

  // The submit queued the cart's confirmation on the email outbox, keyed to the cart: one row, its first attempt made, no body kept.
  await checkOutboxRow("registration_confirmation", "registration_group", freeOut.group_id);

  // --- Approval-required path: stays pending until the organiser approves ---
  const manualDiv = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Approval Required",
      sport_key: "generic",
      variant_key: "score",
      config: genericConfig,
    }),
  );
  const manualSettings = await v1(owner, `/api/v1/divisions/${manualDiv.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    approval: "manual",
    form_fields: [],
  });
  check("open flow: manual-approval division accepts registration settings", manualSettings.status === 200);

  const manualSubmitted = await v1(
    newSession(),
    `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      contact: { name: `Manual Entrant ${tag}`, email: `delivered+openflow_manual_${tag}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: manualDiv.id,
          entrant_kind: "individual",
          players: [{ full_name: `Manual Entrant ${tag}` }],
          answers: {},
        },
      ],
    },
  );
  const manualOut = v1data<SubmitOut>(manualSubmitted);
  check(
    "open flow: a manual-approval division leaves the entry pending — no auto-confirm",
    manualSubmitted.status === 201 && manualOut.entries[0]?.status === "pending",
  );

  const manualRegId = manualOut.entries[0].registration_id;
  type ApproveOut = { status: string; entrant_id: string | null };
  const approved = await v1(owner, `/api/v1/registrations/${manualRegId}/approve`, "POST");
  const approvedData = v1data<ApproveOut>(approved);
  check(
    "open flow: organiser approve() confirms a manual-approval entry and materialises an entrant",
    approved.status === 200 && approvedData.status === "confirmed" && !!approvedData.entrant_id,
  );
}
