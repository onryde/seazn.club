// `competitionIsListed` / `linkOnlyRobots` — owner decision 2026-09-27: a
// draft competition is unlisted until published. Enumerated over the SCHEMA's
// own status and visibility enums (never a table typed here), so a status
// added later is classified by the rule, not silently by a stale list.
import { describe, expect, it } from "vitest";
import { CompetitionStatus, Visibility } from "@/server/api-v1/schemas";
import { competitionIsListed, linkOnlyRobots, publishWouldList, UNLISTED_STATUS } from "../competition-listing";

const STATUSES = CompetitionStatus.options;
const VISIBILITIES = Visibility.options;

describe("competitionIsListed", () => {
  it("premise: the schema's status enum contains the draft status this rule names, and more than it", () => {
    expect(STATUSES).toContain(UNLISTED_STATUS);
    expect(STATUSES.length).toBeGreaterThan(1);
  });

  it("a PUBLIC competition is listed in every status but draft — archived and completed included", () => {
    const unlisted = STATUSES.filter((status) => !competitionIsListed({ visibility: "public", status }));
    expect(unlisted).toEqual(["draft"]);
    expect(competitionIsListed({ visibility: "public", status: "archived" })).toBe(true);
    expect(competitionIsListed({ visibility: "public", status: "published" })).toBe(true);
  });

  it("an unlisted or private competition is never listed, in any status", () => {
    for (const visibility of VISIBILITIES.filter((v) => v !== "public")) {
      for (const status of STATUSES) {
        expect(competitionIsListed({ visibility, status }), `${visibility}/${status}`).toBe(false);
      }
    }
  });
});

describe("linkOnlyRobots", () => {
  it("a public DRAFT gets the unlisted page's robots value — noindex, nofollow", () => {
    expect(linkOnlyRobots({ visibility: "public", status: "draft" })).toEqual({
      robots: { index: false, follow: false },
    });
    expect(linkOnlyRobots({ visibility: "unlisted", status: "published" })).toEqual({
      robots: { index: false, follow: false },
    });
  });

  it("a listed competition gets NO robots key at all (the default: indexable), not an explicit index:true", () => {
    expect(linkOnlyRobots({ visibility: "public", status: "published" })).toEqual({});
    expect(linkOnlyRobots({ visibility: "public", status: "archived" })).toEqual({});
  });
});

// The organiser-facing nudges — the settings hint under Status and the note in
// the Start-tournament confirmation — both say "not listed … until you
// publish". That sentence is true for exactly the competitions publishing
// would LIST, so the predicate is derived from the listing rule itself rather
// than from a second hand-written condition.
describe("publishWouldList", () => {
  it("is true exactly when the competition is unlisted now and publishing it would list it", () => {
    for (const visibility of VISIBILITIES) {
      for (const status of STATUSES) {
        const c = { visibility, status };
        const expected = !competitionIsListed(c) && competitionIsListed({ ...c, status: "published" });
        expect(publishWouldList(c), `${visibility}/${status}`).toBe(expected);
      }
    }
  });

  it("non-vacuity: that is ONE pair — a public draft — and not a private or unlisted one", () => {
    const hits = VISIBILITIES.flatMap((visibility) =>
      STATUSES.filter((status) => publishWouldList({ visibility, status })).map((status) => `${visibility}/${status}`),
    );
    expect(hits).toEqual(["public/draft"]);
  });
});
