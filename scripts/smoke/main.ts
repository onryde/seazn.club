// scripts/smoke/main.ts — the full smoke run. main() moved here whole from scripts/smoke.ts: its inline checks and its suite calls
// run in the same order as before, each suite imported from scripts/smoke/suites/. index.ts runs it unless SMOKE_ONLY selects a subset.
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  BASE, type Session, newSession, cookieHeader, call, check, suite, expectFail, signIn, tag, checkTermsStamp,
  checkSignInOutbox, checkOutboxRow, grantPass, walletBalance, walletBalanceByWalletId, drainWallet, topUpWallet,
  smokeDb, insertEntitlementOverride, pageRedirect, type V1Res, v1, v1data, setPlan,
} from "./harness.ts";
import { f5RemainderExportLocaleSuite } from "./suites/f5RemainderExportLocale.ts";
import { disputeSurfacesSuite } from "./suites/disputeSurfaces.ts";
import { dataProtectionCopySuite } from "./suites/dataProtectionCopy.ts";
import { personMergeSuite } from "./suites/personMerge.ts";
import { p72Suite } from "./suites/p72.ts";
import { boardRoundCodesSuite } from "./suites/boardRoundCodes.ts";
import { hubKnockoutSuite } from "./suites/hubKnockout.ts";
import { bracketFinishSuite } from "./suites/bracketFinish.ts";
import { walkoverCreditSuite } from "./suites/walkoverCredit.ts";
import { publicQuotaDegradeSuite } from "./suites/publicQuotaDegrade.ts";
import { passGrantsSuite } from "./suites/passGrants.ts";
import { passRungLSuite } from "./suites/passRungL.ts";
import { clubsSuite } from "./suites/clubs.ts";
import { referralSuite } from "./suites/referral.ts";
import { extraOrgAddonSuite } from "./suites/extraOrgAddon.ts";
import { addonChurnWebhookSuite } from "./suites/addonChurnWebhook.ts";
import { outboxTrialWarningSuite } from "./suites/outboxTrialWarning.ts";
import { passLockEnforcementSuite } from "./suites/passLockEnforcement.ts";
import { playerAccountsSuite } from "./suites/playerAccounts.ts";
import { officialOnboardingSuite } from "./suites/officialOnboarding.ts";
import { marksReportsSuite } from "./suites/marksReports.ts";
import { newsSuite } from "./suites/news.ts";
import { sitemapSuite } from "./suites/sitemap.ts";
import { plgGrowthSuite } from "./suites/plgGrowth.ts";
import { v6SportsSuite } from "./suites/v6Sports.ts";
import { matchCentreSmoke } from "./suites/matchCentreSmoke.ts";
import { stageRulesFormatSmoke } from "./suites/stageRulesFormatSmoke.ts";
import { w2cStageRulesSuite } from "./suites/w2cStageRules.ts";
import { w2dTablesSuite } from "./suites/w2dTables.ts";
import { w2eRefusalsSuite } from "./suites/w2eRefusals.ts";
import { w3SwissASuite } from "./suites/w3SwissA.ts";
import { w4aTimeModelSuite } from "./suites/w4aTimeModel.ts";
import { cricketDlsSuite } from "./suites/cricketDls.ts";
import { configSnapshotSuite } from "./suites/configSnapshot.ts";
import { regQueueSuite } from "./suites/regQueue.ts";
import { platformRevenueSuite } from "./suites/platformRevenue.ts";
import { streamCreditsAdminSuite } from "./suites/streamCreditsAdmin.ts";
import { oneTrialSuite } from "./suites/oneTrial.ts";
import { paymentMethodSuite } from "./suites/paymentMethod.ts";
import { divisionSettingsSuite } from "./suites/divisionSettings.ts";
import { scheduleCourtRemovalGuardSuite } from "./suites/scheduleCourtRemovalGuard.ts";
import { capacityPrecheckSuite } from "./suites/capacityPrecheck.ts";
import { templateInstantiationSuite } from "./suites/templateInstantiation.ts";
import { stageProgressionSuite } from "./suites/stageProgression.ts";
import { swissKnockoutSuite } from "./suites/swissKnockout.ts";
import { stageRosterDriftSuite } from "./suites/stageRosterDrift.ts";
import { publicWithdrawnStandingsSuite } from "./suites/publicWithdrawnStandings.ts";
import { publicQualificationStandingsSuite } from "./suites/publicQualificationStandings.ts";
import { entrantRenameSuite } from "./suites/entrantRename.ts";
import { scheduleHealthSuite } from "./suites/scheduleHealth.ts";
import { scheduleRestFloorSuite } from "./suites/scheduleRestFloor.ts";
import { scheduleRoundOrderDeltaGateSuite } from "./suites/scheduleRoundOrderDeltaGate.ts";
import { competitionScheduleApplyRoundOrderSuite } from "./suites/competitionScheduleApplyRoundOrder.ts";
import { registrationPaidLoopSuite } from "./suites/registrationPaidLoop.ts";
import { poolSummarySuite } from "./suites/poolSummary.ts";
import { registrationDuplicatePaymentSuite } from "./suites/registrationDuplicatePayment.ts";
import { registrationRefundReversalSuite } from "./suites/registrationRefundReversal.ts";
import { schedulingConstraintsSuite } from "./suites/schedulingConstraints.ts";
import { autoScheduleSuite } from "./suites/autoSchedule.ts";
import { twoVenueScheduleSuite } from "./suites/twoVenueSchedule.ts";
import { placementOptimizedSuite } from "./suites/placementOptimized.ts";
import { placementPerCourtBlackoutSuite } from "./suites/placementPerCourtBlackout.ts";
import { v4AiSuite } from "./suites/v4Ai.ts";
import { scheduleAiRoundOrderSuite } from "./suites/scheduleAiRoundOrder.ts";
import { jointAiSuite } from "./suites/jointAi.ts";
import { aboveProRungSuite } from "./suites/aboveProRung.ts";
import { pricingV3Suite } from "./suites/pricingV3.ts";
import { i18nSuite } from "./suites/i18n.ts";
import { marketingSuite } from "./suites/marketing.ts";
import { funnelSuite } from "./suites/funnel.ts";
import { funnelReminderSuite } from "./suites/funnelReminder.ts";
import { sponsorsSuite } from "./suites/sponsors.ts";
import { venuesSuite } from "./suites/venues.ts";
import { importCapAtCommitSuite } from "./suites/importCapAtCommit.ts";
import { courtHoursSuite } from "./suites/courtHours.ts";
import { uiSystemSuite } from "./suites/uiSystem.ts";
import { schedRegV3Suite } from "./suites/schedRegV3.ts";
import { boardRedesignSuite } from "./suites/boardRedesign.ts";
import { v1Suite } from "./suites/v1.ts";
import { jul3Suite } from "./suites/jul3.ts";
import { divisionLifecycleSuite } from "./suites/divisionLifecycle.ts";
import { gapSuite } from "./suites/gap.ts";
import { visualSeedRoutesSuite } from "./suites/visualSeedRoutes.ts";
import { streamTargetsSuite } from "./suites/streamTargets.ts";
import { captureV2Suite } from "./suites/captureV2.ts";
import { captureRecordSuite } from "./suites/captureRecord.ts";
import { streamOverlaySuite } from "./suites/streamOverlay.ts";
import { v3ContentApiSuite } from "./suites/v3ContentApi.ts";
import { disciplineSuite } from "./suites/discipline.ts";
import { playerStatsSuite } from "./suites/playerStats.ts";
import { scorePadV2AppendSuite } from "./suites/scorePadV2Append.ts";
import { footballFidelityGateSuite } from "./suites/footballFidelityGate.ts";
import { cricketBothLanesSuite } from "./suites/cricketBothLanes.ts";
import { emailOutboxCronSmoke } from "./suites/emailOutboxCronSmoke.ts";
import { resendWebhookSmoke } from "./suites/resendWebhookSmoke.ts";
import { externalPlayOtBSmoke } from "./suites/externalPlayOtBSmoke.ts";
import { matchRoomSuite } from "./suites/matchRoom.ts";
import { arbiterSuite } from "./suites/arbiter.ts";
import { onlineChessDeskSuite } from "./suites/onlineChessDesk.ts";
import { v13Suite } from "./suites/v13.ts";
import { pagePlayoffSuite } from "./suites/pagePlayoff.ts";
import { qualifyFromAnyStageSuite } from "./suites/qualifyFromAnyStage.ts";
import { eventImportSuite } from "./suites/eventImport.ts";
import { eligibilityGateSuite } from "./suites/eligibilityGate.ts";
import { registrationOpenFlowSuite } from "./suites/registrationOpenFlow.ts";
import { registrationWaitlistPromoteSuite } from "./suites/registrationWaitlistPromote.ts";
import { registrationTeamOpsSuite } from "./suites/registrationTeamOps.ts";
import { registrationSelfLinkAndConsentSuite } from "./suites/registrationSelfLinkAndConsent.ts";
import { youtubeConnectSuite } from "./suites/youtubeConnect.ts";

