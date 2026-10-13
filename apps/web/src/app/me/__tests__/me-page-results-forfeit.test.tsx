// Design re-review N-1 — the player's /me results list printed each finalized match's stored headline, and a double
// walkover's stored summary carries a 0 — 0 (the console can finalize a decided double walkover). It credits nobody, so
// the line prints the house tag instead, muted, its symbol named by the full words, as every other host does
// (`creditsNobody`, lib/forfeit-tag.ts). The pair: a one-sided walkover keeps its credited score, and a played match its
// result. fr is the locale whose tag differs from en ("2× forf." vs "2× w/o"), so a typed English tag cannot pass it.
// The page is rendered whole, its reads mocked; the producer leg (a real finalize, the real `listMyFixtures` row) is
// `server/__tests__/double-walkover-hosts-db.test.ts`.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { msgFor } from "@/lib/messages-i18n";
import type { MyResult } from "@/server/usecases/me";

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

const result = (id: string, entrant: string, opponent: string, headline: string, outcome: unknown): MyResult => ({
  id, fixture_no: 1, competition_name: "Cup", competition_slug: "cup", competition_visibility: "public",
  division_name: "Open", division_slug: "open", org_name: "Club", org_slug: "club",
  // `MyResult.summary` is typed `string | null`, but the column is jsonb and arrives as the object the page casts it to
  // (`page.tsx` `headline()`); the DB scene's real row has the same shape.
  entrant_name: entrant, opponent_name: opponent, player_home: true, scheduled_at: null, summary: { headline } as unknown as MyResult["summary"], outcome,
});
const RESULTS: MyResult[] = [
  result("dw", "Falcons", "Hawks", "0 — 0", { kind: "double_walkover" }),
  result("wo", "Owls", "Ravens", "3 — 0", { kind: "award", winner: "e-owls", loser: "e-ravens", reason: "walkover" }),
  result("won", "Lions", "Tigers", "2 — 1", { kind: "win", winner: "e-lions" }),
];

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

const { default: MePage } = await import("../page");

interface Score {
  /** The cell's visible text, tags stripped. */
  text: string;
  /** The cell's own classes (the `app-display` span). */
  cls: string[];
  /** The symbol inside the cell, when there is one: its role, accessible name and classes. */
  symbol: { role: string | null; label: string | null; cls: string[] } | null;
  li: string;
}

/** Each result line's score cell — the `app-display` span in the `<li>` that names `entrant` — and the line itself. */
async function scores(at: "en" | "fr"): Promise<Record<string, Score>> {
  locale.current = at;
  const html = renderToStaticMarkup((await MePage({ searchParams: Promise.resolve({}) })) as ReactElement);
  const out: Record<string, Score> = {};
  for (const r of RESULTS) {
    const li = [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]).find((x) => x.includes(`>${r.entrant_name} <`));
    if (!li) throw new Error(`${at}: no results line for ${r.entrant_name}`);
    // The cell: the `app-display` span, holding either the headline text or ONE inner symbol span.
    const cells = [...li.matchAll(/<span\b([^>]*\bclass="[^"]*\bapp-display\b[^"]*"[^>]*)>((?:[^<]|<span\b[^>]*>[^<]*<\/span>)*)<\/span>/g)];
    if (cells.length !== 1) throw new Error(`${at}: ${r.entrant_name}'s line has ${cells.length} score cells, wanted 1`);
    const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const inner = cells[0]![2]!;
    const sym = /^<span\b([^>]*)>[^<]*<\/span>$/.exec(inner);
    out[r.id] = {
      text: inner.replace(/<[^>]+>/g, ""),
      cls: (attr(cells[0]![1]!, "class") ?? "").split(/\s+/),
      symbol: sym ? { role: attr(sym[1]!, "role"), label: attr(sym[1]!, "aria-label"), cls: (attr(sym[1]!, "class") ?? "").split(/\s+/) } : null,
      li,
    };
  }
  return out;
}

describe("/me results — a double walkover prints its tag, never the stored 0 — 0 (re-review N-1)", () => {
  for (const at of ["en", "fr"] as const) {
    it(`${at}: the double walkover's cell is the tag, muted and named; the walkover and the played match keep their scores`, async () => {
      const tag = msgFor(at, "forfeit.tag.doubleWalkover");
      const full = msgFor(at, "forfeit.tagFull.doubleWalkover");
      if (at === "fr") expect(tag, "premise: the French tag differs from the English").not.toBe(msgFor("en", "forfeit.tag.doubleWalkover"));
      const got = await scores(at);
      expect(Object.keys(got), "every line was read").toEqual(["dw", "wo", "won"]);
      expect(got.dw!.text, `${at}: the double walkover prints the house tag`).toBe(tag);
      expect(got.dw!.li, `${at}: and nowhere the stored 0 — 0`).not.toContain("0 — 0");
      expect([got.dw!.symbol?.role, got.dw!.symbol?.label], `${at}: a symbol named by the full words`).toEqual(["img", full]);
      // `.app-display` uppercases and is unlayered (globals.css), so a `normal-case` beside it on the SAME element loses
      // ("2× W/O" in the browser, seen in player-matches-played.spec.ts): it sits on the inner symbol.
      expect(got.dw!.symbol?.cls, `${at}: the tag keeps its case`).toContain("normal-case");
      expect(got.dw!.cls, `${at}: muted, in the list's own slate-500`).toContain("text-slate-500");
      expect(got.dw!.cls, `${at}: never the score's ink`).not.toContain("text-slate-700");
      // The pair: the same cell, read the same way, prints the stored headline for a result that credits someone.
      expect([got.wo!.text, got.wo!.symbol], `${at}: the walkover keeps its credited score`).toEqual(["3 — 0", null]);
      expect([got.won!.text, got.won!.symbol], `${at}: the played match keeps its result`).toEqual(["2 — 1", null]);
      expect(got.won!.cls, `${at}: in the score's ink`).toContain("text-slate-700");
    });
  }
});
