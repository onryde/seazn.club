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

// RS007 follow-up: the page's own per-IP rate limit over previewJoinEntry.
// The real limiter is inert without REDIS_URL (unset in this environment),
// so a throttle is forced deterministically via this mock rather than
// relying on the real one. This ALSO doubles as proof the page's own
// `headers()` read is safely guarded: this suite calls RegisterJoinPage
// directly (renderToStaticMarkup, no real Next.js request — see
// resolve-locale.ts's identical "outside a request scope" guard), so if
// that guard were missing every test touching a join_code below would
// throw synchronously the moment this mock is exercised.
const rateLimitMock = vi.hoisted(() => ({ throttle: false }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    rateLimit: async (...args: Parameters<typeof actual.rateLimit>) => {
      if (rateLimitMock.throttle) {
        const { HttpError } = await import("@/lib/errors");
        throw new HttpError(429, "Too many requests — slow down and try again.");
      }
      return actual.rateLimit(...args);
    },
  };
});

beforeEach(() => {
  usecaseMock.previewJoinEntry.mockReset();
  rateLimitMock.throttle = false;
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

  // RS007 follow-up: join_code is a generateRefCode() value (30^6 ≈ 729M,
  // lib/ref-code.ts) and this preview renders real roster names — an
  // unthrottled server-rendered page over that space is a PII enumeration
  // surface. Hard requirement: a throttled response must be indistinguishable
  // from any OTHER throttled response in status AND body, regardless of
  // whether the code behind it is dead, wrong, missing, or genuinely live —
  // a throttle response that varied with code validity would itself be a
  // new oracle (confirms an IP has crossed the threshold, and worse, a
  // DIFFERENT throttle message on an otherwise-live code would leak that
  // the code would have worked).
  //
  // RS007 review defect #15 (MEDIUM, fixed here): the throttled state used
  // to reuse the invalid-link copy VERBATIM, so a throttled teammate was
  // told their link was dead. The oracle-proof property above still holds —
  // it just no longer requires lying that the link doesn't exist.
  describe("client-IP rate limit — must not become a new oracle, and must not lie that the link is dead either (defect #15)", () => {
    it("renders the DISTINCT throttled state, never the invalid-link copy, and never calls previewJoinEntry", async () => {
      rateLimitMock.throttle = true;
      const html = await render({ join_code: "SZ-DEAD-CODE" });

      expect(html).toContain("Too many attempts");
      expect(html).not.toContain("This join link isn&#x27;t valid");
      expect(usecaseMock.previewJoinEntry).not.toHaveBeenCalled();
    });

    it("the throttled state is byte-identical for a dead code and a genuinely LIVE one — still never a new oracle", async () => {
      const { HttpError } = await import("@/lib/errors");
      usecaseMock.previewJoinEntry.mockRejectedValueOnce(new HttpError(404, "This join link is not valid"));
      rateLimitMock.throttle = true;
      const deadCodeHtml = await render({ join_code: "SZ-DEAD-CODE" });

      // Configured to succeed if reached — proves the limiter itself hides
      // this, not an incidental lookup failure.
      usecaseMock.previewJoinEntry.mockResolvedValueOnce(TEAM_PREVIEW);
      rateLimitMock.throttle = true;
      const liveCodeHtml = await render({ join_code: "JOIN123" });

      expect(deadCodeHtml).toBe(liveCodeHtml);
      expect(usecaseMock.previewJoinEntry).not.toHaveBeenCalled();
    });

    it("hides even a GENUINELY LIVE code — never leaks that the code would have worked", async () => {
      usecaseMock.previewJoinEntry.mockResolvedValueOnce(TEAM_PREVIEW);
      rateLimitMock.throttle = true;

      const html = await render({ join_code: "JOIN123" });

      expect(html).toContain("Too many attempts");
      expect(html).not.toContain("Team Alpha");
      expect(html).not.toContain("Which one are you?");
      expect(usecaseMock.previewJoinEntry).not.toHaveBeenCalled();
    });

    it("a bare visit with no join_code never consults the limiter at all — matches the existing 'never calls previewJoinEntry' contract, and falls back to the invalid-link state (never throttled — there was never a code to throttle)", async () => {
      rateLimitMock.throttle = true; // even so — the limiter must never fire without a code to look up
      const html = await render({});
      expect(html).toContain("This join link isn&#x27;t valid");
      expect(html).not.toContain("Too many attempts");
      expect(usecaseMock.previewJoinEntry).not.toHaveBeenCalled();
    });
  });
});
