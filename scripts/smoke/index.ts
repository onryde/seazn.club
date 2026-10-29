// End-to-end smoke test against the running dev server (http://localhost:3000).
// Run with: node --experimental-strip-types scripts/smoke/index.ts
//
// Teardown: when DATABASE_URL is set (CI, or `node --env-file=.env.local`), the
// run's own test users + their orgs are purged afterwards (see cleanup). The DB
// must be the same one the target server uses.
import { selectSmokeSuites, type SmokeSelection } from "../smoke-select.ts";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import {
  type Session, newSession, call, check, writeManifest, signIn, tag, insertEntitlementOverride, setPlan, cleanup,
  counts,
} from "./harness.ts";
import { main } from "./main.ts";
import { bracketFinishSuite } from "./suites/bracketFinish.ts";
import { walkoverCreditSuite } from "./suites/walkoverCredit.ts";
import { outboxTrialWarningSuite } from "./suites/outboxTrialWarning.ts";
import { w2cStageRulesSuite } from "./suites/w2cStageRules.ts";
import { w2dTablesSuite } from "./suites/w2dTables.ts";
import { divisionSettingsSuite } from "./suites/divisionSettings.ts";
import { funnelReminderSuite } from "./suites/funnelReminder.ts";
import { v1Suite } from "./suites/v1.ts";
import { streamTargetsSuite } from "./suites/streamTargets.ts";
import { captureV2Suite } from "./suites/captureV2.ts";
import { captureRecordSuite } from "./suites/captureRecord.ts";
import { streamOverlaySuite } from "./suites/streamOverlay.ts";
import { matchRoomSuite } from "./suites/matchRoom.ts";
import { arbiterSuite } from "./suites/arbiter.ts";
import { onlineChessDeskSuite } from "./suites/onlineChessDesk.ts";
import { epochFloorOverrideSuite } from "./suites/epochFloorOverride.ts";
import { registrationOpenFlowSuite } from "./suites/registrationOpenFlow.ts";
import { youtubeConnectSuite } from "./suites/youtubeConnect.ts";

// --- SMOKE_ONLY (review R1): run named suites alone, without a full smoke -----
type SubsetCtx = { admin: Session; org2Id: string; org2Slug: string };

/** Suites that may run alone under SMOKE_ONLY (name = the function name without `Suite`). Add a suite here only if it
 *  needs nothing beyond SubsetCtx. */
const SELECTABLE_SUITES: Record<string, (c: SubsetCtx) => Promise<void>> = {
  streamTargets: (c) => streamTargetsSuite(c.admin, c.org2Id),
  v1: (c) => v1Suite(c.admin, c.org2Id, c.org2Slug),
  captureV2: () => captureV2Suite(),
  captureRecord: () => captureRecordSuite(),
  bracketFinish: () => bracketFinishSuite(),
  walkoverCredit: () => walkoverCreditSuite(),
  streamOverlay: () => streamOverlaySuite(),
  matchRoom: () => matchRoomSuite(),
  arbiter: () => arbiterSuite(),
  onlineChessDesk: () => onlineChessDeskSuite(),
  w2cStageRules: () => w2cStageRulesSuite(),
  divisionSettings: (c) => divisionSettingsSuite(c.admin),
  epochFloorOverride: () => epochFloorOverrideSuite(),
  registrationOpenFlow: () => registrationOpenFlowSuite(),
  outboxTrialWarning: () => outboxTrialWarningSuite(),
  w2dTables: () => w2dTablesSuite(),
  funnelReminder: () => funnelReminderSuite(),
  youtubeConnect: () => youtubeConnectSuite(),
};

/** The subset's setup: the same calls main() makes for this state, in main()'s order — the admin sign-in, the plan
 *  bump that lets the owner create a second org (setPlan also writes this run's staff-audit row through
 *  bustOrgEntitlements, which cleanup()'s audit conjunct needs), org2's create and rename, and org2's public-dashboard
 *  headroom. Every inline check in main() and every unregistered suite is skipped. */
async function subsetSetup(): Promise<SubsetCtx> {
  const admin = newSession();
  const ver = await signIn(admin, `delivered+admin_${tag}@resend.dev`);
  check("subset setup: admin signed in", !!admin.cookies["seazn_session"]);
  await setPlan(ver.org_id, "pro", admin);
  const org2 = (await call(admin, "/api/orgs", "POST", { name: `Second Org ${tag}` })) as { id: string; slug: string };
  const renamed = (await call(admin, `/api/orgs/${org2.id}`, "PATCH", { name: `Renamed Org ${tag}` })) as { slug: string };
  check("subset setup: org2 created and renamed", !!org2.id && !!renamed.slug);
  await insertEntitlementOverride(admin, org2.id, "dashboard.public.max", 100);
  return { admin, org2Id: org2.id, org2Slug: renamed.slug };
}

async function runSubset(names: readonly string[]): Promise<void> {
  const ctx = await subsetSetup();
  // Every name here passed selectSmokeSuites against this registry's own keys, so each lookup is defined.
  for (const n of names) await SELECTABLE_SUITES[n](ctx);
  console.log(`SMOKE_ONLY: ran ${names.length} suite(s): ${names.join(", ")} — main()'s inline checks and every other suite were skipped`);
}

// A bad SMOKE_ONLY fails before any request: exit 1 with the selector's own message.
let selection: SmokeSelection;
try {
  selection = selectSmokeSuites(Object.keys(SELECTABLE_SUITES), process.env.SMOKE_ONLY);
} catch (e) {
  console.error("ERROR:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}

(selection.mode === "all" ? main() : runSubset(selection.names))
  .then(async () => {
    await cleanup(tag);
    console.log(`${counts().pass} passed, ${counts().fail} failed`);
    writeManifest();
    process.exit(counts().fail === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("ERROR:", e instanceof Error ? e.message : String(e));
    await cleanup(tag);
    console.log(`${counts().pass} passed, ${counts().fail} failed`);
    writeManifest();
    process.exit(1);
  });
