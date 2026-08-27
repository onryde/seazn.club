// RS007 — the public join page. Critical finding of the adversarial review:
// entry-card.tsx already emits links to this exact route
// (`/shared/<org>/<comp>/register/join?join_code=...`) and no page file
// existed — every claim link 404'd. This file covers page-level
// orchestration (the 404-shape, the roster-full designed state, and that
// the resolved preview's data actually reaches the picker) the same way
// register-page-live.test.tsx / register/status/status-page.test.tsx cover
// their own pages: renderToStaticMarkup, no jsdom in this workspace, mock
// the usecase not the DB. join-form-interaction.test.tsx covers the
// picker/WHO/CONSENT/submit behavior once mounted.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

const usecaseMock = vi.hoisted(() => ({ previewJoinEntry: vi.fn() }));
vi.mock("@/server/usecases/registration-submit", () => ({
  previewJoinEntry: (...args: unknown[]) => usecaseMock.previewJoinEntry(...args),
}));

beforeEach(() => {
  usecaseMock.previewJoinEntry.mockReset();
});

import RegisterJoinPage from "../page";

const render = async (searchParams: Record<string, string>): Promise<string> =>
  renderToStaticMarkup(
    await RegisterJoinPage({
      params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "summer-smash" }),
      searchParams: Promise.resolve(searchParams),
    }),
  );

const TEAM_PREVIEW = {
  registration_id: "reg-1",
  display_name: "Team Alpha",
  division_name: "Mixed Doubles",
  competition_name: "Summer Smash",
  competition_slug: "summer-smash",
  org_slug: "riverside",
  org_name: "Riverside CC",
  unclaimed_slots: [
    { player_id: "p1", full_name: "Sam Player" },
    { player_id: "p2", full_name: "Jordan Player" },
  ],
  allow_new_player: true,
  requires_dob: false,
  requires_gender: false,
  total_players: 3,
};

