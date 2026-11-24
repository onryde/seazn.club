// Seazn-hosted video T47: the camera RULE (`hubStreamOf`), swept over the whole fixture-status vocabulary with no database. The rule is a
// function of facts the loader reads; this file holds every combination of them. The database half (`hub-stream-flags-db.test.ts`) holds
// the loader's reads, the one-statement shape and the agreement with the match page itself.
//
// Expected answers come from the match page's own vocabulary: which statuses are void and which are "replayable" is `streamLinkLabelKey`'s
// (null / "overlay.replay" / "overlay.watchLive"), never a list typed here, so a status the vocabulary gains is swept the day it lands.
import { describe, expect, it } from "vitest";

import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { youtubeWatchUrl } from "@/lib/youtube";
import { hubStreamOf, type HubStreamFacts } from "../hub-stream-flags";
import { streamLinkLabelKey } from "../../../app/(public)/live/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/stream-link";

const CLUB_LINK = "https://www.twitch.tv/seaznclub";
const part = (n: number, id = `vid${n}`) => ({ partNo: n, url: youtubeWatchUrl(id), madeForKids: false as boolean | null });
const base = (status: string, over: Partial<HubStreamFacts> = {}): HubStreamFacts => ({
  status, streamUrl: null, seaznLive: false, seaznPlayer: false, seaznParts: 0, youtubeParts: [], ...over,
});

let checked = 0;
const eachStatus = (fn: (status: string, key: ReturnType<typeof streamLinkLabelKey>) => void) => {
  for (const status of FIXTURE_STATUSES) {
    fn(status, streamLinkLabelKey(status));
    checked++;
  }
};

describe("hubStreamOf: the camera rule, over every fixture status", () => {
  it("PREMISE: the vocabulary has all three buckets the rule distinguishes (void, replayable, pre-match/live), so no sweep below is one-armed", () => {
    const keys = new Set(FIXTURE_STATUSES.map(streamLinkLabelKey));
    expect(keys).toEqual(new Set([null, "overlay.replay", "overlay.watchLive"]));
    expect(FIXTURE_STATUSES.length).toBeGreaterThanOrEqual(7);
  });

  it("EMPTY CASE FIRST: nothing known about a match is no camera, in every status", () => {
    checked = 0;
    eachStatus((status) => expect(hubStreamOf(base(status)), status).toBeUndefined());
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("a Seazn live session is LIVE in every status (the destination filter is the loader's, tested in the DB file), and beats every replay source", () => {
    checked = 0;
    eachStatus((status) => {
      expect(hubStreamOf(base(status, { seaznLive: true })), status).toBe("live");
      expect(
        hubStreamOf(base(status, { seaznLive: true, streamUrl: CLUB_LINK, seaznPlayer: true, seaznParts: 2, youtubeParts: [part(1)] })),
        `${status}: live beats replay`,
      ).toBe("live");
    });
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("the club's own link: in play is LIVE, a match that is over is REPLAY, a match not yet started or a void one is nothing", () => {
    checked = 0;
    eachStatus((status, key) => {
      const got = hubStreamOf(base(status, { streamUrl: CLUB_LINK }));
      if (key === null) expect(got, `${status} (void)`).toBeUndefined();
      else if (key === "overlay.replay") expect(got, `${status} (over)`).toBe("replay");
      else if (status === "in_play") expect(got, status).toBe("live");
      else expect(got, `${status} (not started)`).toBeUndefined();
      expect(hubStreamOf(base(status, { streamUrl: "" })), `${status}: an empty link is no link`).toBeUndefined();
      expect(hubStreamOf(base(status, { streamUrl: null })), `${status}: no link`).toBeUndefined();
    });
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("YouTube parts are REPLAY in every status the page lists them (all but void), and a void match shows nothing whatever is stored", () => {
    checked = 0;
    eachStatus((status, key) => {
      const got = hubStreamOf(base(status, { youtubeParts: [part(1), part(2)] }));
      expect(got, status).toBe(key === null ? undefined : "replay");
      // Parts beside the club's own link: the parts still decide, and in play the link says LIVE first (the page shows both).
      const both = hubStreamOf(base(status, { youtubeParts: [part(1)], streamUrl: CLUB_LINK }));
      expect(both, `${status} with a link`).toBe(key === null ? undefined : status === "in_play" ? "live" : "replay");
    });
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("a link that IS one of the parts is not a second reason: the part alone decides (never 'live' for an in-play match whose link is its own finished part)", () => {
    checked = 0;
    eachStatus((status, key) => {
      const own = youtubeWatchUrl("vid1");
      const got = hubStreamOf(base(status, { youtubeParts: [part(1, "vid1")], streamUrl: own }));
      expect(got, status).toBe(key === null ? undefined : "replay");
    });
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("Seazn island: its parts are REPLAY in EVERY status (the island lists them whatever the status, void included), and YouTube parts are hidden behind it", () => {
    checked = 0;
    eachStatus((status) => {
      expect(hubStreamOf(base(status, { seaznPlayer: true, seaznParts: 1 })), status).toBe("replay");
      // The island holds the slot: YouTube parts the page would otherwise list are not shown, so they are no camera.
      expect(hubStreamOf(base(status, { seaznPlayer: true, seaznParts: 0, youtubeParts: [part(1)] })), `${status}: parts hidden behind the island`).toBeUndefined();
      // Twin: without the island the same parts ARE the replay (unless void).
      expect(hubStreamOf(base(status, { seaznPlayer: false, youtubeParts: [part(1)] })), `${status}: twin`).toBe(streamLinkLabelKey(status) === null ? undefined : "replay");
    });
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("a Seazn fixture with nothing to play yet but a club link on a finished match still shows the link's replay (the page's pill is a button)", () => {
    checked = 0;
    eachStatus((status, key) => {
      const got = hubStreamOf(base(status, { seaznPlayer: true, seaznParts: 0, streamUrl: CLUB_LINK }));
      expect(got, status).toBe(key === "overlay.replay" ? "replay" : status === "in_play" ? "live" : undefined);
    });
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("the Seazn island's hidden YouTube part that IS the club's link: the page shows neither, so no camera", () => {
    checked = 0;
    eachStatus((status) => {
      const own = youtubeWatchUrl("vid1");
      expect(hubStreamOf(base(status, { seaznPlayer: true, seaznParts: 0, youtubeParts: [part(1, "vid1")], streamUrl: own })), status).toBeUndefined();
    });
    expect(checked).toBe(FIXTURE_STATUSES.length);
  });

  it("the answer is an enum: no address, uid or token can leave the rule", () => {
    const seen = new Set<string | undefined>();
    eachStatus((status) => {
      for (const seaznLive of [false, true]) for (const streamUrl of [null, CLUB_LINK]) {
        seen.add(hubStreamOf(base(status, { seaznLive, streamUrl, youtubeParts: [part(1)], seaznPlayer: true, seaznParts: 1 })));
      }
    });
    expect([...seen].sort()).toEqual(["live", "replay"]);
  });
});
