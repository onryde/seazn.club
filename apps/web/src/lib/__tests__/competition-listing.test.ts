// `competitionIsListed` / `linkOnlyRobots` — owner decision 2026-09-27: a
// draft competition is unlisted until published. Enumerated over the SCHEMA's
// own status and visibility enums (never a table typed here), so a status
// added later is classified by the rule, not silently by a stale list.
import { describe, expect, it } from "vitest";
import { CompetitionStatus, Visibility } from "@/server/api-v1/schemas";
import { competitionIsListed, linkOnlyRobots, UNLISTED_STATUS } from "../competition-listing";

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
