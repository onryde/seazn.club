// Fix round 3 (controller ruling: fix inline) — /me names the player's own side first, but printed the stored score
// home-first, so a walkover Pat won as the away side read "Pat vs Ravens 0 — 2". Each results line now reads its score
// from the player's side (`headlineFrom`, lib/headline-from.ts — swept over the sport registry in its own test). Rows:
// the player home and away, a played result and a walkover; one stored "0 — 2" whose right reading differs from the
// stored string; and a headline in no known shape, which keeps the stored order for the names instead. The page is
// rendered whole, its reads mocked; the producer leg (`player_home` off the real query) is the DB scene.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { MyResult } from "@/server/usecases/me";
import { msgFor } from "@/lib/messages-i18n";

const locale = vi.hoisted(() => ({ current: "en" as "en" | "fr" }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/me",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: "u1", email: "player@example.com", display_name: "Pat" }),
  getActiveOrgId: async () => null,
  getUserOrgs: async () => [],
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => locale.current }));

const result = (id: string, entrant: string, opponent: string, playerHome: boolean, headline: string, outcome: unknown): MyResult => ({
  id, fixture_no: 1, competition_name: "Cup", competition_slug: "cup", competition_visibility: "public",
  division_name: "Open", division_slug: "open", org_name: "Club", org_slug: "club",
  entrant_name: entrant, opponent_name: opponent, player_home: playerHome, scheduled_at: null,
  // `MyResult.summary` is typed `string | null`, but the jsonb column arrives as the object the page reads.
  summary: { headline } as unknown as MyResult["summary"], outcome,
  home_entrant_id: null, away_entrant_id: null, abandon_reason: null,
});
const WIN = (w: string) => ({ kind: "win", winner: w });
const WO = (w: string, l: string) => ({ kind: "award", winner: w, loser: l, reason: "walkover" });
/** Loop R M-11: a walkover's turned score is followed by its house tag (me-page-results-forfeit.test.tsx pins the tag
 *  itself; here it only rides along after the score this test is about). */
const WO_TAG = msgFor("en", "forfeit.tag.walkover");
/** Each row: the player's side, the stored (home-first) headline, and what the player's line must read. */
const ROWS = [
  // Home: the stored order IS her order.
  { r: result("h-played", "Owls", "Ravens", true, "2 — 0 · 21–10, 21–12", WIN("e-owls")), names: ["Owls", "Ravens"], score: "2 — 0 · 21–10, 21–12" },
  { r: result("h-wo", "Kites", "Crows", true, "2 — 0", WO("e-kites", "e-crows")), names: ["Kites", "Crows"], score: `2 — 0${WO_TAG}` },
  // Away: a walkover she won is stored "0 — 2" — the defect read exactly that beside her name.
  { r: result("a-wo", "Lions", "Tigers", false, "0 — 2", WO("e-lions", "e-tigers")), names: ["Lions", "Tigers"], score: `2 — 0${WO_TAG}` },
  // Away, played, lost: the heads and every set turn, the tiebreak loser's points stay bracketed.
  { r: result("a-played", "Wrens", "Herons", false, "2 — 1 · 6–3 6–7(3) 7–6(5)", WIN("e-herons")), names: ["Wrens", "Herons"], score: "1 — 2 · 3–6 7–6(3) 6–7(5)" },
  // Away, a stored headline in no known shape: never guessed — the names take the stored (home-first) order instead.
  { r: result("a-odd", "Swifts", "Gulls", false, "Abandoned", null), names: ["Gulls", "Swifts"], score: "Abandoned" },
  // Away, a double walkover: no score to turn — her side first, the house tag (re-review N-1).
  { r: result("a-dw", "Robins", "Jays", false, "0 — 0", { kind: "double_walkover" }), names: ["Robins", "Jays"], score: msgFor("en", "forfeit.tag.doubleWalkover") },
];
const RESULTS: MyResult[] = ROWS.map((x) => x.r);

vi.mock("@/server/usecases/me", () => ({
  listMyFixtures: async () => ({ upcoming: [], results: RESULTS, teams: [] }),
  getMySuspensions: async () => [],
  listMyPersons: async () => [],
  listMyPlayerStats: async () => [],
  listMyCareerStats: async () => [],
}));
vi.mock("@/server/usecases/me-officiating", () => ({
  getMyOfficiating: async () => ({ is_official: false, assignments: [], completed: [], blackouts: [] }),
  listPendingOfficiatingClaims: async () => [],
}));
vi.mock("@/server/usecases/official-marks", () => ({ myMarksAverage: async () => null }));
// page.tsx reads the Lichess card (chess T16) beside the lanes; nothing to link here, and no DB in CI's test job.
vi.mock("@/server/usecases/me-lichess", () => ({
  myLichessLink: async () => ({ show: false, linkedUsername: null, needsReconsent: false, orgSlug: null }),
}));

const { default: MePage } = await import("../page");

/** Each results line's text: its two names in printed order and its score cell's text. */
async function lines(): Promise<Record<string, { names: string[]; score: string }>> {
  const html = renderToStaticMarkup((await MePage({ searchParams: Promise.resolve({}) })) as ReactElement);
  const lis = [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]);
  const out: Record<string, { names: string[]; score: string }> = {};
  for (const { r } of ROWS) {
    const li = lis.find((x) => x.includes(`>${r.entrant_name}`) || x.includes(` ${r.entrant_name}<`) || x.includes(`>${r.entrant_name} <`));
    if (!li) throw new Error(`no results line for ${r.entrant_name}`);
    const title = /<p class="truncate text-sm font-medium text-slate-800">([\s\S]*?)<\/p>/.exec(li)?.[1] ?? "";
    const text = title.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const names = [r.entrant_name!, r.opponent_name!].sort((a, b) => text.indexOf(a) - text.indexOf(b));
    const cell = /<span\b[^>]*\bclass="[^"]*\bapp-display\b[^"]*"[^>]*>((?:[^<]|<span\b[^>]*>[^<]*<\/span>)*)<\/span>/.exec(li)?.[1] ?? "";
    out[r.id] = { names, score: cell.replace(/<[^>]+>/g, "") };
  }
  return out;
}

describe("/me results — the score reads from the player's side, as the names do (fix round 3)", () => {
  it("home and away, played and walkover: names and score in one order; a shape it cannot turn keeps the stored order", async () => {
    const got = await lines();
    let checked = 0;
    for (const { r, names, score } of ROWS) {
      expect(got[r.id], `${r.id}: the line`).toEqual({ names, score });
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    // The case that tells the two readings apart: the stored string itself is the wrong answer.
    expect(got["a-wo"]!.score, "a-wo: never the stored home-first 0 — 2").not.toBe("0 — 2");
  });
});
