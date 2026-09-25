// Fix batch item 6b (owner-approved 2026-09-25): `result_entered` says which
// door decided the match. `source` is "device_link" when the DECIDING append
// came through a device link (the dl_ bearer door stamps `deviceLinkId` on the
// append, scoring.ts → score_events.device_link_id), else "organiser". Real
// Postgres, the real bearer door (`deviceFor`), the real scoring use case; only
// PostHog is mocked. The mixed cases are the ones where the answer differs from
// "did a device link touch this match at all" and from "who started it".
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import type { AuthCtx } from "@/server/api-v1/auth";
import { scoreEvent } from "../scoring";
import { importEvents } from "../event-import";
import { seedOrg } from "./_seed";
import { deviceFor, fixturesOf, seedStage } from "./_sheets-rig";
import { seedOrg as seedImportOrg, startedDivisionWithFixture, decidingStream } from "./_rig";

vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  // _sheets-rig stubs DEVICE_LINK_KEK once, at import: unstub in afterAll only.
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

type Captured = { event: string; properties?: Record<string, unknown> };
const resultEntered = (): Record<string, unknown>[] =>
  vi
    .mocked(captureServer)
    .mock.calls.map(([args]) => args as Captured)
    .filter((a) => a.event === EVENTS.RESULT_ENTERED)
    .map((a) => a.properties ?? {});

/** The one result_entered for this fixture, its property set pinned, and no credential in it. */
function sentFor(fixtureId: string): Record<string, unknown> {
  const sent = resultEntered().filter((p) => p.fixture_id === fixtureId);
  expect(sent, "exactly one result_entered for the fixture").toHaveLength(1);
  const props = sent[0]!;
  expect(Object.keys(props).sort()).toEqual(["fixture_id", "source", "sport_key", "status"]);
  for (const value of Object.values(props)) {
    expect(String(value)).not.toContain("dl_");
    expect(String(value)).not.toContain("/score/");
  }
  return props;
}

async function oneFixture(): Promise<{ owner: AuthCtx; fixtureId: string }> {
  const { auth } = await seedOrg("pro");
  const { stage } = await seedStage(auth, "league", ["A", "B"]);
  const [fixture] = await fixturesOf(stage.id);
  return { owner: auth, fixtureId: fixture!.id };
}

const start = (actor: AuthCtx, fixtureId: string) =>
  scoreEvent(actor, fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
const decide = (actor: AuthCtx, fixtureId: string) =>
  scoreEvent(actor, fixtureId, { expected_seq: 1, type: "generic.result", payload: { p1Score: 2, p2Score: 1 } });

beforeEach(() => {
  vi.mocked(captureServer).mockClear();
});

describe.skipIf(!HAS_DB)("result_entered carries the deciding append's source (fix batch 6b)", () => {
  it("decided through a device link → source device_link", async () => {
    const { owner, fixtureId } = await oneFixture();
    const device = await deviceFor(owner, fixtureId);
    expect(device.via).toBe("device_link"); // premise: the real bearer door
    await start(device, fixtureId);
    await decide(device, fixtureId);
    expect(sentFor(fixtureId).source).toBe("device_link");
  });

  it("decided by the organiser's session → source organiser", async () => {
    const { owner, fixtureId } = await oneFixture();
    await start(owner, fixtureId);
    await decide(owner, fixtureId);
    expect(sentFor(fixtureId).source).toBe("organiser");
  });

  it("started on a device link, decided by the organiser → organiser (the DECIDING append counts)", async () => {
    const { owner, fixtureId } = await oneFixture();
    await start(await deviceFor(owner, fixtureId), fixtureId);
    await decide(owner, fixtureId);
    expect(sentFor(fixtureId).source).toBe("organiser");
  });

  it("started by the organiser, decided on a device link → device_link", async () => {
    const { owner, fixtureId } = await oneFixture();
    await start(owner, fixtureId);
    await decide(await deviceFor(owner, fixtureId), fixtureId);
    expect(sentFor(fixtureId).source).toBe("device_link");
  });

  it("an import (the other result_entered emitter) → organiser", async () => {
    const { auth } = await seedImportOrg();
    const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
    const report = await importEvents(auth, divisionId, {
      import_id: "imp-source",
      streams: [{ fixture: { id: fixtureId }, events: decidingStream() }],
    });
    expect(report.results[0]!.status).toBe("imported");
    expect(sentFor(fixtureId).source).toBe("organiser");
  });
});