export async function main() {
  const admin = newSession();

  // --- Auth: passwordless sign-in for a fresh owner (link -> consume) ---
  const ver = await signIn(admin, `delivered+admin_${tag}@resend.dev`);
  check("admin signed in (passwordless)", !!admin.cookies["seazn_session"]);
  // A default org is auto-provisioned on first sign-in (no forced form).
  check("default org auto-provisioned", !!ver.org_id && ver.has_org === true);
  check("active org cookie set", admin.cookies["seazn_org"] === ver.org_id);
  // A brand-new account (no onboarding completed) lands on the first-run wizard.
  check("new user routed to onboarding", ver.redirect === "/onboarding");
  // GDPR (spec 2026-07-14): requesting the magic link under the clickwrap
  // notice stamps terms acceptance on the account.
  await checkTermsStamp(`delivered+admin_${tag}@resend.dev`);
  // Email outbox, phase 1 (Task 6): the same request queued its sign-in email on the outbox.
  await checkSignInOutbox(`delivered+admin_${tag}@resend.dev`);
  const org = { id: ver.org_id };

  // --- Competition lifecycle guards (v2 service layer) ---
  const comp = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Perm Probe ${tag}`,
  });
  check("owner creates competition", comp.status === 201);
  const compId = v1data<{ id: string }>(comp).id;
  // The uncontended case must stay UNSUFFIXED. `withUniqueSlug` retries a
  // generated slug against the unique index, and a retry loop that started at
  // the wrong candidate — or a `taken` predicate that reported a free slug as
  // taken — would ship "-2" on a first-ever create and nothing else would
  // notice: every other check here reads the id, not the URL.
  const compSlug = v1data<{ slug: string }>(comp).slug;
  check(
    `first create keeps the clean slug (got '${compSlug}')`,
    compSlug === `perm-probe-${tag}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  );

  const del = await v1(admin, `/api/v1/competitions/${compId}`, "DELETE");
  check("unscored competition deletable", del.status === 200 || del.status === 204);
  const gone = await v1(admin, `/api/v1/competitions/${compId}`);
  check("deleted competition gone", gone.status === 404);

  // A competition to probe viewer permissions against.
  const probe = await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Viewer Probe ${tag}`,
  });
  const probeId = v1data<{ id: string }>(probe).id;

  // =====================================================================
  // Team management: invites + role enforcement
  // =====================================================================

  // Create a viewer invite and a second user that joins with it.
  const viewerInvite = (await call(admin, `/api/orgs/${org.id}/invites`, "POST", {
    role: "viewer",
    max_uses: 1,
  })) as { token: string };
  check("viewer invite created", !!viewerInvite.token);

  const viewer = newSession();
  const viewerEmail = `delivered+viewer_${tag}@resend.dev`;
  // Requesting a link creates the account but grants no session until consumed.
  const vlink = (await call(viewer, "/api/auth/magic-link", "POST", {
    email: viewerEmail,
  })) as { login_url?: string };
  check("no session before consuming link", !viewer.cookies["seazn_session"]);
  await expectFail("bogus magic token rejected", () =>
    call(newSession(), "/api/auth/magic-link/consume", "POST", {
      token: "not-a-real-token-000000000000",
    }),
  );
  const vtoken = new URL(vlink.login_url ?? "").searchParams.get("token");
  await call(viewer, "/api/auth/magic-link/consume", "POST", { token: vtoken });
  check("session created after consuming link", !!viewer.cookies["seazn_session"]);
  await expectFail("magic link is single-use", () =>
    call(newSession(), "/api/auth/magic-link/consume", "POST", {
      token: vtoken,
    }),
  );

  const accept = (await call(viewer, `/api/invites/${viewerInvite.token}/accept`, "POST")) as {
    role: string;
  };
  check("viewer joined as viewer", accept.role === "viewer");
  check("viewer active org set", viewer.cookies["seazn_org"] === org.id);

  // Viewer can read but cannot write (doc 08 §2: write needs an editor role).
  const viewerRead = await v1(viewer, `/api/v1/competitions/${probeId}`);
  check("viewer can read competitions", viewerRead.status === 200);
  const viewerWrite = await v1(viewer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: "Nope",
  });
  check(
    "viewer cannot create competition",
    viewerWrite.status === 401 || viewerWrite.status === 403,
  );
  const viewerPatch = await v1(viewer, `/api/v1/competitions/${probeId}`, "PATCH", {
    name: "Nope",
  });
  check("viewer cannot edit competition", viewerPatch.status === 401 || viewerPatch.status === 403);
  // The single-use invite is now spent.
  await expectFail("single-use invite is spent", () =>
    call(newSession(), `/api/invites/${viewerInvite.token}/accept`, "POST"),
  );

  // Invite-by-email (team settings): personal invite, single-use forced,
  // address stored; email_sent reports the outcome of the email's first attempt
  // (false with a blank key — the UI then offers the personal link for manual
  // sharing while the outbox keeps the email).
  const emailInvitee = `delivered+emailinvitee_${tag}@resend.dev`;
  const emailInvite = (await call(admin, `/api/orgs/${org.id}/invites`, "POST", {
    role: "viewer",
    email: emailInvitee,
  })) as {
    id: string;
    token: string;
    email: string | null;
    max_uses: number;
    email_sent?: boolean;
  };
  check("email invite stores address", emailInvite.email === emailInvitee);
  check("email invite forced single-use", emailInvite.max_uses === 1);
  check("email invite reports send status", typeof emailInvite.email_sent === "boolean");
  // Email outbox, phase 3 wave 3 (Task 5): the invite email is one `org_invite` row, ref the invite itself (each email invite is its
  // own single-use link), its first attempt made in the request and no body left on it.
  await checkOutboxRow("org_invite", "org_invite", emailInvite.id);
  // Personal: only the invited address may accept — anyone else holding the
  // link (here: the admin who minted it) is turned away with a 403.
  await expectFail("email invite rejects a different account", () =>
    call(admin, `/api/invites/${emailInvite.token}/accept`, "POST", {}),
  );

  // One-click claim (auto-login + join) for a brand-new email invitee: the
  // emailed link proves the inbox, so no separate sign-in round-trip is needed.
  // A fresh session that has never authenticated posts the claim and comes back
  // both signed in and a member.
  const claimer = newSession();
  const claimed = (await call(
    claimer,
    `/api/invites/${emailInvite.token}/claim`,
    "POST",
  )) as { needs_signin?: boolean; role?: string };
  check("email invite claim signs the new invitee in", !!claimer.cookies["seazn_session"]);
  check("email invite claim joins with the invite role", claimed.role === "viewer");
  check("email invite claim sets the active org", claimer.cookies["seazn_org"] === org.id);
  // Single-use: the now-spent invite refuses a second claim.
  await expectFail("email invite claim is single-use", () =>
    call(newSession(), `/api/invites/${emailInvite.token}/claim`, "POST"),
  );
  // The claim just joined the invitee as a real member of `org`, consuming a
  // member seat the rest of this suite budgets for: free-plan members.max is 3
  // (owner + the viewer above + the admin invited below), so leaving the invitee
  // in would 402 that admin's accept on members.max and abort the whole run. The
  // auto-join is already asserted — release the seat so the downstream member
  // arithmetic (and "org has 3 members") is exactly as it was before this block.
  const seatDb = smokeDb();
  try {
    await seatDb`
      delete from org_members
      where org_id = ${org.id}
        and user_id in (select id from users where email = ${emailInvitee})`;
  } finally {
    await seatDb.end();
  }

  // Invite-by-link (team settings): multi-use with a 24-hour expiry — it must
  // outlive the tab that created it and stay listed for later copying.
  const linkInvite = (await call(admin, `/api/orgs/${org.id}/invites`, "POST", {
    role: "viewer",
    max_uses: 0,
    expires_in_days: 1,
  })) as { token: string; expires_at: string | null };
  const linkTtlMs = new Date(linkInvite.expires_at ?? 0).getTime() - Date.now();
  check("link invite lives ~24 hours", linkTtlMs > 0.9 * 864e5 && linkTtlMs < 1.1 * 864e5);
  const teamInvites = (await call(admin, `/api/orgs/${org.id}/invites`)) as {
    token: string;
    email: string | null;
  }[];
  check(
    "team panel lists both pending invites",
    teamInvites.some((i) => i.token === emailInvite.token && i.email === emailInvitee) &&
      teamInvites.some((i) => i.token === linkInvite.token && i.email === null),
  );

  // Admin invite -> a second user joins and CAN create a competition. Retire
  // the viewer probe first: the check is about the ROLE, and the v3 free cap
  // (1 active competition) would 402 the create on quota instead.
  await v1(admin, `/api/v1/competitions/${probeId}`, "PATCH", {
    status: "archived",
  });
  const adminInvite = (await call(admin, `/api/orgs/${org.id}/invites`, "POST", {
    role: "admin",
    max_uses: 0,
  })) as { token: string };
  const member = newSession();
  await signIn(member, `delivered+member_${tag}@resend.dev`);
  await call(member, `/api/invites/${adminInvite.token}/accept`, "POST");
  const memberComp = await v1(member, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Member Made ${tag}`,
  });
  check("invited admin can create competition", memberComp.status === 201);

  // Members listing reflects 3 people (owner + viewer + admin).
  const members = (await call(admin, `/api/orgs/${org.id}/members`)) as {
    role: string;
  }[];
  check("org has 3 members", members.length === 3);
  check("exactly one owner", members.filter((m) => m.role === "owner").length === 1);

  // --- Multi-org quota (doc 13 §5, PROMPT-18): a community owner is capped
  // at one owned org; upgrading the owned org lifts the cap (creation is
  // judged against the creating user's best owned-org plan).
  await expectFail("second org blocked on community (orgs.max_owned)", () =>
    call(admin, "/api/orgs", "POST", { name: `Blocked Org ${tag}` }),
  );
  await setPlan(org.id, "pro", admin);

  // --- Multi-org: a Pro owner may create additional orgs; slug is auto-assigned ---
  const org2 = (await call(admin, "/api/orgs", "POST", {
    name: `Second Org ${tag}`,
  })) as { id: string; slug: string };
  check("can create additional org", !!org2.id);
  check("org slug readable (PROMPT-30)", org2.slug.startsWith("second-org"));
  check("creating org switches active", admin.cookies["seazn_org"] === org2.id);
  const myOrgs = (await call(admin, "/api/orgs")) as { id: string }[];
  check("admin now belongs to 2 orgs", myOrgs.length === 2);
  // Rename the active org; the slug regenerates and the old one redirects
  // (PROMPT-30, v3/01 §2).
  const renamed = (await call(admin, `/api/orgs/${org2.id}`, "PATCH", {
    name: `Renamed Org ${tag}`,
  })) as { name: string; slug: string };
  check("org renamed", renamed.name === `Renamed Org ${tag}`);
  check(
    "rename regenerates slug",
    renamed.slug !== org2.slug && renamed.slug.startsWith("renamed-org"),
  );
  const oldConsole = await pageRedirect(admin, `/o/${org2.slug}`);
  check(
    "old org slug 301s on the console",
    oldConsole.status >= 301 &&
      oldConsole.status <= 308 &&
      (oldConsole.location ?? "").includes(`/o/${renamed.slug}`),
  );

  // --- Billing groups (#212): individual-by-default, sharing is opt-in. Before
  // #212 (V309/V310) a Pro owner's second org was silently dropped onto the
  // payer's EXISTING group and inherited Pro for the $9 tier the moment it was
  // born. That auto-join is GONE: `createOrgForUser` now mints every new org its
  // OWN community group, and joining a payer's group is a deliberate attach.
  //
  // This block proves the whole round trip in the NEW order — born individual,
  // opt-in attached, detached back to individual — because nothing else in smoke
  // would notice if the default regressed. Every other org here has its plan
  // forced by setPlan, so a second org quietly auto-joining (or quietly failing
  // to attach) would still pass every downstream assertion. Step 1 is exactly
  // the #212 regression check the old block was missing: it used to assert org2
  // was Pro straight after creation, which was the auto-join behaviour itself.
  {
    // 1. THE DEFAULT (#212). A brand-new org is born on its OWN community bill,
    // not the payer's Pro group. Its status is 'active' — a community group is a
    // real, active subscription row that simply resolves to the free plan.
    const org2Sub = (await call(admin, `/api/orgs/${org2.id}/subscription`)) as {
      plan_key: string;
      status: string;
    };
    check(
      "billing-group: a brand-new org starts on its own community bill, not the payer's group (#212)",
      org2Sub.plan_key === "community" && org2Sub.status === "active",
    );

    // 2. The payer's group, and proof org2 is on a DIFFERENT one. `GET
    // /api/billing/groups` is payer-gated and lists every group admin pays for,
    // so both the Pro payer group (org) and org2's fresh community group appear
    // here. It is also the only endpoint that returns the internal
    // `subscription_id` the attach below needs — `/api/orgs/[id]/subscription`
    // deliberately does not (it is member-gated and drops the payer's handles).
    // Smoke sets plans by SQL and never calls Stripe, so the payer group carries
    // no live subscription.
    type GroupListing = {
      id: string;
      quantity_paid: number;
      has_live_subscription: boolean;
      orgs: { id: string }[];
    };
    const beforeAttach = (await call(admin, "/api/billing/groups")) as GroupListing[];
    const payerGroup = beforeAttach.find((g) => g.orgs.some((o) => o.id === org.id));
    const org2Group = beforeAttach.find((g) => g.orgs.some((o) => o.id === org2.id));
    check("billing-group: GET /api/billing/groups lists the payer's group", !!payerGroup);
    check(
      "billing-group: the payer's group has no live Stripe subscription in smoke",
      payerGroup?.has_live_subscription === false,
    );
    // The #212 default, at the group level: org2's subscription_id is a group of
    // its own, distinct from the one the payer bills through.
    check(
      "billing-group: a brand-new org is on its own group, distinct from the payer's (#212)",
      !!org2Group && !!payerGroup && org2Group.id !== payerGroup.id,
    );

    // v17 gap #285: the group wallet a joining org leaves behind must not be
    // stranded — its balance has to land in the group's shared wallet, not
    // vanish on a subscription row nothing can resolve to any more.
    // The +7 is a deliberate top-up on TOP of the community grant org2 was
    // born with, so the balance under test is not a round plan number that
    // could coincide with a re-grant: the merge has to carry the org's WHOLE
    // wallet, grant included, not just the part smoke put there.
    await topUpWallet(org2.id, 7);
    const org2OldWalletId = org2Group!.id;
    const org2BalanceBeforeAttach = await walletBalance(org2.id);
    const groupBalanceBeforeAttach = await walletBalance(org.id);
    // Pin the linkage BEFORE the move: org2's balance really does live on the
    // wallet id we are about to assert is emptied. Without this, the post-attach
    // "old wallet holds nothing" check passes for the wrong reasons — a wallet
    // that was always empty, or one whose row was deleted rather than drained.
    check(
      "billing-group: the joining org's balance sits on the old group's wallet before the attach (#285)",
      (await walletBalanceByWalletId(org2OldWalletId)) === org2BalanceBeforeAttach &&
        org2BalanceBeforeAttach > 0,
    );

    // 3. OPT-IN ATTACH. The payer pulls org2 into their Pro group explicitly —
    // the deliberate step that used to happen automatically. No live Stripe
    // subscription here, so nothing is charged: `charged` is always false, and
    // whether a re-add into a freed slot is BILLED only exists on a group with a
    // live subscription — that is the DB-backed unit suite's job
    // (billing-group-move.test.ts), not smoke's. Smoke's job is that the HTTP
    // round trip itself works and actually moves the org.
    const attached = (await call(admin, "/api/billing/group/attach", "POST", {
      org_id: org2.id,
      subscription_id: payerGroup!.id,
    })) as { subscription_id: string; quantity: number; charged: boolean };
    check(
      "billing-group: attach moves the org into the payer's group",
      attached.subscription_id === payerGroup!.id && attached.charged === false,
    );
    check(
      "billing-group: attach merges the joining org's wallet balance into the group's (#285)",
      (await walletBalance(org.id)) ===
        groupBalanceBeforeAttach + org2BalanceBeforeAttach,
    );
    check(
      "billing-group: the joining org's OLD wallet is left holding nothing, not stranded (#285)",
      (await walletBalanceByWalletId(org2OldWalletId)) === 0,
    );

    // 4. ONLY NOW does org2 inherit the group's plan — and through the RESOLVER,
    // not merely the same plan NAME. A per-org plan column set to 'pro' would
    // satisfy the subscription check; only the entitlements resolver proves the
    // org is billing through the group. Quotas stay PER ORG — that headroom is
    // what the extra half-price seat buys, and confusing shared-vs-per-org would
    // make grouping look like a downgrade.
    const attachedSub = (await call(admin, `/api/orgs/${org2.id}/subscription`)) as {
      plan_key: string;
      status: string;
    };
    check(
      "billing-group: an attached org inherits the payer's plan, not community",
      attachedSub.plan_key === "pro" && attachedSub.status === "active",
    );
    const org2Ent = (await call(admin, `/api/orgs/${org2.id}/entitlements`)) as {
      plan_key: string;
      entitlements: Record<string, { enabled?: boolean; limit?: number | null }>;
    };
    check(
      "billing-group: the attached org resolves the group's entitlements",
      org2Ent.plan_key === "pro" && org2Ent.entitlements["exports.branded"]?.enabled === true,
    );
    check(
      // 10, not 15: V393 (entitlements v18) re-cut the seat allowance. The
      // number is a LITERAL on purpose — this reads back through the live API,
      // which reads `plan_entitlements`, so deriving it from that table would
      // make the check a tautology.
      "billing-group: quotas are per org, not shared across the group",
      org2Ent.entitlements["members.max"]?.limit === 10,
    );

    // 5. The listing now shows BOTH orgs on the group, and quantity_paid is
    // untouched (a relationship, not a magic number — see the AGENTS brief). It
    // is only ever written once Stripe confirms the item, and this group has no
    // live subscription, so an attach must leave it exactly where it was rather
    // than inflate it to match the new (larger) org count.
    const afterAttach = (await call(admin, "/api/billing/groups")) as GroupListing[];
    const regrouped = afterAttach.find((g) => g.id === payerGroup!.id);
    check(
      "billing-group: the listing now shows both orgs on the group",
      !!regrouped &&
        regrouped.orgs.some((o) => o.id === org.id) &&
        regrouped.orgs.some((o) => o.id === org2.id),
    );
    check(
      "billing-group: quantity_paid is untouched by an attach with no live subscription",
      regrouped?.quantity_paid === payerGroup!.quantity_paid,
    );

    // 6. DETACH back out, onto a billing group of its own. The old group is
    // still paying for org1, so it must NOT be cancelled. And with no
    // current_period_end and no comped_until on a SQL-set plan there is no
    // paid-through date to inherit, so Community is the only safe landing —
    // detach must never mint a paid plan that nothing can ever expire.
    // `mode: "release"` exercises the removal-mode param end to end; on a group
    // with no live subscription both modes land the org in Community and leave
    // the payer's freed slot reusable, which the re-attach below then proves.
    const detached = (await call(admin, "/api/billing/group/detach", "POST", {
      org_id: org2.id,
      mode: "release",
    })) as { subscription_id: string; cancelled_group: string | null };
    check("billing-group: detach gives the org a group of its own", !!detached.subscription_id);
    check(
      "billing-group: detaching one org leaves the payer's group alive",
      detached.cancelled_group === null,
    );
    const afterDetach = (await call(admin, `/api/orgs/${org2.id}/subscription`)) as {
      plan_key: string;
    };
    check(
      "billing-group: a detached org with no paid-through date lands on community",
      afterDetach.plan_key === "community",
    );

    // 7. FREED-SLOT re-attach idempotency. A detach frees the slot org2 held;
    // the endpoint is idempotent-safe on its cap and ownership checks and must
    // not refuse a repeat move just because the org has already been through
    // this group. No live subscription, so the freed-slot re-add still charges
    // nothing.
    const reAttached = (await call(admin, "/api/billing/group/attach", "POST", {
      org_id: org2.id,
      subscription_id: payerGroup!.id,
    })) as { subscription_id: string; quantity: number; charged: boolean };
    check(
      "billing-group: re-attaching a previously-detached org succeeds again",
      reAttached.subscription_id === payerGroup!.id,
    );
    check(
      "billing-group: the freed slot re-attach charges nothing (no live subscription)",
      reAttached.charged === false,
    );
    const backOnGroup = (await call(admin, "/api/billing/groups")) as GroupListing[];
    const regrouped2 = backOnGroup.find((g) => g.id === payerGroup!.id);
    check(
      "billing-group: the re-attached org is back on the payer's group",
      !!regrouped2 && regrouped2.orgs.some((o) => o.id === org2.id),
    );

    // Restore the invariant everything below this point depends on: org2 back on
    // a plain Community group of its own, exactly where the FIRST detach left it.
    // Every suite AFTER this block runs org2 as the FREE org — the v1 API 402
    // gate, the community theme checks, the division cap, the 'Powered by'
    // attribution — right up until the explicit setPlan(org2, "pro") further down
    // promotes it for jul3Suite onward. Leaving it attached would turn eight
    // paid-vs-free checks into assertions that silently prove nothing.
    const finalDetach = (await call(admin, "/api/billing/group/detach", "POST", {
      org_id: org2.id,
    })) as { subscription_id: string; cancelled_group: string | null };
    check(
      "billing-group: detaching again still leaves the payer's group alive",
      finalDetach.cancelled_group === null,
    );
    check(
      "billing-group: the round trip leaves org2 detached again for the suites below",
      !!finalDetach.subscription_id,
    );
    const finalOrg2Sub = (await call(admin, `/api/orgs/${org2.id}/subscription`)) as {
      plan_key: string;
    };
    check(
      "billing-group: org2 is back on community after the round trip",
      finalOrg2Sub.plan_key === "community",
    );
  }

  // --- CRON: the daily quantity reconcile (spec 2026-07-21 §Operations). Stripe
  // cuts every renewal invoice from the subscription item's own quantity and
  // reads nothing of ours at cycle time, so a drift nothing corrects bills wrong
  // for ever. Same secret gate as /api/cron/billing-events.
  {
    const wrongQty = await fetch(`${BASE}/api/cron/billing-quantity`, {
      method: "POST",
      headers: { "x-cron-secret": "definitely-wrong" },
    });
    check(
      "billing-group: cron billing-quantity rejects a wrong secret (401, or 503 unconfigured)",
      wrongQty.status === 401 || wrongQty.status === 503,
    );
    const qtySecret = process.env.CRON_SECRET;
    if (qtySecret) {
      const rightQty = await fetch(`${BASE}/api/cron/billing-quantity`, {
        method: "POST",
        headers: { "x-cron-secret": qtySecret },
      });
      const body = (await rightQty.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: { checked?: number; corrected?: number; failed?: number };
      };
      // No group here has a Stripe subscription (smoke sets plans by SQL), so
      // the sweep must find nothing to correct and nothing to fail. A non-zero
      // `failed` means it reached Stripe, which it should never do from smoke.
      check(
        "billing-group: cron billing-quantity sweeps and corrects nothing",
        rightQty.status === 200 &&
          body.ok === true &&
          body.data?.corrected === 0 &&
          body.data?.failed === 0,
      );
    }
  }

  // --- User timezone preference (spec 2026-07-14) — account-level, all plans ---
  {
    const saved = (await call(admin, "/api/users/me", "PATCH", {
      timezone: "Asia/Kolkata",
    })) as { timezone: string | null };
    check("pro: timezone saved", saved.timezone === "Asia/Kolkata");
    const cleared = (await call(admin, "/api/users/me", "PATCH", {
      timezone: null,
    })) as { timezone: string | null };
    check("pro: timezone clears to browser default", cleared.timezone === null);
    await expectFail("bogus timezone rejected", () =>
      call(admin, "/api/users/me", "PATCH", { timezone: "Mars/Phobos" }),
    );
    // The picker only ever writes canonical spellings now (lib/tz-data.ts
    // TZ_ALIAS), but rows written before it existed hold legacy ones — the API
    // must keep accepting them or those accounts break on their next save.
    const legacy = (await call(admin, "/api/users/me", "PATCH", {
      timezone: "Asia/Calcutta",
    })) as { timezone: string | null };
    check("pro: legacy zone spelling still accepted", legacy.timezone === "Asia/Calcutta");
    await call(admin, "/api/users/me", "PATCH", { timezone: null });
    // Free path: the viewer session is plan-agnostic for account settings.
    const vSaved = (await call(viewer, "/api/users/me", "PATCH", {
      timezone: "Europe/London",
    })) as { timezone: string | null };
    check("free: timezone saved", vSaved.timezone === "Europe/London");
    await call(viewer, "/api/users/me", "PATCH", { timezone: null });
  }

  // --- HEADROOM: org2's public dashboards --------------------------------
  // V396 retired Pro's "unlimited public dashboards" and made the cap a finite
  // `dashboard.public.max` = 10, and (T15/F) a create past it is no longer
  // refused — it silently comes back PRIVATE. org2 is the shared Pro org that
  // ~30 suites below run against, and between them they create far more than
  // ten public competitions; a real Pro club would not. Once the cap was met,
  // every later "public" competition landed private, `public_fixtures_v`
  // (`visibility = any('{public,unlisted}')`) stopped returning it, and NINE
  // checks failed at the far end of the run — the news feed, the post page,
  // the story PNG, the v3 public page and CTA, the QR poster, the embed and
  // the sponsor strip.
  //
  // The cap is not the thing under test in any of those, so the harness org
  // gets the headroom its scenario needs rather than the assertions being
  // rewritten to accept a degraded page. The degrade ITSELF is asserted on its
  // own fresh community org, at its own plan's cap, by
  // `publicQuotaDegradeSuite` below — the product behaviour is pinned, this
  // override just stops it firing where it is incidental.
  await insertEntitlementOverride(admin, org2.id, "dashboard.public.max", 100);

  // --- Platform API /api/v1 (PROMPT-11) — the full engine v2 lifecycle ---
  await suite("v1", () => v1Suite(admin, org2.id, renamed.slug));

  // --- Jul3 feature wave (PROMPT-21..28) over real HTTP ---
  // The advanced features are entitlement-gated — org2 must be Pro (and it
  // needs headroom past competitions.max_active for the extra competitions).
  // Since V310 org2 is already Pro through the group it was created into, and
  // the assertions above prove it. Kept anyway, deliberately: setPlan reprices
  // the GROUP, so this is a no-op that documents the requirement rather than a
  // second source of truth for it. If it ever starts mattering again, the
  // billing-group checks above have regressed first.
  await setPlan(org2.id, "pro", admin);
  await suite("jul3", () => jul3Suite(admin, org2.id, renamed.slug));

  // --- Division delete/archive lifecycle (PROMPT-38, v3/09 §4): delete on a
  // free org lifts the divisions quota; archive/restore on the Pro org.
  await suite("divisionLifecycle", () => divisionLifecycleSuite(admin, org2.id));

  // --- v3 UI system (PROMPT-32): card grid render + visibility flip on both
  // plans — pro on org2, free on a fresh community owner.
  await suite("uiSystem", () => uiSystemSuite(admin, renamed.slug));

  // --- v3 scheduling board + registration v2 (PROMPT-33/34): board render,
  // seq-tokened reschedule + stale 409, SZ refs + /r/[ref] on pro AND free.
  await suite("schedRegV3", () => schedRegV3Suite(admin, renamed.slug, org2.id));

  // --- Board redesign (2026-08-10): legend duplicated below the grid, and
  // blackout windows highlighted on the grid (own tiny rig, see the suite
  // function below).
  await suite("boardRedesign", () => boardRedesignSuite(admin, renamed.slug));

  // --- #452 scheduling CONSTRAINT surface: a durable `constraints.hard` rule
  // on a real bracket and a pool-targeted `restByGroup` on a `group` stage,
  // asserted on auto / apply / board report / drag. Keyless (no model), own Pro
  // org, so it runs on every smoke invocation.
  await suite("schedulingConstraints", () => schedulingConstraintsSuite());

  // --- T14 auto-schedule: all three solver modes (build / re-flow / polish)
  // against a real division, asserting the returned telemetry. The load-bearing
  // one is `solver.engine`: it is the only field that distinguishes a solved
  // run from the greedy fallback the server takes when the placement service
  // is unreachable, and no unit test can see that difference.
  // Keyless, own Pro org, so it runs on every smoke invocation.
  await suite("autoSchedule", () => autoScheduleSuite());

  // --- P9 pass 5: a full schedule round on an org with TWO VENUES, not one
  // venue with two courts (the shape every other court-seeding suite in this
  // file, autoScheduleSuite included, already uses). Asserts the build
  // actually resolved courts across both venues, not just placed on two
  // courts that happened to share one. Keyless, own Pro org.
  await suite("twoVenueSchedule", () => twoVenueScheduleSuite());

  // --- Task 11 placement cutover: a board sized so beating greedy is not
  // just possible but REQUIRED — the scenario the four-value engine
  // allow-list above cannot be. Self-gates on PLACEMENT_SERVICE_HOST and
  // skips loudly when the service is unreachable (see its own docblock).
  await suite("placementOptimized", () => placementOptimizedSuite());

  // --- Task C2: the per-court-grid capability gap. Before C2 a court-scoped
  // blackout left the configured courts offering different start-time
  // grids, which `build.ts`'s `everyCourtSharesGrid` refused outright
  // (`not_searched`/`per_court_grid`) rather than send to placement — the
  // optimiser was switched off for the division, permanently, for as long
  // as the blackout stood. Same self-gate as the suite above.
  await suite("placementPerCourtBlackout", () => placementPerCourtBlackoutSuite());

  // --- v10 sponsor CRM: tiers + placement + tracked clicks + Connect rail
  // on the pro org; flat free strip + 402 gates on a fresh community owner.
  await suite("sponsors", () => sponsorsSuite(admin, org2.id, renamed.slug));

  // --- D5/P8 venues & courts: CRUD + calendar PUT on the pro org, plus the
  // VENUE_NOT_EMPTY and (DB-gated) COURT_IN_USE 409s.
  await suite("venues", () => venuesSuite(admin, org2.id));

  // --- P9.5 (D5b.5): court_hours/court_exceptions actually GOVERN
  // scheduling now, through the one function every side reads through
  // (packages/engine/src/scheduling/court-windows.ts's usableWindows) — the
  // candidate lattice, the greedy placer and validateAssignments all agree.
  // Own fresh Pro org, keyless, no PLACEMENT_SERVICE_HOST gate: every claim
  // here is about the shared usableWindows gate itself, which the GREEDY
  // fallback already exercises (unlike the placement-cutover suites above,
  // which exist specifically to prove the optimizer beats greedy).
  await suite("courtHours", () => courtHoursSuite());

  // Own fresh org, and it CHANGES PLAN mid-suite — hence its own, rather than
  // riding boardRedesignSuite's import checks, which must stay on Pro.
  await suite("importCapAtCommit", () => importCapAtCommitSuite());

  // --- v13 real-competition fidelity: badge + inline members, ad-hoc match,
  // knockout draw guard, bracket poster, signed audit (pro 200 / free 402),
  // public presentation mode.
  await suite("v13", () => v13Suite(admin, org2.id, renamed.slug));

  // --- v4 AI Schedule Architect (Task 18): two-phase happy path on a fresh Pro
  // Plus org (schedule ai-plan → apply+ledger → ai-last → officials draft) plus
  // the AI credit wallet 402 and a wallet top-up lift on a fresh community org
  // (v17 Phase 2, V320+ — replaced the old graded per-division run cap).
  // The T17 fixture server stands in for the model (needs the server booted with
  // SCHEDULING_AI_BASE_URL); the wallet 402 is keyless-safe and always runs.
  await suite("v4Ai", () => v4AiSuite(admin, org2.id, renamed.slug));

  // --- C1 gap B: the AI planning path's round-order blind spot, over real
  // HTTP (own fresh paid session — not an entitlement gate). Needs the
  // same T17 fixture server as v4AiSuite; skips the same way when
  // SCHEDULING_AI_BASE_URL is unset.
  await suite("scheduleAiRoundOrder", () => scheduleAiRoundOrderSuite());

  // --- #350 multi-division JOINT AI scheduling: the batch-discount price
  // (rungs 2+3 → 4 credits, budget sized from the undiscounted 5) and the
  // atomic apply on a fresh Pro org, plus the two refusals that must
  // happen before any model call — a one-division request (400) and a wallet
  // that cannot cover the quote (402). The refusals are keyless-safe; the
  // priced run needs the T17 fixture server.
  await suite("jointAi", () => jointAiSuite());

  await suite("pagePlayoff", () => pagePlayoffSuite(admin));
  await suite("qualifyFromAnyStage", () => qualifyFromAnyStageSuite(admin));

  // --- v16 SPEC-1 discipline: 5-yellow auto ban → confirm → public strip on
  // the Pro org; 402 + PlusReveal on a fresh community owner.
  await suite("discipline", () => disciplineSuite(admin, org2.id, renamed.slug));

  // --- S8/#417 W6: per-sport player stats over real HTTP — an explicit
  // scorer (football.goal) and the v1-era entrant-only fallback
  // (badminton.rally's wonBy alone), each asserted on real numbers out of
  // /api/v1/divisions/{id}/stats/players. Own fresh competitions on org2
  // (already Pro); keyless-safe.
  await suite("playerStats", () => playerStatsSuite(admin, org2.id));

  // --- S13/W11: the v2 ScorePad's append path (transport.ts/
  // use-pad-pipeline.ts) had ZERO real-HTTP smoke coverage — closes the
  // debt S1/S3-S8/S10/S11 all deferred. Scores a one-shot generic.result to
  // DECIDED on org2 (Pro) AND a fresh free org, PLUS a 4-event football
  // sequence on org2 (core.start -> goal -> HT -> FT) asserting the fold
  // advances after every append, not just the first — the S12/#421 shape a
  // one-event smoke cannot see. Own fresh competitions on org2 (already
  // Pro); the free half mints its own community org — keyless-safe, no
  // entitlement grant.
  await suite("scorePadV2Append", () => scorePadV2AppendSuite(admin, org2.id));

  // --- R8 sweep task G, inverted by W1 (entitlements v18): a football.shot
  // band-3 action reachable on org2 (Pro) and EQUALLY reachable on a fresh
  // community org — recording detail is not a plan boundary any more — with a
  // band-0 control proving the free org isn't just blanket-accepted. ---
  await suite("footballFidelityGate", () => footballFidelityGateSuite(admin, org2.id));

  // --- R8 sweep, task G: cricket's ball-by-ball and over-by-over lanes,
  // driven with the v3 pad's own payload shapes, on two fixtures (the lanes
  // lock per innings on whichever event opens it) — plus the cross-lane
  // refusal in both directions, proving the exclusion rather than just
  // asserting each lane in isolation. ---
  await suite("cricketBothLanes", () => cricketBothLanesSuite(admin, org2.id));

  // --- v16 SPEC-3 marks & reports: rate an accepted, decided official (Pro
  // 204 + summary avg) and file/submit a report (free) on org2; mark PUT 402
  // on a fresh community org while the report still files. Runs while org2 is
  // still Pro (the destructive downgrade is gapSuite, last).
  await suite("marksReports", () => marksReportsSuite(admin, org2.id, renamed.slug));

  // --- v16 SPEC-2 news: opt-in division auto-drafts a result on the decided
  // seam → publish → public feed/post/story.png on the Pro org; manual post
  // publishes free on a fresh community org, whose auto toggle is gated 402.
  await suite("news", () => newsSuite(admin, org2.id, renamed.slug));

  // --- v3 content + API wave (PROMPT-35/37/39): markdown editor render,
  // /help + /developers, scoped keys, OG/poster/embed/sponsors — pro + free.
  await suite("v3ContentApi", () => v3ContentApiSuite(admin, org2.id, renamed.slug));

  // --- streaming T1: the routes the visual gate photographs still answer
  // with the markup its manifest awaits (`[data-testid=mc-score-0]` and
  // `table`; the suite's own JSDoc says why a heading probe is unsafe — the
  // branded 404 renders an `<h1>` in the same `<main>`). Same pro org — the
  // embed widget 404s below Pro.
  await suite("visualSeedRoutes", () => visualSeedRoutesSuite(admin, renamed.slug));

  // --- stream overlay W1 (Task 8): the overlay route over real HTTP, and the
  // manifest's own `stream-overlay` group's counterpart. Its own fresh orgs —
  // since V426 every plan grants `streaming.overlay`, so the gate's negative is
  // an org-WIDE override-false row, and writing it on the shared Pro org would
  // take the OBS panel off every fixtures tab this file asserts on.
  await suite("streamOverlay", () => streamOverlaySuite());

  // --- fixture-page stream T2b: streaming destinations over real HTTP — add, rename, replace key, remove (an archive),
  // remove again (404), re-add the same key (restored: the same id). On the shared Pro org; archives all it creates.
  await suite("streamTargets", () => streamTargetsSuite(admin, org2.id));
  // --- capture QR v2 (spec 2026-10-01 §11.1.6): the phone routes end to end — mint, claim, Go live, go-live, the
  //     descriptor's cred (and none for a second phone), the fake connect, live, Stop, over; every answer private.
  await suite("captureV2", () => captureV2Suite());
  // --- capture record upload (spec 2026-10-12 §13.2, case `capture-record`): a phone's Send record over the real route —
  //     another code's line and a bad line dropped (owner ruling RL), the body-level refusals, every answer private.
  await suite("captureRecord", () => captureRecordSuite());

  // --- the above-Pro rung (Task 11): community's save-point window and its
  // ungated officials, api.write re-armed above Pro, and the rung above Pro
  // lifting the window and minting the key — own fresh org, restores its own
  // plan before returning (shared-DB poison trap).
  await suite("aboveProRung", () => aboveProRungSuite());

  // --- PROMPT-36 pricing v3: free caps, Event Pass lift + scope isolation,
  // pro interplay, pass survival after downgrade — and the /start funnel
  // end-to-end (draft → claim link → inside the created competition).
  await suite("pricingV3", () => pricingV3Suite());
  await suite("funnel", () => funnelSuite());
  // Email outbox, phase 3 wave 5 (Task 8): a day-old unclaimed draft gets ONE
  // queued funnel_reminder from the real cron route, and a second run none.
  // No session; needs CRON_SECRET and skips cleanly without it.
  await suite("funnelReminder", () => funnelReminderSuite());

  // --- PROMPT-40 marketing redesign (design/v3/12).
  await suite("marketing", () => marketingSuite());

  // --- v5 i18n: marketing [lang] routing + translated copy.
  await suite("i18n", () => i18nSuite());

  // --- Growth-wave gaps (device links, official scoring, discovery, registration,
  // ownership transfer, downgrade freeze) — pro paths on org2, free paths on a
  // fresh community owner. Destructive downgrade runs last.
  // --- v8: division settings — format lock + logo upload URL.
  await suite("divisionSettings", () => divisionSettingsSuite(admin));

  // --- F5 test debt Task 4 (F1's owed check, 2026-08-17 design §5): the
  // bracket round-role columns (lane/is_final/third_place, V368) and the bye
  // slot label, proven over real HTTP. Own fresh session — not an
  // entitlement gate. Deliberately NOT called from inside the `aiConfigured`
  // block seedBracketAiDivision's own AI-plan callers live in (~line 10333):
  // that block's checks skip outright when SCHEDULING_AI_BASE_URL is unset,
  // and this check asserts nothing AI-related, so gating it there would make
  // it skip for the same reason #452's schedulingConstraintsSuite
  // deliberately did NOT hang off that seed either.
  {
    const roundRole = newSession();
    await signIn(roundRole, `delivered+smoke-roundrole-${tag}@resend.dev`);
    await smokeBracketRoundRoleAndByes(roundRole);
  }

  // --- Date/time UX programme, Prompt 09: the court-removal guard added in
  // P08 (own fresh free session — not an entitlement gate).
  await suite("scheduleCourtRemovalGuard", () => scheduleCourtRemovalGuardSuite());

  // --- Date/time UX programme, Prompt 09 follow-up: the minimum-rest floor
  // (`restFloor`, #459) — perEntrantMinRest vs constraints.restMin
  // disagreeing resolves to the MAX over a real PUT/GET round trip, both
  // directions (own fresh free session — not an entitlement gate).
  await suite("scheduleRestFloor", () => scheduleRestFloorSuite());

  // --- P1/D2: capacity pre-check — server is the authority, not just the
  // UI's client-side recompute (own fresh free session — not an entitlement
  // gate).
  await suite("capacityPrecheck", () => capacityPrecheckSuite());

  // --- P4/D1a: format templates — instantiate one through the real route,
  // confirm normal flow continues on it, and the entitlement gate holds
  // through the route (own fresh free session — not an entitlement gate).
  await suite("templateInstantiation", () => templateInstantiationSuite());

  // --- P2/D3: schedule health — the real route, refusal before apply,
  // homeAwayAlternation actually present for a table-shaped stage (own
  // fresh free session — not an entitlement gate).
  await suite("scheduleHealth", () => scheduleHealthSuite());

  // --- D4a/P5: stage progression — seed -> complete -> propose -> confirm ->
  // next stage playable (own fresh free session — not an entitlement gate).
  await suite("stageProgression", () => stageProgressionSuite());

  // --- Swiss Knockout: a COMMUNITY org builds the composite through the real
  // route (the live plan matrix, not the gate function), and a Top 3 lands as
  // a one-bye bracket of four.
  await suite("swissKnockout", () => swissKnockoutSuite());

  // --- F3 Task 5: roster-drift rebuild — withdraw pre-start, rebuild drops
  // the stale name and picks up a late registration; a separate division
  // proves the 409 refusal once a fixture already has a result (own fresh
  // free session — not an entitlement gate).
  await suite("stageRosterDrift", () => stageRosterDriftSuite());

  // --- F10 (Swiss withdrawal walkthrough, 2026-09-21): the PUBLIC standings
  // table names a withdrawn entrant rather than printing her raw entrant id.
  // V412 widened `public_entrants_v` to publish departed entrants; this is the
  // view, the page and the table's `?? row.entrantId` fall-through proved
  // together over real HTTP (own fresh free session — not an entitlement gate).
  await suite("publicWithdrawnStandings", () => publicWithdrawnStandingsSuite());

  // --- 2026-09-22 standings qualification status: the public division page
  // marks each row's status, draws the cut line after place N and keys the
  // markers in a legend; a league with no next stage draws none of it (V414's
  // meta read, the snapshot, the builder and the table's prop, over real HTTP;
  // own fresh free session — not an entitlement gate).
  await suite("publicQualificationStandings", () => publicQualificationStandingsSuite());

  // --- 2026-09-22 (production: "Sankar & Ritwik" outlived Ritwik): a roster
  // swap renames a pair whose name its people derived, never a custom one, and
  // the public division page shows the rename on the very next load — the
  // entrant PATCH now expires the division's public tag (own fresh free
  // session — not an entitlement gate).
  await suite("entrantRename", () => entrantRenameSuite());

  // --- C1 fix-loop (G2/3rd instance): the drag path's round-robin delta-gate
  // blind spot, over real HTTP — a round-order violation against an
  // untouched sibling 409s, writes nothing, and an identically-shaped legal
  // move still succeeds (own fresh free session — not an entitlement gate).
  await suite("scheduleRoundOrderDeltaGate", () => scheduleRoundOrderDeltaGateSuite());

  // --- C1 gap A: the JOINT multi-division apply's own round-order wiring,
  // over real HTTP (own fresh pro session, for scheduling.multi_division).
  await suite("competitionScheduleApplyRoundOrder", () => competitionScheduleApplyRoundOrderSuite());

  // --- design/v6 PROMPT-48..50: tennis rally set (nested kernel), icehockey
  // OT points in standings, PP goal + release with the public strength chip.
  // Before gapSuite — needs the org's pro entitlements for tier-3 scoring.
  await suite("v6Sports", () => v6SportsSuite(admin));

  // --- W4a (#425): the core time model over HTTP — icehockey penalty expiry
  // and the cross-period carry, football sin bins + Law 3 sub windows, ITTF
  // expedite, tennis Rule 30 interruptions, and the Pro gate on all four.
  // After v6SportsSuite (it seeds tennis/icehockey), before gapSuite (its
  // downgrade ends the org's pro entitlements, which Tier-2 scoring needs).
  await suite("w4aTimeModel", () => w4aTimeModelSuite(admin));

  // --- #451: DLS converts a division's own overs/wickets onto the published
  // table's fixed 6-ball/10-wicket scales. Its own Pro org (smoke's shared org
  // is community, and a DLS target needs `cricket.dls`), so placement is free.
  await suite("cricketDls", () => cricketDlsSuite());

  // --- W4a follow-up (V347): the cfg a fixture is scored under is frozen on
  // its first event, so a later division-config edit can neither lock the
  // scorer out nor rewrite a published result — plus /admin's audited escape
  // hatch. Right after w4aTimeModelSuite (same class of defect), before
  // gapSuite's destructive downgrade.
  await suite("configSnapshot", () => configSnapshotSuite(admin, `delivered+admin_${tag}@resend.dev`));

  // --- design/v7 PROMPT-52: waitlist queue position + public count. RS001
  // deleted the public submit endpoint this used to drive; what remains
  // checks registration-settings PUT and the register page's closed state.
  // Before gapSuite — its destructive downgrade ends the org's pro quota.
  await suite("regQueue", () => regQueueSuite(admin));

  // --- PROMPT-53: player accounts — claim → RSVP → grid → QR check-in.
  // BEFORE gapSuite: its downgrade eats org2's competition headroom.
  await suite("playerAccounts", () => playerAccountsSuite(admin, org2.id));
  await suite("officialOnboarding", () => officialOnboardingSuite(admin, org2.id, renamed.slug));

  // --- PLG growth loops (design/plg): attribution CTA + fan ShareBar on
  // free AND pro public pages, /me player→organiser nudge, /discover /start.
  await suite("plgGrowth", () => plgGrowthSuite(admin, org2.id, renamed.slug));

  // --- sitemap.xml lists a published public competition (fix 2026-09-27:
  // the route was prerendered at a DB-less build). Own fresh org; keyless.
  await suite("sitemap", () => sitemapSuite());

  // --- design/v9 PROMPT-55: dispute-loss recovery surfaces.
  await suite("disputeSurfaces", () => disputeSurfacesSuite());

  // --- #403: the data-protection disclosures that must be LIVE, not merely
  // written. Keyless-safe, no org, no AI spend.
  await suite("dataProtectionCopy", () => dataProtectionCopySuite());

  // --- #404: the duplicate review queue and the reversible, ban-preserving
  // merge behind it. Its own fresh Pro org; keyless-safe, no AI spend.
  await suite("personMerge", () => personMergeSuite());

  // --- payments-hardening (PROMPT-72..75): the three delete-money 409 guards,
  // the DELETE-competition NEVER_KEY 403, community card division
  // payments_unavailable vs an Event-Pass comp staying open, and the
  // stuck-webhook sweep cron. Own fresh orgs; keyless-safe.
  await suite("p72", () => p72Suite());

  // --- payments-hardening (Task 16): the 4-plan user matrix — one fresh owner
  // per plan (community/pro/enterprise/event_pass) asserting the entitlements that
  // distinguish its tier at the resolution + HTTP-status level. Own fresh orgs;
  // keyless-safe. The HTTP-level plan-truth net for the two e2e tasks that follow.
  await smokePlanMatrix();

  // --- T20: a create at `dashboard.public.max` is NEVER refused, and never
  // silent either. Own fresh community org; keyless-safe.
  await suite("publicQuotaDegrade", () => publicQuotaDegradeSuite());

  // --- Hub Knockout tab (plan 2026-09-13, Task 3): a public knockout
  // competition's hub document offers `knockout`, its rounds name only
  // fixtures the document lists, and the champion lands when the final is
  // decided. Own fresh community org; keyless-safe.
  await suite("hubKnockout", () => hubKnockoutSuite());

  // --- Format matrix W2a (Task 17): a knockout always finishes. A level
  // football semi is held and settled by lot, a drawn chess game is decided by
  // its Armageddon tie-break, a level generic result is refused, and a device
  // link may not settle. Own fresh org (repriced to Pro for the device link);
  // keyless-safe.
  await suite("bracketFinish", () => bracketFinishSuite());

  // --- Format matrix W2b (Task 18): a walkover credits what the sport declares,
  // a double walkover advances nobody, and a withdrawal walks a held line over.
  // A badminton league walkover reaches the table at 2-0 in games, each 21-0; a
  // hockey walkover at 5-0; a semi's double walkover makes the other semi's
  // winner champion; a final refuses one; a drawn chess semi waiting on its
  // tie-break is walked over by a withdrawal; a division whose only fixture is a
  // double walkover refunds its quota slot on archive. Own fresh community org;
  // keyless-safe.
  await suite("walkoverCredit", () => walkoverCreditSuite());

  // --- Schedule-board knockout round codes (2026-09-23): a knockout card on
  // the division board renders its round-role chip (SF, F) and the legend
  // names it — not the generic R{n}; then a page playoff's Q1/E/Q2/F. Own
  // fresh org (repriced to Pro for the page playoff); keyless-safe.
  await suite("boardRoundCodes", () => boardRoundCodesSuite());

  // --- Task 23: every grant an Event Pass actually delivers, asserted as a
  // passed-vs-sibling PAIR inside one fresh community org — allowed here,
  // refused there — so no assertion can be satisfied by a passless org. Own
  // fresh org; keyless-safe and spends no AI tokens.
  await suite("passGrants", () => passGrantsSuite());

  // --- v17 #294: the L rung. Proves the LADDER rather than the grants — a paid
  // purchase (driven through the real signed webhook) is filed as the rung that
  // was bought, that rung's ceilings are the ones enforced, the flat +25 credit
  // grant is not keyed by rung, and a pass stays inert on a paid plan. Own
  // fresh orgs; the purchase leg skips cleanly without Stripe secrets.
  await suite("passRungL", () => passRungLSuite());

  await suite("gap", () => gapSuite(admin, org.id, org2.id));

  // --- design/v7 PROMPT-51: staff-console platform revenue report.
  await suite("platformRevenue", () => platformRevenueSuite(admin, `delivered+admin_${tag}@resend.dev`));

  // --- Streaming R1 Task 7A: the staff "Match credits" panel's route and its mount.
  await suite("streamCreditsAdmin", () => streamCreditsAdminSuite(admin, `delivered+admin_${tag}@resend.dev`, org.id));

  // --- One trial per organisation, ever (V277): both staff stamping rails on
  // the pro path, the comp rail + the upgrade CTA on the free path. Own fresh
  // orgs; keyless-safe.
  await suite("oneTrial", () => oneTrialSuite());

  // --- Task 11: staff-only default-card removal + the customer-facing
  // refusal it deliberately does not loosen. Needs a real Stripe test-mode
  // card; keyless-safe (see the suite's own doc comment).
  await suite("paymentMethod", () => paymentMethodSuite());

  // --- clubs-w1 (W1): parent clubs group teams — the hub lifecycle (create →
  // profile → contact → standalone team → move under the club → squad with a
  // quick-created person) on Pro, and the tunable clubs.max=2 community cap.
  // Own fresh orgs so it's independent of the destructive downgrades above.
  await suite("clubs", () => clubsSuite());

  // --- #267 (SPEC-5 §2): referral attribution + the referred org's welcome
  // grant, over the real `ref`-cookie flow. Own fresh orgs; keyless-safe.
  await suite("referral", () => referralSuite());

  // --- v17 gap #293: the extra-organisation recurring add-on. A Pro
  // payer at the 5-org cap gets a 402 CARRYING a purchase offer, buying the
  // rider lifts the cap by one and the same create then succeeds; a community
  // owner and a NON-PAYER inside that same group are refused the same way and
  // offered nothing. Own fresh group; keyless-safe.
  await suite("extraOrgAddon", () => extraOrgAddonSuite());

  // --- v17 gap W10: the Event Pass lock's `past_ends_on` arm, which the
  // resolver honoured and the ENFORCEMENT sites did not. A pass one day past
  // the grace stops buying its competition out of competitions.max_active
  // (#347), and the checkout route refuses to sell a pass for a competition
  // that is already over (#353) — each paired with the same competition ON the
  // boundary, which must still be honoured. Own fresh orgs; keyless-safe.
  await suite("passLockEnforcement", () => passLockEnforcementSuite());

  // --- v17 gap W10: purchased add-on capacity dies with the money that rented
  // it. A churned subscription (#330) and a lost dispute (#331) each cancel the
  // extra-org rider AND the seat block while sparing an admin-granted comp,
  // driven through the real signed-webhook route. Own fresh groups; needs
  // STRIPE_WEBHOOK_SECRET and skips cleanly without it.
  await suite("addonChurnWebhook", () => addonChurnWebhookSuite());

  // Email outbox, phase 3 wave 2 (Task 11): a signed trial_will_end queues ONE
  // trial_ending row for the worker, and a redelivery of the same event id
  // queues none. Own fresh org; needs STRIPE_WEBHOOK_SECRET and skips cleanly
  // without it.
  await suite("outboxTrialWarning", () => outboxTrialWarningSuite());

  // F5 remainder: build.ts's per-value i18n fallbacks (see BuildOpts.i18n's
  // resultVs/courtUnassigned/rosterSignatures/rotaSignatures fields). Own
  // fresh org — never flip the shared org's default_locale, which would
  // leak French copy into every other check in this run.
  await suite("f5RemainderExportLocale", () => f5RemainderExportLocaleSuite());

  // P11 (D6) batch score-event import (design doc
  // docs/superpowers/specs/2026-08-25-p11-batch-event-import-design.md,
  // Task 9): a real import call over HTTP — the persisted fixture outcome,
  // the division-wide player-stats fold, and the decided-write news
  // auto-draft are seams the unit/regression suites can't reach from
  // outside the process. Own fresh Pro org; keyless-safe.
  await suite("eventImport", () => eventImportSuite());

  // RS006: a real destination-charge checkout for a registration entry fee —
  // the paid path scripts/stripe-connect-fixture.ts exists to make testable
  // at all. Own fresh Pro org; skips cleanly without STRIPE_CONNECT_TEST_ACCOUNT.
  await suite("registrationPaidLoop", () => registrationPaidLoopSuite());

  // RS006 money-hardening: the two registration paths that move real money
  // and were previously proven only against a stubbed Stripe — a duplicate
  // payment's auto-refund (confirmPaidRegistration) and a manual refund's
  // reverse_transfer/refund_application_fee pairing (stripeRefund). Each
  // owns a fresh Pro org; both skip cleanly without STRIPE_SECRET_KEY or
  // STRIPE_CONNECT_TEST_ACCOUNT, same convention as registrationPaidLoopSuite.
  await suite("registrationDuplicatePayment", () => registrationDuplicatePaymentSuite());
  await suite("registrationRefundReversal", () => registrationRefundReversalSuite());

  // RS012: the solo sign-up pool — capacity no longer double-counts a solo
  // sign-up as a team slot, and both the registrant (status page) and the
  // organiser (Registrants tab banner) can see someone waiting. Not
  // plan-gated (no new entitlement), so one org, no Stripe key required.
  await suite("poolSummary", () => poolSummarySuite());

  // RS011: organiser-side eligibility gates — a division's age/gender rule
  // now blocks an organiser roster-add too, not just the public registration
  // path. Own fresh Pro AND fresh community org (the gate is not plan-gated
  // — no entitlement to skip, so both must behave identically).
  await suite("eligibilityGate", () => eligibilityGateSuite());

  // RS010: registration-core-flow smoke, rebuilt fresh against the CURRENT
  // group-cart endpoints — see the block comment above these four functions'
  // definitions for what RS001 dropped and why regQueueSuite/gapSuite are
  // NOT where this coverage lives any more. Each owns a fresh org; keyless.
  await suite("registrationOpenFlow", () => registrationOpenFlowSuite());
  await suite("registrationWaitlistPromote", () => registrationWaitlistPromoteSuite());
  await suite("registrationTeamOps", () => registrationTeamOpsSuite());
  await suite("registrationSelfLinkAndConsent", () => registrationSelfLinkAndConsentSuite());

  // Chess Lichess external-play (2026-09-15 Task 9): cron auth + OTB
  // onlinePlay-off regression. Own fresh org; keyless-safe.
  await suite("externalPlayOtBSmoke", () => externalPlayOtBSmoke());

  // Email outbox, phase 1 (Task 4): the retry worker's cron route refuses a wrong secret and, with the right one, answers
  // a tick report. Keyless-safe (nothing is sent without a RESEND_API_KEY on the server); no org of its own.
  await suite("emailOutboxCronSmoke", () => emailOutboxCronSmoke());

  // Email outbox, phase 1 (Task 5): the Resend webhook fails closed. The smoke server is a production build, so an event with
  // no valid signature is refused whether or not RESEND_WEBHOOK_SECRET is set. Keyless; touches no org.
  await suite("resendWebhookSmoke", () => resendWebhookSmoke());

  // Chess in-page board T14: the match room's neutral card and its API's
  // refusals. Keyless; one signed-in stranger.
  await suite("matchRoom", () => matchRoomSuite());

  // Chess in-page board T15: the arbiter panel's page and routes refuse
  // everyone but an organiser of an online board. Keyless; own fresh org.
  await suite("arbiter", () => arbiterSuite());

  // Chess in-page board T16: the spectators' board route and the organiser's
  // two decision routes, against a live server. Keyless; own fresh org.
  await suite("onlineChessDesk", () => onlineChessDeskSuite());

  // Task 15 (spectator W1): the public match-centre page and its
  // `match_centre` API field, against a live server. Own fresh org;
  // keyless-safe.
  await suite("matchCentreSmoke", () => matchCentreSmoke());

  // Per-stage match rules (brief 2026-09-24): a stage whose rules override
  // its division's is described by those rules on the public match API, the
  // hub document and the division page. Own fresh org; keyless-safe.
  await suite("stageRulesFormatSmoke", () => stageRulesFormatSmoke());

  // Format matrix W2c (stage-level rules, match overrides, their locks): every W2c task's named smoke check lives in
  // this one suite (plan Global Constraints). Own fresh org; keyless-safe.
  await suite("w2cStageRules", () => w2cStageRulesSuite());

  // Format matrix W2d PR A (tables and tie-breaks): a stage is pinned at generate, and a stored lots draw gives the same
  // order on two reloads. Own fresh owner; needs DATABASE_URL (the pin read).
  await suite("w2dTables", () => w2dTablesSuite());

  // Format matrix W2e PR B (the write path's new refusals, the scorer's forfeit exception, rank null on a level table): one
  // check per refusal through the live route, each beside the legal event the same ledger then takes. Own fresh Pro owner;
  // needs DATABASE_URL (the plan flip).
  await suite("w2eRefusals", () => w2eRefusalsSuite());
  // YouTube Connect (T21): ten probes over the cron answers, the connect and Go live refusals, the destination list, the fake control
  // route, the Streaming page, the public replay parts, Disconnect and the privacy policy. LAST on purpose: stream-tick ticks EVERY
  // open session on the server, so no earlier suite has one left to be ended under it. Own two fresh orgs; needs DATABASE_URL and
  // CRON_SECRET, and a server on YOUTUBE_DRIVER=fake (the smoke-e2e job's first server).
  await suite("youtubeConnect", () => youtubeConnectSuite());

  // Format matrix W3 Swiss app-A: one counted check per task that owes one (T1 X-RB-1: Rebuild keeps times and courts).
  // After youtubeConnect only because the plan places every new suite after the last one: it opens no stream session, so
  // youtubeConnect's "last on purpose" still holds. Own fresh owner; keyless.
  await suite("w3SwissA", () => w3SwissASuite());
}

