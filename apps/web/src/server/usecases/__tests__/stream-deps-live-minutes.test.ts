// Seazn-hosted video Task 31 fix round 1 (review m10): the process default for Cloudflare's minutes-viewed reader is resolved in
// stream-sessions/deps.ts (`liveMinutesOf`), beside `youtubeOf` and `replayOf` — never built inside a usecase. A rig's own reader
// wins; absent, it is the real reader, its calls recorded by the database recorder (as every Cloudflare call is).
import { describe, expect, it, vi } from "vitest";

const cf = vi.hoisted(() => ({ liveMinutesViewed: vi.fn(async () => ({ "uid-a": 2.5 })) }));
vi.mock("@/server/video/cf-analytics", () => ({ liveMinutesViewed: cf.liveMinutesViewed }));

import { dbRecorder } from "@/server/relay/drivers";
import type { LiveMinutesReader } from "@/server/video/cf-analytics";
import { type SessionDeps, liveMinutesOf } from "../stream-sessions";

const base = { drivers: {} as SessionDeps["drivers"], now: () => new Date(), appUrl: "https://seazn.example" };

describe("liveMinutesOf", () => {
  it("the deps' own reader when given (no Cloudflare call); otherwise Cloudflare's, with the uids and window passed through and the database recorder", async () => {
    const own: LiveMinutesReader = async () => ({ mine: 1 });
    expect(liveMinutesOf({ ...base, liveMinutes: own })).toBe(own);
    expect(cf.liveMinutesViewed).not.toHaveBeenCalled();

    const from = new Date("2026-11-20T00:00:00.000Z");
    const to = new Date("2026-11-22T00:00:00.000Z");
    expect(await liveMinutesOf(base)(["uid-a"], from, to)).toEqual({ "uid-a": 2.5 });
    expect(cf.liveMinutesViewed.mock.calls).toEqual([[["uid-a"], from, to, { recorder: dbRecorder }]]);
  });
});
