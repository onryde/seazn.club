// W5 app-A Task 23 (RB5-W2; B5 merge finding, owner "fix now"): the hub's Matches card read "Ended" over a leaver's line that a
// withdrawal under half EXPUNGED — a match that will not be played, whose result (if any) no longer counts. It now reads as the
// public schedule reads it (27eddf373f): both names struck, no time and no score, "Abandoned" in the status slot — one
// presentation, never a third. The flag crosses the cached hub document (zod `HubMatch`), so the round trip is part of the seam:
// a field the schema does not declare is stripped from every cached read.
//
// Words are the real en public.json. Single-sport by nature: the card reads the flag alone.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("next/cache", () => ({ unstable_cache: (fn: (...args: unknown[]) => unknown) => fn, revalidateTag: vi.fn(), revalidatePath: vi.fn() }));

import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { HubMatch, type HubMatchT } from "@/server/public-site/competition-hub-schema";
import { MatchCard } from "../matches-hub/match-card";

const DICT = en as unknown as Dict;
const ABANDONED = t(DICT, "matchCentre.status.abandoned");
const ENDED = t(DICT, "matchesHub.ended");

function match(over: Partial<HubMatchT>): HubMatchT {
  return {
    fixtureId: "f1", divisionId: "d1", divisionSlug: "d", divisionName: "Division", sportKey: "badminton", stageName: "League",
    roundNo: 3, roundLabel: null, bucket: "completed", tz: "UTC", scheduledAt: "2026-11-18T10:00:00.000Z", venueName: null, courtName: null,
    href: "/x/f1",
    header: {
      live: false, status: "other",
      sides: [
        { entrantId: "h", name: "Westgate Wanderers Badminton Club", short: "WES", colour: null, badgeUrl: null },
        { entrantId: "a", name: "Ivy", short: "IVY", colour: null, badgeUrl: null },
      ],
      scoreLines: ["21", "15"], subLines: [null, null], battingIndex: null, statusLine: null, rateLine: null, phase: null, strength: null,
      pillNote: null, metaLine: null, updatedAt: "2026-11-18T12:00:00.000Z",
    },
    winnerIndex: 0,
    resultLine: "Westgate Wanderers won 21–15",
    forfeit: null,
    ...over,
  } as HubMatchT;
}
const card = (m: HubMatchT) => renderToStaticMarkup(createElement(MatchCard, { match: m, dict: DICT, locale: "en", now: 0 }));
const slot = (html: string) => {
  const m = /<span class="ml-auto shrink-0">(.*?)<\/span><\/div>/.exec(html);
  expect(m, "the card renders its status slot").not.toBeNull();
  return m![1]!.replace(/<[^>]+>/g, "");
};

describe("the hub card of an expunged leaver's line (RB5-W2)", () => {
  it("the flag survives the cached document's schema (the producer -> cache -> card seam)", () => {
    expect(HubMatch.parse(match({ expunged: true })).expunged).toBe(true);
    expect(HubMatch.parse(match({})).expunged, "a document without it reads as not expunged").toBeUndefined();
  });

  it("struck, no score, no result, 'Abandoned' in the status slot — never 'Ended'", () => {
    const html = card(HubMatch.parse(match({ expunged: true })));
    expect(slot(html)).toBe(ABANDONED);
    expect(html).toContain('data-expunged="true"');
    const names = [...html.matchAll(/<span class="([^"]*)" title="([^"]+)">/g)];
    expect(names.map((n) => n[2])).toEqual(["Westgate Wanderers Badminton Club", "Ivy"]);
    expect(names.every((n) => n[1]!.split(" ").includes("line-through")), "both names struck").toBe(true);
    expect(html, "no score").not.toMatch(/>21<|>15</);
    expect(html, "no result line").not.toContain('data-testid="mh-match-result"');
  });

  it("an upcoming expunged line shows no time either; the empty case — not expunged — is the ordinary card", () => {
    const upcoming = card(match({ expunged: true, bucket: "upcoming", winnerIndex: null, resultLine: null }));
    expect(slot(upcoming)).toBe(ABANDONED);
    expect(upcoming).not.toContain('data-testid="mh-match-starts"');

    const plain = card(match({}));
    expect(slot(plain)).toBe(ENDED);
    expect(plain).not.toContain("data-expunged");
    expect(plain).not.toContain("line-through");
    expect(plain).toContain('data-testid="mh-match-result"');
  });
});
