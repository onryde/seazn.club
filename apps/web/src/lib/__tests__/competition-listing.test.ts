// `competitionIsListed` / `linkOnlyRobots` — owner decision 2026-09-27: a
// draft competition is unlisted until published. Enumerated over the SCHEMA's
// own status and visibility enums (never a table typed here), so a status
// added later is classified by the rule, not silently by a stale list.
import { describe, expect, it } from "vitest";
import { CompetitionStatus, Visibility } from "@/server/api-v1/schemas";
import {
  competitionIsListed,
  competitionReach,
  linkOnlyRobots,
  NEW_COMPETITION_STATUS,
  PUBLICLY_READABLE_VISIBILITIES,
  publishWouldList,
  UNLISTED_STATUS,
} from "../competition-listing";

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

// "Who will find it" (Match Day C8): the New competition form lists WHO can
// reach the competition being made, and that list may not be a table typed into
// the form. `competitionReach` answers from the rules above — the audience and
// the status a new competition is born with are the only inputs.
//
// The expected values here are the three predicates above, called on the same
// competition; the DB oracle (server/usecases/__tests__/competition-reach-db
// .test.ts) is what holds those predicates to the real listing queries.
describe("competitionReach", () => {
  const DISCOVERABLE = [false, true];

  it("every audience row reads the rule it names, over the schema's own enums", () => {
    let checked = 0;
    for (const visibility of VISIBILITIES) {
      for (const status of STATUSES) {
        for (const discoverable of DISCOVERABLE) {
          const c = { visibility, status, discoverable };
          const reach = competitionReach(c);
          const listing = { visibility, status };
          const listedState = competitionIsListed(listing) ? "yes" : publishWouldList(listing) ? "after_publish" : "no";
          expect(reach.team, "the team always sees its own competition").toBe("yes");
          expect(reach.link, `link ${visibility}/${status}`).toBe(
            (PUBLICLY_READABLE_VISIBILITIES as readonly string[]).includes(visibility) ? "yes" : "no",
          );
          expect(reach.org, `org ${visibility}/${status}`).toBe(listedState);
          // Search reads the page's own robots value, not the listing rule: the
          // two must agree, and this is where a divergence would show.
          const indexable = linkOnlyRobots(listing).robots === undefined;
          expect(reach.search, `search ${visibility}/${status}`).toBe(
            indexable ? "yes" : listedState === "after_publish" ? "after_publish" : "no",
          );
          // Showcase is opt-in AND public AND listed.
          expect(reach.showcase, `showcase ${visibility}/${status}/${discoverable}`).toBe(
            discoverable && visibility === "public" ? listedState : "no",
          );
          checked += 1;
        }
      }
    }
    // Anti-vacuity: 3 visibilities x 5 statuses x 2 showcase states.
    expect(checked).toBe(VISIBILITIES.length * STATUSES.length * DISCOVERABLE.length);
    expect(checked).toBeGreaterThan(20);
  });

  it("a NEW competition (draft): public lists after publishing, link-only is reachable now, private is the team alone", () => {
    const born = (visibility: string, discoverable = false) =>
      competitionReach({ visibility, status: NEW_COMPETITION_STATUS, discoverable });
    expect(born("private")).toEqual({
      team: "yes", link: "no", org: "no", search: "no", showcase: "no",
    });
    expect(born("unlisted")).toEqual({
      team: "yes", link: "yes", org: "no", search: "no", showcase: "no",
    });
    expect(born("public")).toEqual({
      team: "yes", link: "yes", org: "after_publish", search: "after_publish", showcase: "no",
    });
    expect(born("public", true)).toEqual({
      team: "yes", link: "yes", org: "after_publish", search: "after_publish", showcase: "after_publish",
    });
  });

  it("showcase never outlives public visibility, even if the flag is still set", () => {
    for (const visibility of VISIBILITIES.filter((v) => v !== "public")) {
      expect(competitionReach({ visibility, status: "published", discoverable: true }).showcase, visibility).toBe("no");
    }
  });

  it("a published public competition is reachable everywhere it can be", () => {
    expect(competitionReach({ visibility: "public", status: "published", discoverable: true })).toEqual({
      team: "yes", link: "yes", org: "yes", search: "yes", showcase: "yes",
    });
  });
});