async function smokePlanMatrix(): Promise<void> {
  const genericDiv = {
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  };
  // Resolved entitlements + plan for an org (any member may read) — the same
  // endpoint /admin/entitlements and the settings billing tab consume. It reads
  // plan_entitlements live for the KEY LIST only; every VALUE now comes from the
  // cache-aside resolver (300s TTL), so a read here CAN serve pre-flip answers.
  // What keeps it honest is setPlan: it busts `ent:{org}:*` after its raw-SQL
  // write, so the flip is visible to the very next read. The rule is broader
  // than plans — EVERY raw-SQL write that changes what the resolver would
  // answer must bust. Never reintroduce a plan flip that writes subscriptions
  // directly and skips setPlan, nor an override write that touches
  // org_entitlement_overrides directly and skips insertEntitlementOverride.
  const readEnt = async (s: Session, orgId: string) =>
    (await call(s, `/api/orgs/${orgId}/entitlements`)) as {
      plan_key: string;
      entitlements: Record<string, { enabled?: boolean; limit?: number | null }>;
    };
  const featureKey = (r: V1Res) =>
    (r.json.error as { feature_key?: string; reason?: string } | undefined) ?? {};

  // Task 20 — the four-users-per-org, full-data-feed, populated-competition
  // pass. For a plan org's owner + host competition, seed a division that
  // covers all three entrant shapes (individual + team + pair), generate and
  // start it, provision the org's OTHER three users (two officials, player),
  // record real results, then run the five tier-gated assertions
  // against the now-POPULATED competition (not an empty shell). Plan-generic:
  // the branded-vs-plain export outcome is driven by `expectBranded`, never a
  // hardcoded plan. `hostComp` is the persona's existing competition (reused so
  // no new competition trips the community active-comp cap; for event_pass it
  // MUST be the PASSED comp so the comp-scoped `exports` grant is in force).
  const seedFeedAndAssert = async (
    owner: Session,
    orgId: string,
    hostCompId: string,
    key: string, // email suffix + label: community | pro | enterprise | pass
    expectBranded: boolean,
  ): Promise<void> => {
    // --- Full data feed: one division, all three entrant shapes. Entrant #1
    // carries a person so the player (below) can claim into a real fixture.
    const feedDiv = v1data<{ id: string }>(
      await v1(owner, `/api/v1/competitions/${hostCompId}/divisions`, "POST", {
        name: `Matrix Feed ${key}`,
        ...genericDiv,
      }),
    );
    const person = v1data<{ id: string }>(
      await v1(owner, "/api/v1/persons", "POST", {
        full_name: `Feed Player ${key} ${tag}`,
        consent: {},
      }),
    );
    await v1(owner, `/api/v1/divisions/${feedDiv.id}/entrants`, "POST", [
      {
        kind: "individual",
        display_name: `Feed Solo ${key}`,
        seed: 1,
        members: [{ person_id: person.id }],
      },
      { kind: "individual", display_name: `Feed Solo2 ${key}`, seed: 2 },
      { kind: "team", display_name: `Feed Team ${key}`, seed: 3 },
      { kind: "pair", display_name: `Feed Pair ${key}`, seed: 4 },
    ]);
    const feedStage = v1data<{ id: string }>(
      await v1(owner, `/api/v1/divisions/${feedDiv.id}/stages`, "POST", {
        seq: 1,
        kind: "league",
        name: "League",
      }),
    );
    const feedFixtures = v1data<{ fixtures: { id: string }[] }>(
      await v1(owner, `/api/v1/stages/${feedStage.id}/generate`, "POST"),
    ).fixtures;
    await v1(owner, `/api/v1/divisions/${feedDiv.id}/start`, "POST");
    check(
      `matrix/${key}: full feed built — individual+team+pair entrants, fixtures generated`,
      feedFixtures.length >= 4,
    );

    // --- User 2 (official): assigned to fixture[0], invited through the shared
    // person-claim rail, claims + accepts, sees the duty and scores it exactly
    // like a scorer (acceptedOfficialCovers). Officials are non-members — no
    // members.max seat consumed, so this holds on community too.
    const officialEmail = `delivered+official_${key}_${tag}@resend.dev`;
    const officialSession = newSession();
    await signIn(officialSession, officialEmail);
    const official = v1data<{ id: string }>(
      await v1(owner, "/api/v1/officials", "POST", {
        display_name: `Feed Ref ${key} ${tag}`,
        role_keys: ["referee"],
      }),
    );
    await v1(owner, `/api/v1/fixtures/${feedFixtures[0].id}/officials`, "PATCH", {
      set: [{ official_id: official.id, role_key: "referee", locked: false }],
    });
    const offInvite = await v1(owner, `/api/v1/officials/${official.id}/invite`, "POST", {
      email: officialEmail,
    });
    const offToken =
      (v1data<{ claim_url: string }>(offInvite).claim_url ?? "").split("/claim/")[1] ?? "";
    await call(officialSession, `/api/claims/${offToken}/accept`, "POST");
    const offAccept = await v1(
      officialSession,
      `/api/v1/me/fixtures/${feedFixtures[0].id}/officiating-response`,
      "PATCH",
      {
        response: "accepted",
      },
    );
    check(
      `matrix/${key}: the official accepts their duty`,
      offAccept.status === 200 && v1data<{ response: string }>(offAccept).response === "accepted",
    );
    const offState = await v1(officialSession, `/api/v1/fixtures/${feedFixtures[0].id}/state`);
    const offScore = await v1(
      officialSession,
      `/api/v1/fixtures/${feedFixtures[0].id}/events`,
      "POST",
      {
        expected_seq: v1data<{ last_seq: number }>(offState).last_seq,
        type: "generic.result",
        payload: { p1Score: 2, p2Score: 1 },
      },
    );
    check(`matrix/${key}: the accepted official records a result`, offScore.status === 201);

    // --- User 3 (official #2): assigned to fixture[1], invited through the shared
    // person-claim rail, claims + accepts, and records a result on the Free path.
    const official2Email = `delivered+official2_${key}_${tag}@resend.dev`;
    const official2Session = newSession();
    await signIn(official2Session, official2Email);
    const official2 = v1data<{ id: string }>(
      await v1(owner, "/api/v1/officials", "POST", {
        display_name: `Feed Ref2 ${key} ${tag}`,
        role_keys: ["referee"],
      }),
    );
    await v1(owner, `/api/v1/fixtures/${feedFixtures[1].id}/officials`, "PATCH", {
      set: [{ official_id: official2.id, role_key: "referee", locked: false }],
    });
    const off2Invite = await v1(owner, `/api/v1/officials/${official2.id}/invite`, "POST", {
      email: official2Email,
    });
    const off2Token =
      (v1data<{ claim_url: string }>(off2Invite).claim_url ?? "").split("/claim/")[1] ?? "";
    await call(official2Session, `/api/claims/${off2Token}/accept`, "POST");
    const off2Accept = await v1(
      official2Session,
      `/api/v1/me/fixtures/${feedFixtures[1].id}/officiating-response`,
      "PATCH",
      { response: "accepted" },
    );
    const off2State = await v1(official2Session, `/api/v1/fixtures/${feedFixtures[1].id}/state`);
    const off2Score = await v1(
      official2Session,
      `/api/v1/fixtures/${feedFixtures[1].id}/events`,
      "POST",
      {
        expected_seq: v1data<{ last_seq: number }>(off2State).last_seq,
        type: "generic.result",
        payload: { p1Score: 1, p2Score: 3 },
      },
    );
    check(
      `matrix/${key}: the second official claims, accepts and scores fixture[1]`,
      off2Accept.status === 200 && off2Score.status === 201,
    );

    // --- User 4 (player): claims the person on entrant #1 and reads their own
    // fixtures. Only two fixtures were decided above; the player's entrant is
    // in three, so at least one stays upcoming — the self-view is never empty.
    const playerEmail = `delivered+player_${key}_${tag}@resend.dev`;
    const playerSession = newSession();
    await signIn(playerSession, playerEmail);
    const claimInvite = await v1(owner, `/api/v1/persons/${person.id}/claim-invites`, "POST", {
      email: playerEmail,
    });
    const claimToken =
      (v1data<{ claim_url: string }>(claimInvite).claim_url ?? "").split("/claim/")[1] ?? "";
    await call(playerSession, `/api/claims/${claimToken}/accept`, "POST");
    const upcoming =
      v1data<{ upcoming: { id: string }[] }>(await v1(playerSession, "/api/v1/me/fixtures"))
        .upcoming ?? [];
    check(`matrix/${key}: the claimed player sees their own fixtures`, upcoming.length > 0);

    // --- Populated standings: the two results above make the snapshot
    // non-empty (was the empty shell before).
    const feedStandings = await v1(owner, `/api/v1/stages/${feedStage.id}/standings`);
    check(
      `matrix/${key}: standings render non-empty after recorded results`,
      feedStandings.status === 200 && v1data<{ rows: unknown[] }>(feedStandings).rows.length > 0,
    );

    // --- Export WITH DATA: the standings export 404s without a snapshot, so a
    // 200 here proves it is content-bearing (empty-doc false-green avoided).
    // community.exports=true (V285) → every tier renders; exports.branded is
    // the exact gate orgBranding() keys off to switch chrome on.
    //
    // `readEnt` asks the ORG-WIDE question (the route passes no competition id
    // on purpose — see api/orgs/[id]/entitlements/route.ts), so for event_pass
    // `expectBranded: false` is NOT a claim that the passed competition renders
    // plain. It is the opposite claim, and the load-bearing one here: a
    // competition-scoped pass must not lift `exports.branded` for the ORG. The
    // pass DOES grant it (V306) and the passed competition really does render
    // branded chrome — passGrantsSuite proves that half, competition-scoped,
    // by reading the org name out of the exported workbook.
    const feedExport = await fetch(
      `${BASE}/api/v1/divisions/${feedDiv.id}/exports/standings?format=pdf`,
      { headers: { cookie: cookieHeader(owner) } },
    );
    const feedBytes = Buffer.from(await feedExport.arrayBuffer());
    check(
      `matrix/${key}: standings export renders a content-bearing PDF`,
      feedExport.status === 200 && feedBytes.subarray(0, 5).toString() === "%PDF-",
    );
    const feedEnt = await readEnt(owner, orgId);
    check(
      `matrix/${key}: ORG-WIDE exports.branded resolves ${expectBranded} (a pass must not lift it org-wide)`,
      (feedEnt.entitlements["exports.branded"]?.enabled ?? false) === expectBranded,
    );
  };

  // === PERSONA 1 — community (default plan, no flip) =====================
  const comm = newSession();
  const commOrg = (await signIn(comm, `delivered+smoke-community-${tag}@resend.dev`)).org_id;
  const commEnt = await readEnt(comm, commOrg);
  check("matrix/community: org resolves the community plan", commEnt.plan_key === "community");
  check(
    "matrix/community: exports.branded denies",
    commEnt.entitlements["exports.branded"]?.enabled === false,
  );
  // V302: the AI Schedule Architect is granted on EVERY plan; the graded axis
  // is no longer a per-division run count (retired V322) but the monthly AI
  // credit wallet allowance. V393 (entitlements v18) cut it from 10 to 5.
  //
  // The literal is deliberate here, and stays a literal. This script reads the
  // number back out of the live API, which reads it out of `plan_entitlements`
  // — deriving the expected value from the same table would make the whole
  // check a tautology. 5 is the independent oracle: design doc §2, pinned
  // cell-for-cell by `src/server/__tests__/entitlements-v18-matrix.test.ts`.
  check(
    "matrix/community: scheduling.ai is granted on every plan (V302)",
    commEnt.entitlements["scheduling.ai"]?.enabled === true,
  );
  check(
    "matrix/community: ai.credits.monthly resolves 5 (V393)",
    commEnt.entitlements["ai.credits.monthly"]?.limit === 5,
  );
  // The bootstrap grant (createOrgForUser) synchronously seeds this period's
  // allowance at org creation, so a brand-new Community org's wallet already
  // holds it — no up-to-24h wait on the daily billing-grant cron.
  check(
    "matrix/community: a freshly-created org's AI credit wallet is bootstrap-granted 5 credits",
    (await walletBalance(commOrg)) === 5,
  );

  // A scored-through division so a real export renders.
  const cComp = v1data<{ id: string; slug: string }>(
    await v1(comm, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Community ${tag}`,
      visibility: "unlisted",
    }),
  );
  const cDiv = v1data<{ id: string }>(
    await v1(comm, `/api/v1/competitions/${cComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  await v1(comm, `/api/v1/divisions/${cDiv.id}/entrants`, "POST", [
    { kind: "individual", display_name: "A", seed: 1 },
    { kind: "individual", display_name: "B", seed: 2 },
  ]);
  const cStage = v1data<{ id: string }>(
    await v1(comm, `/api/v1/divisions/${cDiv.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  await v1(comm, `/api/v1/stages/${cStage.id}/generate`, "POST");
  await v1(comm, `/api/v1/divisions/${cDiv.id}/start`, "POST");

  // Plain export path is OPEN on community (V285) — branding is silently dropped,
  // not the whole export blocked. Proves the free export path still works.
  const plainExport = await fetch(
    `${BASE}/api/v1/divisions/${cDiv.id}/exports/timetable?format=pdf`,
    { headers: { cookie: cookieHeader(comm) } },
  );
  const plainBytes = Buffer.from(await plainExport.arrayBuffer());
  check(
    "matrix/community: the plain export path renders a PDF (branding dropped, not blocked)",
    plainExport.status === 200 && plainBytes.subarray(0, 5).toString() === "%PDF-",
  );

  // The prepaid credit wallet is the paid boundary now (not the feature
  // itself, and no longer a per-division count): drain the org's wallet to 0
  // → the next ai-plan 402s at `ai.credits` BEFORE any model call
  // (keyless-safe), and the 402 carries the contextual upgrade prompt the
  // UpgradeGate renders.
  await drainWallet(commOrg, 0);
  const commAi = await v1(comm, `/api/v1/divisions/${cDiv.id}/schedule/ai-plan`, "POST", {
    instruction: "two courts, weekday evenings only",
  });
  const commAiErr = featureKey(commAi);
  check(
    "matrix/community: an AI run 402s once the wallet is exhausted (ai.credits)",
    commAi.status === 402 && commAiErr.feature_key === "ai.credits",
  );
  check(
    "matrix/community: the cap 402 carries the upgrade prompt (reason)",
    typeof commAiErr.reason === "string" && commAiErr.reason.length > 0,
  );

  // === PERSONA 2 — pro ==================================================
  const pro = newSession();
  const proOrg = (await signIn(pro, `delivered+smoke-pro-${tag}@resend.dev`)).org_id;
  await setPlan(proOrg, "pro", pro);
  const proEnt = await readEnt(pro, proOrg);
  check("matrix/pro: org resolves the pro plan", proEnt.plan_key === "pro");
  check(
    "matrix/pro: exports.branded allowed",
    proEnt.entitlements["exports.branded"]?.enabled === true,
  );
  check(
    "matrix/pro: scheduling.ai allowed",
    proEnt.entitlements["scheduling.ai"]?.enabled === true,
  );
  check(
    "matrix/pro: ai.credits.monthly resolves 25 (V395 re-cut it from V393's 35)",
    proEnt.entitlements["ai.credits.monthly"]?.limit === 25,
  );
  // V393 DELETED `officials.per_fixture.max` — it resolved to ∞ on every plan
  // and nothing read it. The check is INVERTED rather than dropped, because
  // "absent" and "unlimited" are different answers that this endpoint reports
  // differently, and the old assertion would now read `undefined === null` and
  // FAIL rather than quietly pass. A deleted int key is a DENIAL in the
  // resolver (`const base = row ? row.int_value : 0`), so the thing worth
  // proving is that the key is not being served at all — if it reappeared with
  // a row, every plan would silently gain a finite officials cap.
  check(
    "matrix/pro: officials.per_fixture.max is not served at all (V393 deleted the key)",
    proEnt.entitlements["officials.per_fixture.max"] === undefined,
  );

  // Behavioural proof of the wallet gate: setPlan is a raw plan_key flip (it
  // does not itself grant the pro-tier monthly allowance — that only happens
  // through a real checkout/sync or the daily cron), so this org's wallet
  // still holds whatever the community bootstrap grant left it. Drain it to 0
  // and the same `ai.credits` 402 fires — the gate is plan-independent, it
  // only reads the balance.
  const proComp = v1data<{ id: string }>(
    await v1(pro, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Pro ${tag}`,
    }),
  );
  const proDiv = v1data<{ id: string }>(
    await v1(pro, `/api/v1/competitions/${proComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  await drainWallet(proOrg, 0);
  const proCapped = await v1(pro, `/api/v1/divisions/${proDiv.id}/schedule/ai-plan`, "POST", {
    instruction: "spread evenly across both courts",
  });
  check(
    "matrix/pro: an AI run 402s once the wallet is exhausted (ai.credits)",
    proCapped.status === 402 && featureKey(proCapped).feature_key === "ai.credits",
  );

  // === PERSONA 3 — enterprise (the tier above Pro) ======================
  // WAS pro_plus. V393 (entitlements v18) deleted that plan from `plans`, and
  // `subscriptions.plan_key` carries a live FK, so this flip was throwing and
  // taking the rest of the run with it. The persona's JOB is unchanged — it is
  // the above-Pro rung of the matrix — so it follows the rung to `enterprise`
  // rather than being deleted; the numbers below move to that column.
  const ent = newSession();
  const entOrg = (await signIn(ent, `delivered+smoke-enterprise-${tag}@resend.dev`)).org_id;
  await setPlan(entOrg, "enterprise", ent);
  const entEnt = await readEnt(ent, entOrg);
  check("matrix/enterprise: org resolves the enterprise plan", entEnt.plan_key === "enterprise");
  // Deliberate literals, for the reason PERSONA 1 spells out: this script reads
  // the number back out of the live API, so deriving it from `plan_entitlements`
  // would make the check a tautology. The independent oracle is design doc §2,
  // pinned cell-for-cell by `entitlements-v18-matrix.test.ts`.
  check(
    "matrix/enterprise: ai.credits.monthly resolves 500 (V393)",
    entEnt.entitlements["ai.credits.monthly"]?.limit === 500,
  );
  check(
    "matrix/enterprise: registration.fee_percent resolves 1 (the floor rate)",
    entEnt.entitlements["registration.fee_percent"]?.limit === 1,
  );

  // api.write grants: a write-capable (manage) key mints above Pro — the same
  // key 402s on a plain Pro org (aboveProRungSuite covers the negative). This is
  // still a REAL differentiator after v18: api.write is true on enterprise and
  // false on pro.
  const entKey = await v1(ent, `/api/v1/orgs/${entOrg}/api-keys`, "POST", {
    name: `matrix ent ${tag}`,
    scopes: ["manage"],
  });
  check("matrix/enterprise: api.write grants a manage-scope key (201)", entKey.status === 201);

  // officials.auto: kept, but it is no longer a TIER assertion. V290 put the
  // grant above Pro and this check was written against that; V393 brought it
  // back down to Pro (jul3Suite asserts the Pro side directly). What survives
  // here is the propose path working end to end on the top tier — coverage of
  // the feature, not of the rung it used to sit on.
  const entComp = v1data<{ id: string }>(
    await v1(ent, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Enterprise ${tag}`,
    }),
  );
  const entDiv = v1data<{ id: string }>(
    await v1(ent, `/api/v1/competitions/${entComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  await v1(
    ent,
    `/api/v1/divisions/${entDiv.id}/entrants`,
    "POST",
    ["A", "B", "C", "D"].map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
    })),
  );
  const entStage = v1data<{ id: string }>(
    await v1(ent, `/api/v1/divisions/${entDiv.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "League",
    }),
  );
  const entFixtures = v1data<{ fixtures: { id: string }[] }>(
    await v1(ent, `/api/v1/stages/${entStage.id}/generate`, "POST"),
  ).fixtures;
  await v1(ent, `/api/v1/divisions/${entDiv.id}/start`, "POST");
  await v1(ent, "/api/v1/officials", "POST", {
    display_name: `Matrix Ref ${tag}`,
    role_keys: ["referee"],
  });
  const entAuto = await v1(ent, `/api/v1/divisions/${entDiv.id}/officials/auto`, "POST", {
    policy: { roles: ["referee"] },
  });
  check(
    "matrix/enterprise: officials.auto is allowed (200, assignments proposed)",
    entAuto.status === 200 &&
      Array.isArray(v1data<{ assignments: unknown[] }>(entAuto).assignments),
  );

  // #448 — maxPerDay is capped on the ORG's calendar day, not the UTC day. Put
  // the org west of Greenwich and lay four fixtures across one LOCAL Saturday
  // whose evening half is already Sunday in UTC: a UTC bucket sees 2 + 2 and
  // fills all four, the org's own day allows only 2.
  // `call` returns json.data and THROWS on ok:false — it has no .status, so
  // assert the value actually landed. The two checks below are meaningless if
  // this org is still on UTC, so this must fail loudly rather than silently.
  const tzOrg = (await call(ent, `/api/orgs/${entOrg}`, "PATCH", {
    timezone: "America/Los_Angeles",
  })) as { timezone: string };
  check(
    "matrix/enterprise #448: org timezone set to America/Los_Angeles",
    tzOrg.timezone === "America/Los_Angeles",
  );

  // 2026-07-11 in Los Angeles (PDT, UTC-7): 10:00 & 12:00 local are still
  // Saturday UTC; 18:00 & 20:00 local are already Sunday UTC.
  const localSaturday = [
    "2026-07-11T17:00:00.000Z",
    "2026-07-11T19:00:00.000Z",
    "2026-07-12T01:00:00.000Z",
    "2026-07-12T03:00:00.000Z",
  ];
  const capVenue = v1data<{ id: string }>(
    await v1(ent, `/api/v1/orgs/${entOrg}/venues`, "POST", { name: `Cap Venue ${tag}` }),
  );
  const capCourt = v1data<{ id: string }>(
    await v1(ent, `/api/v1/orgs/${entOrg}/venues/${capVenue.id}/courts`, "POST", {
      name: "Court 1",
    }),
  );
  const capIds = entFixtures.slice(0, 4).map((f) => f.id);
  for (const [i, id] of capIds.entries()) {
    await v1(ent, `/api/v1/fixtures/${id}`, "PATCH", {
      scheduled_at: localSaturday[i],
      court_id: capCourt.id,
    });
  }
  // Park every other fixture far away so it cannot compete for the capped ref.
  for (const [i, f] of entFixtures.slice(4).entries()) {
    await v1(ent, `/api/v1/fixtures/${f.id}`, "PATCH", {
      scheduled_at: `2026-09-${String(i + 1).padStart(2, "0")}T18:00:00.000Z`,
      court_id: capCourt.id,
    });
  }

  // The cap only binds if NO other official can absorb the overflow, so give
  // this one a role nobody else on the roster holds ("Matrix Ref" is referee).
  const cappedRef = v1data<{ id: string }>(
    await v1(ent, "/api/v1/officials", "POST", {
      display_name: `Capped Judge ${tag}`,
      role_keys: ["judge"],
      max_per_day: 2,
    }),
  );
  const capAuto = await v1(ent, `/api/v1/divisions/${entDiv.id}/officials/auto`, "POST", {
    policy: { roles: ["judge"] },
    rng_seed: "tz448",
  });
  const capBody = v1data<{
    assignments: { fixtureId: string; officialId: string; roleKey: string }[];
    conflicts: { kind: string; fixtureId?: string }[];
  }>(capAuto);
  const capSet = new Set(capIds);
  const cappedOnSaturday = capBody.assignments.filter(
    (a) => capSet.has(a.fixtureId) && a.officialId === cappedRef.id,
  );
  check(
    "matrix/enterprise #448: maxPerDay caps on the ORG day across a UTC midnight",
    capAuto.status === 200 && cappedOnSaturday.length === 2,
  );
  check(
    "matrix/enterprise #448: the two over-cap local-Saturday slots report role_unfilled",
    capBody.conflicts.filter(
      (c) => c.kind === "role_unfilled" && capSet.has(c.fixtureId ?? ""),
    ).length === 2,
  );

  // === PERSONA 4 — event_pass (community org + a single-comp pass) ======
  const passer = newSession();
  const passOrg = (await signIn(passer, `delivered+smoke-pass-${tag}@resend.dev`)).org_id;

  // Passed comp: create, then grant its pass. Unlisted sidesteps the public
  // dashboard cap; the pass frees the active-comp slot for the sibling below.
  const passedComp = v1data<{ id: string; slug: string }>(
    await v1(passer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Passed ${tag}`,
      visibility: "unlisted",
    }),
  );
  const passedDiv = v1data<{ id: string }>(
    await v1(passer, `/api/v1/competitions/${passedComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  await grantPass(passOrg, passedComp.id, "event_pass");

  // A comp-scoped Pro feature (formats.advanced) resolves TRUE inside the passed
  // comp — an advanced (americano) stage is accepted.
  const passedAdv = await v1(passer, `/api/v1/divisions/${passedDiv.id}/stages`, "POST", {
    seq: 1,
    kind: "americano",
    name: "Padel",
    config: { mode: "americano", courtCount: 2, rounds: 3 },
  });
  check(
    "matrix/event_pass: formats.advanced is granted INSIDE the passed comp (201)",
    passedAdv.status === 201,
  );

  // A second, unpassed comp in the SAME org denies the same feature (the pass is
  // strictly comp-scoped).
  const siblingComp = v1data<{ id: string }>(
    await v1(passer, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `Matrix Sibling ${tag}`,
      visibility: "unlisted",
    }),
  );
  const siblingDiv = v1data<{ id: string }>(
    await v1(passer, `/api/v1/competitions/${siblingComp.id}/divisions`, "POST", {
      name: "Open",
      ...genericDiv,
    }),
  );
  const siblingAdv = await v1(passer, `/api/v1/divisions/${siblingDiv.id}/stages`, "POST", {
    seq: 1,
    kind: "americano",
    name: "Padel",
    config: { mode: "americano", courtCount: 2, rounds: 3 },
  });
  check(
    "matrix/event_pass: the sibling (unpassed) comp denies formats.advanced (402)",
    siblingAdv.status === 402 && featureKey(siblingAdv).feature_key === "formats.advanced",
  );

  // Org-wide key still resolves community (V291 dead-row fix): the pass overlays
  // only comp-scoped features — the org's plan and members.max stay community.
  const passEnt = await readEnt(passer, passOrg);
  check(
    "matrix/event_pass: the org still resolves the community plan (pass is comp-scoped)",
    passEnt.plan_key === "community",
  );
  check(
    // 3, not 5 — V393 re-cut community's seats. Line 267 of this file already
    // said 3 while this said 5; the two disagreed inside one script.
    "matrix/event_pass: org-wide members.max resolves the community value (3)",
    passEnt.entitlements["members.max"]?.limit === 3,
  );

  // === Task 20 — populated-competition assertions per plan org ===========
  // Each plan org now gets four users (owner + two officials + player) and a
  // full data feed (individual + team + pair entrants, fixtures,
  // recorded results), then the five tier-gated assertions run against the
  // populated competition. Reuses each persona's existing competition; for
  // event_pass the PASSED comp hosts the feed so the comp-scoped exports grant
  // applies. The last argument is the ORG-WIDE `exports.branded` answer: true
  // for the paid plans, false for community AND for the pass (whose grant is
  // competition-scoped and must never leak to the org — see the note above).
  await seedFeedAndAssert(comm, commOrg, cComp.id, "community", false);
  await seedFeedAndAssert(pro, proOrg, proComp.id, "pro", true);
  await seedFeedAndAssert(ent, entOrg, entComp.id, "enterprise", true);
  await seedFeedAndAssert(passer, passOrg, passedComp.id, "pass", false);
}

/** F1's owed smoke check (2026-08-17 design §5): the bracket round-role
 *  columns (lane/is_final/third_place, V368) and the bye slot label, proven
 *  over real HTTP rather than asserted only at the unit level. 6 entrants —
 *  single-elim pads to 8 slots and seeds 2 byes into round 1 (seeds 1 and 2
 *  skip straight to round 2), giving a real bye AND a real 3-round bracket
 *  in one seed.
 *
 *  Own session, own org, keyless — deliberately NOT called from inside the
 *  `aiConfigured` block `seedBracketAiDivision`'s own AI-plan callers live in
 *  (schedRegV3Suite's #396 seed, ~line 10333): that block's checks skip
 *  outright when SCHEDULING_AI_BASE_URL is unset, and this check asserts
 *  nothing AI-related, so gating it there would make it skip for the same
 *  reason #452's schedulingConstraintsSuite deliberately did NOT hang off
 *  that seed either (see the comment above that suite). Runs unconditionally
 *  on every smoke invocation instead. */
async function smokeBracketRoundRoleAndByes(s: Session): Promise<void> {
  const comp = v1data<{ id: string }>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `RoundRole ${tag}` }),
  );
  const div = v1data<{ id: string }>(
    await v1(s, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const entrants = Array.from({ length: 6 }, (_, i) => ({
    kind: "individual",
    display_name: `RR${i + 1} ${tag}`,
    seed: i + 1,
  }));
  await v1(s, `/api/v1/divisions/${div.id}/entrants`, "POST", entrants);
  const stage = v1data<{ id: string }>(
    await v1(s, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "knockout",
      name: "Cup",
      config: {},
    }),
  );
  const gen = v1data<{
    fixtures: {
      id: string;
      round_no: number;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      lane: "WB" | "LB" | "GF" | null;
      is_final?: boolean;
      third_place?: boolean;
      away_slot_label?: { key: string; params: Record<string, unknown> } | null;
    }[];
  }>(await v1(s, `/api/v1/stages/${stage.id}/generate`, "POST"));

  const round1 = gen.fixtures.filter((f) => f.round_no === 1);
  const round1Byes = round1.filter((f) => f.away_entrant_id === null && f.home_entrant_id !== null);
  check("6-entrant single-elim: round 1 has exactly 2 byes", round1Byes.length === 2);
  check(
    "each round-1 bye fixture carries the bye slot label on the phantom side",
    round1Byes.every((f) => f.away_slot_label?.key === "bracket.slot.bye"),
  );

  const final = gen.fixtures.find((f) => f.is_final === true);
  check("bracket carries exactly one fixture flagged is_final", gen.fixtures.filter((f) => f.is_final).length === 1);
  check(
    "the final's round_no is the bracket's last round (round 3 for 6 entrants)",
    final !== undefined && final.round_no === 3,
  );
  check(
    "no fixture in a single-lane knockout carries a losers/grand-final lane",
    gen.fixtures.every((f) => f.lane === null || f.lane === "WB"),
  );
  check(
    "no fixture is flagged third_place (this stage did not enable it)",
    gen.fixtures.every((f) => f.third_place !== true),
  );
}
