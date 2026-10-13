// Design re-review N-1 — the player's /me results list printed each finalized match's stored headline, and a double
// walkover's stored summary carries a 0 — 0 (the console can finalize a decided double walkover). It credits nobody, so
// the line prints the house tag instead, muted, its symbol named by the full words, as every other host does
// (`creditsNobody`, lib/forfeit-tag.ts). fr is the locale whose tag differs from en ("2× forf." vs "2× w/o"), so a
// typed English tag cannot pass it.
// Loop R M-11 — every other credited result (a walkover, a retirement, a disqualification, an abandon decided by DLS)
// printed its credited score with no word of why ("3 — 0" for a walkover nobody played). It now keeps the score and
// adds the house tag after it (UI-2, `outcomeTagWords`, the one reader), muted and named the same way. A played match
// keeps its bare result. The case that tells the two readings apart: the stored "3 — 0" alone is the wrong answer.
// The page is rendered whole, its reads mocked; the producer leg (a real finalize, the real `listMyFixtures` row) is
// `server/__tests__/double-walkover-hosts-db.test.ts`.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { msgFor } from "@/lib/messages-i18n";
import type { MyResult } from "@/server/usecases/me";
import { FORFEIT_TAG_KEY } from "@/lib/forfeit-tag";
import { FORFEIT_TAG_FULL_KEY } from "@/lib/outcome-text";

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

const result = (id: string, entrant: string, opponent: string, headline: string, outcome: unknown, abandonReason: string | null = null): MyResult => ({
  id, fixture_no: 1, competition_name: "Cup", competition_slug: "cup", competition_visibility: "public",
  division_name: "Open", division_slug: "open", org_name: "Club", org_slug: "club",
  // `MyResult.summary` is typed `string | null`, but the column is jsonb and arrives as the object the page casts it to
  // (`page.tsx` `headline()`); the DB scene's real row has the same shape.
  entrant_name: entrant, opponent_name: opponent, player_home: true, scheduled_at: null, summary: { headline } as unknown as MyResult["summary"], outcome,
  home_entrant_id: `e-${entrant.toLowerCase()}`, away_entrant_id: `e-${opponent.toLowerCase()}`, abandon_reason: abandonReason,
});
const RESULTS: MyResult[] = [
  result("dw", "Falcons", "Hawks", "0 — 0", { kind: "double_walkover" }),
  result("wo", "Owls", "Ravens", "3 — 0", { kind: "award", winner: "e-owls", loser: "e-ravens", reason: "walkover" }),
  result("won", "Lions", "Tigers", "2 — 1", { kind: "win", winner: "e-lions" }),
  result("ret", "Bears", "Wolves", "2 — 1", { kind: "award", winner: "e-bears", loser: "e-wolves", reason: "retired" }),
  result("dq", "Foxes", "Hares", "3 — 0", { kind: "award", winner: "e-foxes", loser: "e-hares", reason: "disqualified" }),
  result("dls", "Kites", "Crows", "180/4 — 150/9", { kind: "win", winner: "e-kites", loser: "e-crows", method: "dls" }, "rain"),
  // An award stored before W2b: its reason in `method`, no loser — a walkover only beside two seats (Loop R I-1).
  result("legacy", "Ospreys", "Larks", "2 — 0", { kind: "award", winner: "e-ospreys", method: "walkover" }),
  // Loop R2 N-5: a credited walkover with NO stored summary (no match_states row behind the award) — no headline.
  { ...result("nosum", "Swifts", "Terns", "", { kind: "award", winner: "e-swifts", loser: "e-terns", reason: "walkover" }), summary: null },
];
/** The credited results and the tag each owes, by the house key tables (never the page's own words). */
const TAGGED = { wo: "walkover", ret: "retired", dq: "disqualified", dls: "abandoned_dls", legacy: "walkover" } as const;

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

