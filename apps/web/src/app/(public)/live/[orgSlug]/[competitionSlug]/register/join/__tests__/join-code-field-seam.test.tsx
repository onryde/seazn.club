// Polish wave P6 - the seam between the public register page's "Have a join code?" field and the join page it sends people to. The field
// (components/public-site/register/join-code-entry.tsx) and the page (../page.tsx) are each green on their own; what could be wrong is the
// hand-over: the href the field's real submit handler produces has to carry the code under the name the page reads, normalised the way the
// lookup expects, and the page's own throttle and "not valid" answer must be the ONLY thing that decides what a typed code gets - so a
// code that is live, dead or junk is told apart by nothing the field adds (no second oracle).
//
// The field is driven through its real handler (hook harness, `next/navigation`'s router recorded), the page through its real default
// export (renderToStaticMarkup, the usecase mocked, the same rig as join-page.test.tsx).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { JoinCodeEntry } from "@/components/public-site/register/join-code-entry";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

const nav = vi.hoisted(() => ({ push: vi.fn<(href: string) => void>() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

const usecaseMock = vi.hoisted(() => ({ previewJoinEntry: vi.fn() }));
vi.mock("@/server/usecases/registration-submit", () => ({
  previewJoinEntry: (...args: unknown[]) => usecaseMock.previewJoinEntry(...args),
}));

const rateLimitMock = vi.hoisted(() => ({ throttle: false }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    rateLimit: async (...args: Parameters<typeof actual.rateLimit>) => {
      if (rateLimitMock.throttle) {
        const { HttpError } = await import("@/lib/errors");
        throw new HttpError(429, "Too many requests - slow down and try again.");
      }
      return actual.rateLimit(...args);
    },
  };
});

import RegisterJoinPage from "../page";

beforeEach(() => {
  nav.push.mockReset();
  usecaseMock.previewJoinEntry.mockReset();
  rateLimitMock.throttle = false;
});

/** Type `value` into the real field, submit it, and return the href its router was sent to (null when it went nowhere). */
function submitTyped(value: string): string | null {
  nav.push.mockReset();
  const island = renderIsland(JoinCodeEntry, { orgSlug: "riverside", competitionSlug: "summer-smash" });
  const tree = () => island.tree();
  (propsOf(tree().find((e) => e.type === "input")!).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  (propsOf(tree().find((e) => e.type === "form")!).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  return nav.push.mock.calls[0]?.[0] ?? null;
}

/** Open the href the way the browser does: the page the path names, its search params as the page receives them. */
async function openJoinPage(href: string): Promise<string> {
  const url = new URL(href, "https://seazn.test");
  const [, , orgSlug, competitionSlug] = url.pathname.split("/");
  return renderToStaticMarkup(
    await RegisterJoinPage({
      params: Promise.resolve({ orgSlug: orgSlug!, competitionSlug: competitionSlug! }),
      searchParams: Promise.resolve(Object.fromEntries(url.searchParams)),
    }),
  );
}

const PREVIEW = {
  registration_id: "reg-1",
  display_name: "Team Alpha",
  division_name: "Mixed Doubles",
  competition_name: "Summer Smash",
  competition_slug: "summer-smash",
  org_slug: "riverside",
  org_name: "Riverside CC",
  entrant_kind: "team" as const,
  unclaimed_slots: [{ player_id: "p1", full_name: "Sam Player" }],
  allow_new_player: true,
  requires_dob: false,
  requires_gender: false,
  total_players: 2,
};

describe("the field -> the join page", () => {
  it("a code typed any way a person writes it reaches the page's lookup as the ONE stored form, and a live code opens its join page", async () => {
    const typed = ["SZ-ABCD-EF23", "sz-abcd-ef23", " sz abcd ef23 ", "abcdef23"];
    let checked = 0;
    for (const value of typed) {
      usecaseMock.previewJoinEntry.mockReset();
      usecaseMock.previewJoinEntry.mockResolvedValueOnce(PREVIEW);
      const href = submitTyped(value);
      expect(href, `${value}: the field navigated`).not.toBeNull();
      const html = await openJoinPage(href!);
      expect(usecaseMock.previewJoinEntry, value).toHaveBeenCalledTimes(1);
      expect(usecaseMock.previewJoinEntry, value).toHaveBeenCalledWith("SZ-ABCD-EF23");
      expect(html, `${value}: the live code opens the picker, not the invalid state`).toContain("Which one are you?");
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(typed.length);
  });

  it("a dead code and a junk value get the SAME answer (the page's one 'not valid'), and neither is the live code's page", async () => {
    const { HttpError } = await import("@/lib/errors");
    const answers: string[] = [];
    for (const value of ["SZ-DEAD-CODE", "not a code at all", "<script>x</script>"]) {
      usecaseMock.previewJoinEntry.mockReset();
      usecaseMock.previewJoinEntry.mockRejectedValueOnce(new HttpError(404, "This join link is not valid"));
      answers.push(await openJoinPage(submitTyped(value)!));
    }
    expect(new Set(answers).size, "one answer for every non-live value").toBe(1);
    expect(answers[0]).toContain("This join link isn&#x27;t valid");
    usecaseMock.previewJoinEntry.mockResolvedValueOnce(PREVIEW);
    const live = await openJoinPage(submitTyped("SZ-ABCD-EF23")!);
    expect(live, "premise: a live code is told apart by the page, not by the field").not.toBe(answers[0]);
  });

  it("once the page throttles, every typed value gets the throttled answer and no lookup runs - a live code included", async () => {
    rateLimitMock.throttle = true;
    const answers: string[] = [];
    for (const value of ["SZ-ABCD-EF23", "SZ-DEAD-CODE", "junk"]) {
      usecaseMock.previewJoinEntry.mockResolvedValue(PREVIEW);
      answers.push(await openJoinPage(submitTyped(value)!));
    }
    expect(new Set(answers).size, "identical for live, dead and junk").toBe(1);
    expect(answers[0]).toContain("Too many attempts");
    expect(usecaseMock.previewJoinEntry, "a throttled visit never reaches the lookup").not.toHaveBeenCalled();
  });

  it("a blank entry never reaches the page at all", () => {
    expect(submitTyped("   ")).toBeNull();
    expect(usecaseMock.previewJoinEntry).not.toHaveBeenCalled();
  });
});
