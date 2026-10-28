// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, raw, call, check, signIn, tag, setStaff, smokeDb, html } from "../harness.ts";

/** One Pro trial per organisation, ever (V277) over real HTTP. `trial_used_at`
 *  means "this org has ALREADY had Pro"; once stamped it is never cleared, so
 *  the downgrade→upgrade loop can't re-arm the 14-day checkout trial.
 *
 *  Pro path: the staff TRIAL-GRANT rail (extendTrial) — it lifts a community
 *  org to Pro, burns the one trial, survives an extension, is refused outright
 *  once Stripe owns the billing timeline, and still lands for a DEPARTED org
 *  whose cancelled subscription id is not liveness.
 *  Free path: the staff COMP rail (compToPro) — the other stamping writer —
 *  plus the surface an owner actually reads: the billing page's upgrade CTA,
 *  which must stop promising a trial the checkout would not grant.
 *
 *  Runs on its own fresh orgs (never touches org/org2) and is keyless-safe:
 *  no arm reaches Stripe — the comp rail has no subscription to update, and
 *  the refusal arm answers BEFORE the Stripe call by design. */
export async function oneTrialSuite(): Promise<void> {
  const staffEmail = `delivered+trial_staff_${tag}@resend.dev`;
  const staff = newSession();
  await signIn(staff, staffEmail);

  interface TrialRow {
    plan_key: string;
    status: string;
    trial_end: Date | null;
    trial_used_at: Date | null;
  }
  /** The columns the one-trial contract is written in, read straight from the
   *  row the usecases write (same ad-hoc client convention as
   *  checkTermsStamp/setStaff). */
  const readSub = async (orgId: string): Promise<TrialRow> => {
    const db = smokeDb();
    try {
      // Reached through organizations.subscription_id — V310 dropped
      // subscriptions.org_id, because many orgs may now share the row.
      const [row] = await db<TrialRow[]>`
        select s.plan_key, s.status, s.trial_end, s.trial_used_at
        from subscriptions s
        join organizations o on o.subscription_id = s.id
        where o.id = ${orgId}`;
      return row;
    } finally {
      await db.end();
    }
  };
  const at = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  /** Age an EXISTING burn so "the first burn survives" is a comparison against a
   *  date no later write could coincidentally reproduce (an org that trialled a
   *  month ago is the real-world state this pins).
   *
   *  `where trial_used_at is not null` is load-bearing: unconditionally writing
   *  the backdated stamp would MANUFACTURE the burn the writer under test was
   *  supposed to make, so a regression that dropped the stamp would still leave
   *  the following check green. This helper may only age a burn, never create
   *  one. */
  const backdateBurn = async (orgId: string): Promise<void> => {
    const db = smokeDb();
    try {
      // Addressed through organizations.subscription_id — V310 dropped
      // subscriptions.org_id. The trial belongs to the GROUP now, which is the
      // point: it is what stops a detach farming a fresh 14 days.
      await db`
        update subscriptions set trial_used_at = now() - interval '30 days'
        where id = (select subscription_id from organizations where id = ${orgId})
          and trial_used_at is not null`;
    } finally {
      await db.end();
    }
  };
  /** Put a Stripe subscription id on the row at the given status. The liveness
   *  rule is BOTH columns (`hasLiveSubscription`: id set AND status in
   *  trialing/active/past_due), so the status argument is what decides whether
   *  the org counts as Stripe-billed — a cancelled sub keeps its id forever and
   *  is NOT live. Used for both arms below: 'active' = live and refused,
   *  'canceled' = departed and still grantable. */
  const seedStripeBilled = async (orgId: string, status: string): Promise<void> => {
    const db = smokeDb();
    try {
      // Through organizations.subscription_id — see backdateBurn.
      await db`
        update subscriptions
        set stripe_subscription_id = ${"sub_smoke_" + orgId.slice(0, 8)}, status = ${status}
        where id = (select subscription_id from organizations where id = ${orgId})`;
    } finally {
      await db.end();
    }
  };

  // === PRO PATH — the staff trial-grant rail ============================
  const pro = newSession();
  const proOrg = (await signIn(pro, `delivered+trial_pro_${tag}@resend.dev`)).org_id;
  // A second pro-path org, used only for the DEPARTED case (an ex-customer that
  // kept its dead subscription id). It needs to be unburned at grant time, so
  // it cannot share proOrg.
  const dep = newSession();
  const depOrg = (await signIn(dep, `delivered+trial_dep_${tag}@resend.dev`)).org_id;

  // === FREE PATH — a fresh community owner ==============================
  const free = newSession();
  const freeOrg = (await signIn(free, `delivered+trial_free_${tag}@resend.dev`)).org_id;
  const freeSlug = ((await call(free, "/api/orgs")) as { id: string; slug: string }[]).find(
    (o) => o.id === freeOrg,
  )!.slug;

  // A community org's upgrade card composes its CTA label as
  // `${startTrial|goPro} — <price>/mo billed yearly`. Match the label as the
  // BUTTON renders it (leading '>'), never the bare dict string: the /o
  // DictProvider serializes the whole `ui` dict into the page's flight payload,
  // so both trial copies — and `upgrade.proCard.cta` = "Go Pro — 14-day free
  // trial" — sit in the body whatever the org's state. Inside that JSON the
  // label is preceded by an escaped quote, so only the rendered <button> text
  // matches here. (The retired "Go Pro Plus — …" could not collide either:
  // '>Go Pro —' needs the dash next.)
  const OFFERS_TRIAL = ">Start free trial —";
  const OFFERS_NO_TRIAL = ">Go Pro —";

  const freshBilling = await html(free, `/o/${freeSlug}/settings/billing`);
  const freshSub = await readSub(freeOrg);
  check(
    "trial/free: a fresh community org is unburned and offered the 14-day trial",
    freshSub.trial_used_at === null &&
      freshBilling.status === 200 &&
      freshBilling.body.includes(OFFERS_TRIAL) &&
      !freshBilling.body.includes(OFFERS_NO_TRIAL),
  );

  await setStaff(staffEmail, "superadmin");
  try {
    // --- Pro path 1: the grant IS free Pro, so it burns the one trial.
    const grant = await raw(staff, `/api/admin/orgs/${proOrg}/grant-trial`, "POST", {
      days: 14,
      reason: "smoke: one trial per org",
    });
    const granted = await readSub(proOrg);
    check(
      "trial/pro: a staff-granted trial lifts the org to Pro and burns its one trial",
      grant.status === 200 &&
        granted.plan_key === "pro" &&
        granted.status === "trialing" &&
        granted.trial_used_at !== null,
    );

    // --- Pro path 2: extensions move trial_end; the BURN is written once.
    await backdateBurn(proOrg);
    const burned = await readSub(proOrg);
    const extend = await raw(staff, `/api/admin/orgs/${proOrg}/grant-trial`, "POST", {
      days: 7,
      reason: "smoke: extension must not re-burn",
    });
    const extended = await readSub(proOrg);
    check(
      "trial/pro: extending the trial moves trial_end but never re-burns trial_used_at",
      extend.status === 200 &&
        at(extended.trial_end) !== at(burned.trial_end) &&
        at(extended.trial_used_at) === at(burned.trial_used_at),
    );

    // --- Pro path 3: once Stripe owns the timeline the grant is refused with a
    // 400, before any write and before any Stripe call.
    //
    // What this proves: the guard fires and the endpoint refuses. It does NOT
    // discriminate the two-column liveness rule on its own — the seed sets id
    // AND a live status together, so a regression branching on the id alone
    // would refuse here too. Pro path 4 below is the case that tells them apart.
    //
    // trial_end is the only row column that can move on a realistic regression
    // here: if the guard stopped recognising this org as live, the non-live arm
    // would run and write trial_end unconditionally. `status` and
    // `trial_used_at` are NOT asserted — neither can move on any single
    // regression (the non-live arm gates status on `stripe_subscription_id is
    // null`, the live arm's pinned UPDATE requires status = 'trialing' while the
    // seed is 'active', and every writer coalesces an already-set trial_used_at)
    // so asserting them would be assertion theatre next to a "row untouched"
    // claim.
    await seedStripeBilled(proOrg, "active");
    const beforeRefusal = await readSub(proOrg);
    const refused = await raw(staff, `/api/admin/orgs/${proOrg}/grant-trial`, "POST", {
      days: 30,
      reason: "smoke: stripe-billed orgs are refused",
    });
    const afterRefusal = await readSub(proOrg);
    check(
      "trial/pro: a Stripe-billed org is refused a staff trial (400) and trial_end never moves",
      refused.status === 400 && at(afterRefusal.trial_end) === at(beforeRefusal.trial_end),
    );

    // --- Pro path 4: the DISCRIMINATING case. A departed org keeps its Stripe
    // subscription id for ever but is not billed by it, so liveness is
    // `id is not null AND status in (trialing, active, past_due)` — 'canceled'
    // fails it. Such an org is still grantable, and the grant still burns its
    // one trial. A blunter guard (`if (stripe_subscription_id)`) would 400 here
    // and leave trial_used_at null; that is what separates it from path 3.
    // The cancelled status must also survive the grant: writing a live-looking
    // status back onto a dead id would send the NEXT grant down the Stripe arm.
    await seedStripeBilled(depOrg, "canceled");
    const beforeDeparted = await readSub(depOrg);
    const departedGrant = await raw(staff, `/api/admin/orgs/${depOrg}/grant-trial`, "POST", {
      days: 14,
      reason: "smoke: a departed org is not Stripe-billed",
    });
    const departed = await readSub(depOrg);
    check(
      "trial/pro: a DEPARTED org (dead sub id, canceled) is still granted a trial, and it burns",
      beforeDeparted.trial_used_at === null &&
        departedGrant.status === 200 &&
        departed.plan_key === "pro" &&
        departed.trial_used_at !== null &&
        departed.status === "canceled",
    );

    // --- Restore trial 1: the sanctioned undo, on the departed org from path
    // 4 above (canceled status, dead id — not live, so the restore is
    // allowed). trial_used_at must actually clear, not just the call 200.
    const beforeRestore = await readSub(depOrg);
    const restore = await raw(staff, `/api/admin/orgs/${depOrg}/restore-trial`, "POST", {
      reason: "smoke: restore trial is the sanctioned one-time undo",
    });
    const restored = await readSub(depOrg);
    check(
      "trial/restore: a departed org's burn is cleared by restoreTrial",
      beforeRestore.trial_used_at !== null &&
        restore.status === 200 &&
        restored.trial_used_at === null,
    );

    // --- Restore trial 2: the DISCRIMINATING refusal. proOrg was made LIVE in
    // Pro path 3 above (id + status 'active') and is still burned — restoring
    // it would just be re-stamped by the next sync, so the usecase refuses
    // with 400 before writing anything. trial_used_at must be UNCHANGED, not
    // merely "still non-null" (which a broken restore that cleared-then-
    // recoalesced could still satisfy).
    const beforeRefuseRestore = await readSub(proOrg);
    const restoreRefused = await raw(staff, `/api/admin/orgs/${proOrg}/restore-trial`, "POST", {
      reason: "smoke: a live org keeps its burn",
    });
    const afterRefuseRestore = await readSub(proOrg);
    check(
      "trial/restore: a LIVE org is refused (400) and its burn is unchanged",
      beforeRefuseRestore.trial_used_at !== null &&
        restoreRefused.status === 400 &&
        at(afterRefuseRestore.trial_used_at) === at(beforeRefuseRestore.trial_used_at),
    );

    // --- Free path 2: the OTHER stamping writer. A comp is free Pro too.
    const comp = await raw(staff, `/api/admin/orgs/${freeOrg}/comp-to-pro`, "POST", {
      until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
      reason: "smoke: a comp burns the trial",
    });
    const comped = await readSub(freeOrg);
    check(
      "trial/free: a staff comp lifts the org to Pro and burns its one trial",
      comp.status === 200 && comped.plan_key === "pro" && comped.trial_used_at !== null,
    );

    // --- Free path 3: back on Community, the burn stands and the upgrade CTA
    // stops promising a second trial. This is the whole product rule, at the
    // surface the owner reads before paying.
    await backdateBurn(freeOrg);
    const burnedFree = await readSub(freeOrg);
    const down = await raw(staff, `/api/admin/orgs/${freeOrg}/downgrade`, "POST", {
      reason: "smoke: downgrade must not re-arm the trial",
    });
    const downgraded = await readSub(freeOrg);
    const returnBilling = await html(free, `/o/${freeSlug}/settings/billing`);
    check(
      "trial/free: downgrading to Community keeps the burn and the CTA offers no second trial",
      down.status === 200 &&
        downgraded.plan_key === "community" &&
        at(downgraded.trial_used_at) === at(burnedFree.trial_used_at) &&
        returnBilling.status === 200 &&
        returnBilling.body.includes(OFFERS_NO_TRIAL) &&
        !returnBilling.body.includes(OFFERS_TRIAL),
    );
  } finally {
    await setStaff(staffEmail, null);
  }
}