describe("register join page (RS007) — the URL entry-card.tsx already emits", () => {
  it("resolves (no 404) and renders the slot picker for a live join_code", async () => {
    usecaseMock.previewJoinEntry.mockResolvedValueOnce(TEAM_PREVIEW);
    const html = await render({ join_code: "JOIN123" });
    expect(html).toContain("Sam Player");
    expect(html).toContain("Jordan Player");
    expect(html).toContain("Which one are you?");
    expect(usecaseMock.previewJoinEntry).toHaveBeenCalledWith("JOIN123");
  });

  it("renders the context header naming the entry and division", async () => {
    usecaseMock.previewJoinEntry.mockResolvedValueOnce(TEAM_PREVIEW);
    const html = await render({ join_code: "JOIN123" });
    expect(html).toContain("Team Alpha");
    expect(html).toContain("Mixed Doubles");
  });

  describe("unknown/dead code — a designed state, never a raw 404, never leaking whether the code ever existed", () => {
    it("shows the designed invalid-link state when previewJoinEntry 404s", async () => {
      const { HttpError } = await import("@/lib/errors");
      usecaseMock.previewJoinEntry.mockRejectedValueOnce(new HttpError(404, "This join link is not valid"));
      const html = await render({ join_code: "SZ-DEAD-CODE" });
      expect(html).toContain("This join link isn&#x27;t valid");
      expect(html).not.toContain("Which one are you?");
    });

    it("shows the SAME designed state when join_code is missing entirely — never calls previewJoinEntry", async () => {
      const html = await render({});
      expect(html).toContain("This join link isn&#x27;t valid");
      expect(usecaseMock.previewJoinEntry).not.toHaveBeenCalled();
    });

    it("CRITICAL: the (dead) join_code itself never appears anywhere in the invalid-link page", async () => {
      const { HttpError } = await import("@/lib/errors");
      usecaseMock.previewJoinEntry.mockRejectedValueOnce(new HttpError(404, "This join link is not valid"));
      const html = await render({ join_code: "SUPER-SECRET-DEAD-CODE" });
      expect(html).not.toContain("SUPER-SECRET-DEAD-CODE");
    });

    it("lets a non-404 error propagate rather than masking it as an invalid link", async () => {
      usecaseMock.previewJoinEntry.mockRejectedValueOnce(new Error("db unreachable"));
      await expect(render({ join_code: "JOIN123" })).rejects.toThrow("db unreachable");
    });
  });

  describe("a pair — exactly one slot, no add-new option (owner ruling: claim-only, fixed at two)", () => {
    it("renders the single unclaimed slot and never offers 'I'm someone else'", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce({
        ...TEAM_PREVIEW,
        display_name: "Alex & Sam",
        unclaimed_slots: [{ player_id: "partner", full_name: "Sam Partner" }],
        allow_new_player: false,
        total_players: 2,
      });
      const html = await render({ join_code: "PAIR456" });
      expect(html).toContain("Sam Partner");
      expect(html).not.toContain("I&#x27;m someone else");
    });
  });

  describe("full roster — designed state, no form, no row inserted", () => {
    it("shows the designed full-roster state instead of the picker when nothing is left to claim or add", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce({
        ...TEAM_PREVIEW,
        unclaimed_slots: [],
        allow_new_player: false,
      });
      const html = await render({ join_code: "FULL789" });
      expect(html).toContain("This roster is already full");
      expect(html).not.toContain("Which one are you?");
      // Still shows the (known, already-public) context — this is a live
      // link, not the unknown/dead-code case.
      expect(html).toContain("Team Alpha");
    });

    it("does NOT show the full-roster state when slots remain, even with allow_new_player false (the pair shape)", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce({
        ...TEAM_PREVIEW,
        unclaimed_slots: [{ player_id: "p1", full_name: "Sam Player" }],
        allow_new_player: false,
      });
      const html = await render({ join_code: "PAIR456" });
      expect(html).not.toContain("This roster is already full");
      expect(html).toContain("Which one are you?");
    });

    it("does NOT show the full-roster state when no slots remain but add-new is still offered", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce({
        ...TEAM_PREVIEW,
        unclaimed_slots: [],
        allow_new_player: true,
      });
      const html = await render({ join_code: "JOIN123" });
      expect(html).not.toContain("This roster is already full");
      expect(html).toContain("Which one are you?");
    });
  });

  // RS007/V380 defect #3 — the wizard's custom rule was written and shown
  // nowhere. eligibility_note is now rendered here too, same organiser-
  // speaking template as the main register page's DivisionCard.
  describe("the organiser's eligibility_note (RS007/V380 defect #3)", () => {
    it("renders the note, interpolated into the organiser-speaking template", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce({
        ...TEAM_PREVIEW,
        eligibility_note: "School-registered students only",
      });
      const html = await render({ join_code: "JOIN123" });
      expect(html).toContain("From the organiser: School-registered students only");
    });

    it("renders nothing when the division has no note set", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce({ ...TEAM_PREVIEW, eligibility_note: null });
      const html = await render({ join_code: "JOIN123" });
      expect(html).not.toContain("From the organiser");
    });

    it("still renders even in the full-roster designed state — general division info, not conditional on a slot being left", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce({
        ...TEAM_PREVIEW,
        unclaimed_slots: [],
        allow_new_player: false,
        eligibility_note: "School-registered students only",
      });
      const html = await render({ join_code: "FULL789" });
      expect(html).toContain("This roster is already full");
      expect(html).toContain("From the organiser: School-registered students only");
    });
  });

  describe("per-slot pre-selection (a per-slot claim link arrives with that slot pre-selected)", () => {
    it("the requested player_id's radio starts checked, and the others do not", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce(TEAM_PREVIEW);
      const html = await render({ join_code: "JOIN123", player_id: "p2" });
      // p2's row: checked. p1's row: not checked. Scoped by proximity to
      // each player's own name so this can't pass by matching the WRONG
      // radio (e.g. a stray "I'm someone else" input).
      const p2Index = html.indexOf("Jordan Player");
      const p1Index = html.indexOf("Sam Player");
      expect(html.lastIndexOf('type="radio"', p2Index)).toBeGreaterThan(-1);
      expect(html.slice(html.lastIndexOf("<input", p2Index), p2Index)).toContain('checked=""');
      expect(html.slice(html.lastIndexOf("<input", p1Index), p1Index)).not.toContain('checked=""');
    });

    it("still lets the joiner change the selection — the picker is a live radio group, not locked to the requested id", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce(TEAM_PREVIEW);
      const html = await render({ join_code: "JOIN123", player_id: "p2" });
      const p1Index = html.indexOf("Sam Player");
      const p1Input = html.slice(html.lastIndexOf("<input", p1Index), p1Index);
      expect(p1Input).toContain('type="radio"');
      expect(p1Input).not.toContain("disabled");
    });

    it("ignores a requested player_id that does not match any unclaimed slot — no radio pre-checked, no distinct error", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce(TEAM_PREVIEW);
      const html = await render({ join_code: "JOIN123", player_id: "not-a-real-slot" });
      expect(html).not.toContain('checked=""');
    });
  });
});
