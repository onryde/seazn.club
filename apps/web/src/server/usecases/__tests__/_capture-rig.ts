// server/usecases/__tests__/_capture-rig.ts — the phone routes' DB rig (capture QR v2 T8a–T8c). NOT a test file (the
// _session-rig.ts precedent). One org, one started fixture (generic, or cricket for "another sport"), the relay and
// overlay entitlements, one destination, FAKE drivers on a tickable clock, and the fixture's stream code minted through
// the REAL `ensureStreamCode` — so `code` and `tok` are exactly what the organiser's QR carries.
//
// Sessions are started through the REAL organiser path (`createSession`, W5 included): the start pairs a present phone
// first (`pairPresentPhone`), and the session's `pairing_id` is that pairing — the "session's phone". Read-side tests
// then move a session to the state they need with a raw update: only the READ is under test there, never `decide`.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { FakeIngest, FakeRunner } from "@/server/relay/fakes";
import { pairPresentPhone, rigUser } from "@/server/relay/__tests__/_session-rig";
import { ensureStreamCode } from "../stream-codes";
import { grantCredits } from "../stream-credits";
import { createSession, type SessionDeps } from "../stream-sessions";
import { createStreamTarget } from "../stream-targets";
import { seedOrg, startedCricketDivisionWithFixture, startedDivisionWithFixture } from "./_rig";

export async function override(orgId: string, key: string, value: boolean): Promise<void> {
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${orgId}, ${key}, ${value}, 'capture rig')
            on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  await invalidateOrgEntitlements(orgId);
}

/** A phone id inside the contract's 16..64 and V430's check. */
export const phoneId = (tag: string): string => `phone-${tag}-${randomUUID()}`;

/** Recording storage is ONE account-wide pool and admission reserves against every active session in the database
 *  (stream-sessions.test.ts's ROOMY reasoning): roomy, so no start here reads 503 storage_exhausted for a reason no test
 *  controls. */
const ROOMY_STORAGE_MINUTES = 100_000_000;

/** `credits`: bought credits granted up front — a session needs one to go live (the consume at warming → live). */
export async function captureRig(opts: { sport?: "generic" | "cricket"; overlay?: boolean; relay?: boolean; targetLabel?: string; connectAfterMs?: number; credits?: number } = {}) {
  const seeded = await seedOrg();
  const auth = { ...seeded.auth, userId: await rigUser() };
  const fixtureId = opts.sport === "cricket"
    ? (await startedCricketDivisionWithFixture(auth)).fixtureId
    : (await startedDivisionWithFixture(auth)).fixtureId;
  await override(auth.orgId, "streaming.overlay", opts.overlay ?? true);
  await override(auth.orgId, "streaming.relay", opts.relay ?? true);
  if (opts.credits) await grantCredits({ orgId: auth.orgId, delta: opts.credits, createdBy: await rigUser(), note: "capture rig", idempotencyKey: randomUUID() });
  const target = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: opts.targetLabel ?? "Club", streamKey: `yt-${randomUUID()}` });
  let now = Date.now();
  const ingest = new FakeIngest({ clock: () => now, connectAfterMs: opts.connectAfterMs ?? 3000 });
  ingest.storage = { totalStorageMinutes: 0, totalStorageMinutesLimit: ROOMY_STORAGE_MINUTES, videoCount: 0 };
  const runner = new FakeRunner();
  const deps: SessionDeps = { drivers: { ingest, runner }, now: () => new Date(now), appUrl: "http://app.test" };
  const shown = await ensureStreamCode(auth, fixtureId);
  return {
    auth, fixtureId, target, ingest, runner, deps,
    code: shown.qr.code, tok: shown.qr.tok,
    tick: (ms: number) => { now += ms; },
    now: () => new Date(now),
    /** Pair `phone` on the fixture's ACTIVE code at the rig's clock (the one current pairing per code and slot). */
    pair: (phone: string) => pairPresentPhone(fixtureId, { phone, at: new Date(now) }),
    /** The organiser's Go live through the real path; `phone` is paired first and becomes the session's phone. */
    async start(phone: string): Promise<string> {
      await pairPresentPhone(fixtureId, { phone, at: new Date(now) });
      const { sessionId } = await createSession(auth, fixtureId, { mode: "passthrough", targetId: target.id }, deps);
      return sessionId;
    },
  };
}
export type CaptureRig = Awaited<ReturnType<typeof captureRig>>;