interface Score {
  /** The cell's visible text, tags stripped. */
  text: string;
  /** The cell's text before its symbol (the score), or all of it when there is none. */
  lead: string;
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
    // The symbol: the cell's one inner span — the whole cell (a double walkover) or after the score (M-11).
    const sym = /<span\b([^>]*)>[^<]*<\/span>$/.exec(inner);
    out[r.id] = {
      text: inner.replace(/<[^>]+>/g, ""),
      lead: (sym ? inner.slice(0, sym.index) : inner).replace(/<[^>]+>/g, ""),
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
      expect(Object.keys(got), "every line was read").toEqual(["dw", "wo", "won", "ret", "dq", "dls", "legacy", "nosum"]);
      expect(got.dw!.text, `${at}: the double walkover prints the house tag`).toBe(tag);
      expect(got.dw!.li, `${at}: and nowhere the stored 0 — 0`).not.toContain("0 — 0");
      expect([got.dw!.symbol?.role, got.dw!.symbol?.label], `${at}: a symbol named by the full words`).toEqual(["img", full]);
      // `.app-display` uppercases and is unlayered (globals.css), so a `normal-case` beside it on the SAME element loses
      // ("2× W/O" in the browser, seen in player-matches-played.spec.ts): it sits on the inner symbol.
      expect(got.dw!.symbol?.cls, `${at}: the tag keeps its case`).toContain("normal-case");
      expect(got.dw!.cls, `${at}: muted, in the list's own slate-500`).toContain("text-slate-500");
      expect(got.dw!.cls, `${at}: never the score's ink`).not.toContain("text-slate-700");
      // The pair: a played match prints its stored result, bare, in the score's ink.
      expect([got.won!.text, got.won!.symbol], `${at}: the played match keeps its result`).toEqual(["2 — 1", null]);
      expect(got.won!.cls, `${at}: in the score's ink`).toContain("text-slate-700");
    });

    it(`${at}: Loop R M-11 — a credited result keeps its score and adds its tag after it, muted and named, case kept`, async () => {
      const got = await scores(at);
      let checked = 0;
      for (const [id, kind] of Object.entries(TAGGED) as [keyof typeof TAGGED, (typeof TAGGED)[keyof typeof TAGGED]][]) {
        const row = RESULTS.find((r) => r.id === id)!;
        const stored = (row.summary as unknown as { headline: string }).headline;
        const word = msgFor(at, FORFEIT_TAG_KEY[kind]);
        expect(got[id]!.lead, `${at}/${id}: the credited score first, unchanged`).toBe(stored);
        expect(got[id]!.text, `${at}/${id}: never the bare score`).not.toBe(stored);
        expect(got[id]!.text, `${at}/${id}: then the house tag`).toBe(`${stored}${word}`);
        expect([got[id]!.symbol?.role, got[id]!.symbol?.label], `${at}/${id}: a symbol named by the full words`).toEqual(["img", msgFor(at, FORFEIT_TAG_FULL_KEY[kind])]);
        for (const token of ["normal-case", "text-slate-500", "ml-1.5"]) {
          expect(got[id]!.symbol?.cls, `${at}/${id}: ${token}`).toContain(token);
        }
        expect(got[id]!.cls, `${at}/${id}: the score keeps its ink`).toContain("text-slate-700");
        checked++;
      }
      expect(checked).toBe(Object.keys(TAGGED).length);
    });

    it(`${at}: Loop R2 N-5 — a credited result with no stored headline prints the dash alone, never a tag beside nothing`, async () => {
      const got = await scores(at);
      // The premise that makes the case bite: this row's outcome DOES owe a tag (a walkover), so only the missing
      // headline keeps it off the line.
      expect(got.wo!.symbol?.label, `${at}: premise, a walkover is tagged`).toBe(msgFor(at, FORFEIT_TAG_FULL_KEY.walkover));
      expect([got.nosum!.text, got.nosum!.symbol], `${at}: the dash, no tag`).toEqual(["—", null]);
      expect(got.nosum!.li, `${at}: and nowhere the tag's word`).not.toContain(msgFor(at, FORFEIT_TAG_KEY.walkover));
    });
  }
});
