// Phase 0 review m3: the description's match facts are a nice-to-have line, so their read is BEST EFFORT. A throw from
// `readDescriptionFacts` must not fail a Go live: the broadcast is created with no fact lines and the fault is reported. Positive pair
// first, on the same world: with the read working, the competition is one of the description's lines.
//
// Sport: not applicable — the failure path reads no sport rule (generic rig).
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const facts = vi.hoisted(() => ({ fail: false, errors: [] as { err: unknown; ctx: unknown }[] }));
vi.mock("@/lib/sentry", () => ({ captureError: (err: unknown, ctx: unknown) => { facts.errors.push({ err, ctx }); } }));
vi.mock("@/server/youtube/description-facts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/youtube/description-facts")>();
  return {
    ...actual,
    readDescriptionFacts: async (...args: Parameters<typeof actual.readDescriptionFacts>) => {
      if (facts.fail) throw new Error("facts read failed");
      return actual.readDescriptionFacts(...args);
    },
  };
});

import { sql } from "@/lib/db";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { FakeYouTube } from "@/server/youtube/fake";
import { prepareYoutubeBroadcast } from "@/server/youtube/prepare";
import { connect, org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = new Date("2026-11-20T12:00:00.000Z");

const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});

describe.skipIf(!HAS_DB)("prepareYoutubeBroadcast — the description facts are best effort (Phase 0 review m3)", () => {
  it("a throwing facts read: the Go live still prepares, the description carries no fact line, and the fault is reported", async () => {
    const o = await org();
    const c = await connect(o);
    const d = await divisionRig(o.auth, { entrants: 3 });
    const [fOk, fFail] = d.fixtureIds as [string, string];
    const fake = new FakeYouTube();
    const [{ comp }] = await sql<{ comp: string }[]>`
      select c.name as comp from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
       where f.id = ${fOk}`;
    const descriptionOf = async (broadcastId: string) => {
      const [row] = await sql<{ yt: string }[]>`select yt_broadcast_id as yt from youtube_broadcasts where id = ${broadcastId}`;
      return fake.inspectBroadcast(row!.yt)!.description;
    };

    // Positive pair: the read works, and the competition is a line of its own.
    facts.fail = false;
    const ok = await prepareYoutubeBroadcast({ orgId: o.orgId, fixtureId: fOk, targetId: c.targetId, now: T0, startCause: "organiser" }, fake);
    expect((await descriptionOf(ok!.broadcastId)).split("\n"), "PREMISE: the facts reach the description").toContain(comp);

    // The read throws: prepare still answers, with no fact lines, and the fault is reported once under its own route.
    facts.fail = true;
    facts.errors.length = 0;
    const failed = await prepareYoutubeBroadcast({ orgId: o.orgId, fixtureId: fFail, targetId: c.targetId, now: T0, startCause: "organiser" }, fake);
    expect(failed, "the Go live proceeds").not.toBeNull();
    expect((await descriptionOf(failed!.broadcastId)).split("\n")).not.toContain(comp);
    const reported = facts.errors.filter((e) => (e.ctx as { route?: string }).route === "youtube.prepare.description_facts");
    expect(reported).toHaveLength(1);
  });
});
