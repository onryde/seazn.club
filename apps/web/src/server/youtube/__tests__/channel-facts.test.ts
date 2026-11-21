// Phase 0, YouTube channel safety, Task 3: two facts about a connected channel that a Go live warning reads - how old the channel is
// (channels.list `snippet.publishedAt`) and how many of its recent broadcasts were SHORT (liveBroadcasts.list) - and the pure rule that
// turns them into a warning (`channelSafetyWarning`). The connect stores the channel's creation date (V539 `channel_created_at`), best
// effort: a failed read stores null and never fails the connect.
//
// Expected values derive from the constants in lib/youtube.ts (30 days, 10 minutes, 2 short broadcasts, 24 hours), never from the code
// under test. The port half runs against FakeYouTube; the Google adapter's half is in google.test.ts (fake fetch, no network).
//
// Sport: not applicable - a channel's age and its broadcast history are facts about YouTube, never about a sport.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import {
  YOUTUBE_SHORT_BROADCAST_MINUTES, YOUTUBE_SHORT_BROADCAST_WARN_COUNT, YOUTUBE_SHORT_BROADCAST_WINDOW_HOURS, YOUTUBE_YOUNG_CHANNEL_DAYS,
} from "@/lib/youtube";
import { channelSafetyWarning } from "@/server/youtube/channel-safety";
import { pickYoutubeChannel } from "@/server/youtube/connections";
import { FakeYouTube } from "@/server/youtube/fake";
import { channelId, grant, org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const NOW = new Date("2026-11-20T12:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// ─── the pure rule ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the constants are the plan's", () => {
  it("30 days young, 10 minutes short, a warning from 2 short broadcasts, in a 24 hour window", () => {
    expect([YOUTUBE_YOUNG_CHANNEL_DAYS, YOUTUBE_SHORT_BROADCAST_MINUTES, YOUTUBE_SHORT_BROADCAST_WARN_COUNT, YOUTUBE_SHORT_BROADCAST_WINDOW_HOURS])
      .toEqual([30, 10, 2, 24]);
  });
});

describe("channelSafetyWarning", () => {
  const OLD = ago(400 * DAY);
  /** A broadcast that started `startedMinAgo` minutes before NOW and lasted `lastedMin` minutes (null: still live). */
  const b = (startedMinAgo: number, lastedMin: number | null) => {
    const startedAt = ago(startedMinAgo * MIN);
    return { startedAt, endedAt: lastedMin === null ? null : new Date(startedAt.getTime() + lastedMin * MIN) };
  };
  const shortMin = YOUTUBE_SHORT_BROADCAST_MINUTES - 1;
  const longMin = YOUTUBE_SHORT_BROADCAST_MINUTES + 1;
  const windowMin = YOUTUBE_SHORT_BROADCAST_WINDOW_HOURS * 60;

  const rows: [string, Parameters<typeof channelSafetyWarning>[0], { young: boolean; shortRecent: number; warn: boolean }][] = [
    ["age one day under the young limit", { createdAt: ago((YOUTUBE_YOUNG_CHANNEL_DAYS - 1) * DAY), broadcasts: [], now: NOW }, { young: true, shortRecent: 0, warn: true }],
    ["age exactly the young limit", { createdAt: ago(YOUTUBE_YOUNG_CHANNEL_DAYS * DAY), broadcasts: [], now: NOW }, { young: false, shortRecent: 0, warn: false }],
    ["age one day past the young limit", { createdAt: ago((YOUTUBE_YOUNG_CHANNEL_DAYS + 1) * DAY), broadcasts: [], now: NOW }, { young: false, shortRecent: 0, warn: false }],
    ["no broadcasts", { createdAt: OLD, broadcasts: [], now: NOW }, { young: false, shortRecent: 0, warn: false }],
    ["one short", { createdAt: OLD, broadcasts: [b(60, shortMin)], now: NOW }, { young: false, shortRecent: 1, warn: false }],
    ["two short", { createdAt: OLD, broadcasts: [b(60, shortMin), b(120, shortMin)], now: NOW }, { young: false, shortRecent: 2, warn: true }],
    ["three short", { createdAt: OLD, broadcasts: [b(60, shortMin), b(120, shortMin), b(180, 1)], now: NOW }, { young: false, shortRecent: 3, warn: true }],
    ["two long", { createdAt: OLD, broadcasts: [b(60, longMin), b(120, 90)], now: NOW }, { young: false, shortRecent: 0, warn: false }],
    ["one short and one long", { createdAt: OLD, broadcasts: [b(60, shortMin), b(120, longMin)], now: NOW }, { young: false, shortRecent: 1, warn: false }],
    ["two short just outside the window", { createdAt: OLD, broadcasts: [b(windowMin + 1, shortMin), b(windowMin + 30, shortMin)], now: NOW }, { young: false, shortRecent: 0, warn: false }],
    ["still live (no end) is not short", { createdAt: OLD, broadcasts: [b(2, null), b(5, null)], now: NOW }, { young: false, shortRecent: 0, warn: false }],
    ["no creation date is not young", { createdAt: null, broadcasts: [], now: NOW }, { young: false, shortRecent: 0, warn: false }],
  ];

  it("the table", () => {
    let checked = 0;
    for (const [name, input, want] of rows) {
      expect(channelSafetyWarning(input), name).toEqual(want);
      checked++;
    }
    expect(checked, "anti-vacuity: every row").toBe(12);
  });
});

// ─── the port, against the fake ──────────────────────────────────────────────────────────────────────────────────────────

describe("FakeYouTube channel facts", () => {
  async function seeded() {
    const f = new FakeYouTube({ now: () => NOW });
    const ch = channelId();
    const rt = `1//cf-${randomBytes(8).toString("hex")}`;
    f.seedGrant({ refreshToken: rt, channelId: ch, channelTitle: "Facts FC" });
    return { f, ch, at: await f.accessToken(rt) };
  }

  it("channelCreatedAt answers the seeded date for the named channel, null for another channel and for one never seeded", async () => {
    const { f, ch, at } = await seeded();
    expect(await f.channelCreatedAt(at, ch), "not seeded").toBeNull();
    const created = new Date("2026-11-01T08:00:00.000Z");
    f.setChannelCreatedAt(ch, created);
    expect((await f.channelCreatedAt(at, ch))?.toISOString()).toBe(created.toISOString());
    expect(await f.channelCreatedAt(at, channelId()), "a channel the grant does not list").toBeNull();
    expect(f.calls.filter((c) => c.method === "channelCreatedAt")).toHaveLength(3);
  });

  it("recentBroadcasts filters by `since`, newest first, and lists only the token's own channel", async () => {
    const { f, ch, at } = await seeded();
    const since = ago(DAY);
    f.addBroadcastHistory(ch, { startedAt: ago(2 * DAY), endedAt: ago(2 * DAY - 5 * MIN) });   // before `since`
    f.addBroadcastHistory(ch, { startedAt: ago(3 * 60 * MIN), endedAt: ago(3 * 60 * MIN - 4 * MIN) });
    f.addBroadcastHistory(ch, { startedAt: ago(60 * MIN), endedAt: null });
    f.addBroadcastHistory(channelId(), { startedAt: ago(30 * MIN), endedAt: ago(20 * MIN) });   // another channel's
    const got = await f.recentBroadcasts(at, since);
    expect(got.map((x) => [x.startedAt.toISOString(), x.endedAt?.toISOString() ?? null])).toEqual([
      [ago(60 * MIN).toISOString(), null],
      [ago(3 * 60 * MIN).toISOString(), ago(3 * 60 * MIN - 4 * MIN).toISOString()],
    ]);
  });

  it("recentBroadcasts includes a broadcast the fake itself ran (went live, then completed)", async () => {
    const { f, at } = await seeded();
    const { streamId } = await f.insertStream(at, { title: "k" });
    const { broadcastId } = await f.insertBroadcast(at, { title: "t", description: "d", scheduledStart: NOW, privacy: "unlisted", madeForKids: false });
    await f.bind(at, broadcastId, streamId);
    f.videoOn(streamId);
    await f.complete(at, broadcastId);
    expect(await f.recentBroadcasts(at, ago(MIN))).toEqual([{ startedAt: NOW, endedAt: NOW }]);
  });
});

// ─── the connect stores the creation date ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("a new connection stores the channel's creation date (V539), best effort", () => {
  const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
  const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
  beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
  afterAll(() => {
    for (const k of KEKS) {
      if (savedKeks[k] === undefined) delete process.env[k];
      else process.env[k] = savedKeks[k];
    }
  });

  async function pick(prepare: (f: FakeYouTube, ch: string) => void) {
    const o = await org();
    const ch = { id: channelId(), title: "Created United" };
    const p = await grant(o, { channels: [ch] });
    const f = new FakeYouTube({ now: () => NOW });
    f.seedGrant({ refreshToken: p.token, channelId: ch.id, channelTitle: ch.title });
    prepare(f, ch.id);
    const saved = await pickYoutubeChannel(o.auth, o.orgId, { pendingId: p.id, channelId: ch.id }, f);
    const [row] = await sql<{ channel_created_at: Date | null }[]>`
      select channel_created_at from org_youtube_connections where id = ${saved.connectionId}`;
    return { saved, stored: row!.channel_created_at };
  }

  it("stores snippet.publishedAt of the connected channel", async () => {
    const created = new Date("2025-03-04T05:06:07.000Z");
    const { saved, stored } = await pick((f, ch) => f.setChannelCreatedAt(ch, created));
    expect(saved.existing).toBe(false);
    expect(stored?.toISOString()).toBe(created.toISOString());
  });

  it("a reconnect (the same channel picked again in the same org) reads nothing and keeps the stored date", async () => {
    const o = await org();
    const ch = { id: channelId(), title: "Reconnect Rovers" };
    const f = new FakeYouTube({ now: () => NOW });
    const first = new Date("2025-03-04T05:06:07.000Z");
    f.setChannelCreatedAt(ch.id, first);
    const p1 = await grant(o, { channels: [ch] });
    f.seedGrant({ refreshToken: p1.token, channelId: ch.id, channelTitle: ch.title });
    const made = await pickYoutubeChannel(o.auth, o.orgId, { pendingId: p1.id, channelId: ch.id }, f);
    expect(made.existing, "PREMISE: the first pick is new").toBe(false);
    const callsAfterFirst = f.calls.filter((c) => c.method === "channelCreatedAt").length;
    expect(callsAfterFirst, "PREMISE: the first pick read the date").toBe(1);

    f.setChannelCreatedAt(ch.id, new Date("2026-11-19T00:00:00.000Z"));   // a read now would store THIS
    const p2 = await grant(o, { channels: [ch] });
    f.seedGrant({ refreshToken: p2.token, channelId: ch.id, channelTitle: ch.title });
    const again = await pickYoutubeChannel(o.auth, o.orgId, { pendingId: p2.id, channelId: ch.id }, f);
    expect(again).toMatchObject({ existing: true, connectionId: made.connectionId });
    expect(f.calls.filter((c) => c.method === "channelCreatedAt").length, "a reconnect makes no channelCreatedAt call").toBe(callsAfterFirst);
    const [row] = await sql<{ channel_created_at: Date | null }[]>`
      select channel_created_at from org_youtube_connections where id = ${made.connectionId}`;
    expect(row!.channel_created_at?.toISOString()).toBe(first.toISOString());
  });

  it("a failed read stores null and the connect still succeeds", async () => {
    const { saved, stored } = await pick((f, ch) => {
      f.setChannelCreatedAt(ch, new Date("2025-03-04T05:06:07.000Z"));
      f.failNext("channelCreatedAt", "youtube_unavailable");
    });
    expect(saved.existing).toBe(false);
    expect(stored).toBeNull();
  });
});
