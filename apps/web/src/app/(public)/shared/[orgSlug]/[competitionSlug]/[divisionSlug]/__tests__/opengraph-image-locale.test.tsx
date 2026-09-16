// Spectator W2, Task 16 review F2 — the division share card is drawn in the
// ORG's language.
//
// This PNG is the preview of every division link (and, re-exported, of the
// division's /present board link). It drew English in every locale: the
// frame's footer ("Live scores · fixtures · standings") and the two lines that
// replace the table — "Standings live on seazn.club" for a youth division of
// individuals (whose names a share image never prints) and "Fixtures &
// standings on seazn.club" before any standings exist.
//
// `next/og`'s ImageResponse is captured and its tree rendered to markup (as
// ../../__tests__/opengraph-image-locale.test.tsx). Every expectation is the
// locale's own dictionary value. The table's `P`/`Pts` are notation and stay
// untranslated in every locale.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const captured: { tree: ReactElement | null } = { tree: null };
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(tree: unknown) {
      captured.tree = tree as ReactElement;
    }
  },
}));

type Row = { rank: number; entrantId: string; played: number; points: number };
const state = vi.hoisted(() => ({
  locale: "en",
  youth: false,
  kind: "individual",
  rows: [] as { rank: number; entrantId: string; played: number; points: number }[],
  missing: false,
}));

vi.mock("@/lib/db", () => ({ sql: async () => [{ youth: state.youth }] }));
vi.mock("@/server/og/poster-image", () => ({ posterImageDataUrl: vi.fn(async () => null) }));
vi.mock("@/server/public-site/data", () => ({
  getPublicDivision: async () =>
    state.missing
      ? null
      : {
          org: { id: "o1", name: "Test Org", slug: "test-org", branded: false, branding: {}, logo: null, about: null, default_locale: state.locale, card_payments: false },
          competition: { id: "c1", name: "Test Comp", slug: "test-comp", branding: {} },
          division: { id: "d1", name: "Open Singles", slug: "open" },
          entrants: [
            { id: "e1", kind: state.kind, display_name: "Maya Kapoor" },
            { id: "e2", kind: state.kind, display_name: "Leo Ng" },
          ],
          standings: [{ rows: state.rows }],
        },
}));

import DivisionOg from "../opengraph-image";

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};
const BRAND = "seazn.club";
const line = (l: string, k: string) => DICTS[l]![k]!.replace("{brand}", BRAND);
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const ROWS: Row[] = [
  { rank: 1, entrantId: "e1", played: 3, points: 9 },
  { rank: 2, entrantId: "e2", played: 3, points: 6 },
];

async function draw(): Promise<string> {
  captured.tree = null;
  await DivisionOg({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open" }),
  });
  if (!captured.tree) throw new Error("ImageResponse was never constructed");
  return renderToStaticMarkup(captured.tree);
}

beforeEach(() => {
  Object.assign(state, { locale: "en", youth: false, kind: "individual", rows: [], missing: false });
});

describe("division share card — drawn in the org's locale", () => {
  it("premise: each drawn phrase differs from English in at least one of es/fr/nl, and names the brand", () => {
    for (const k of ["og.tagline", "og.standings.youth", "og.standings.empty"]) {
      expect(["es", "fr", "nl"].some((l) => line(l, k) !== line("en", k)), k).toBe(true);
    }
    for (const l of Object.keys(DICTS)) {
      expect(DICTS[l]!["og.standings.youth"], l).toContain("{brand}");
      expect(DICTS[l]!["og.standings.empty"], l).toContain("{brand}");
    }
  });

  for (const locale of Object.keys(DICTS)) {
    const notEnglish = (html: string, k: string) => {
      if (line(locale, k) !== line("en", k)) expect(html, `${locale} ${k}`).not.toContain(`>${esc(line("en", k))}<`);
    };

    it(`${locale}: a youth division of individuals draws ${locale}'s youth line and footer, and no names`, async () => {
      Object.assign(state, { locale, youth: true, kind: "individual", rows: ROWS });
      const html = await draw();
      expect(html).toContain(`>${esc(line(locale, "og.standings.youth"))}<`);
      expect(html).toContain(`>${esc(line(locale, "og.tagline"))}<`);
      expect(html).not.toContain("Maya Kapoor");
      expect(html).not.toContain("{brand}");
      notEnglish(html, "og.standings.youth");
      notEnglish(html, "og.tagline");
    });

    it(`${locale}: a division with no standings yet draws ${locale}'s empty line`, async () => {
      Object.assign(state, { locale, youth: false, rows: [] });
      const html = await draw();
      expect(html).toContain(`>${esc(line(locale, "og.standings.empty"))}<`);
      expect(html).not.toContain(`>${esc(line(locale, "og.standings.youth"))}<`);
      notEnglish(html, "og.standings.empty");
    });

    it(`${locale}: a real table keeps P / Pts notation untranslated and draws no fallback line`, async () => {
      Object.assign(state, { locale, youth: false, rows: ROWS });
      const html = await draw();
      expect(html).toContain(">Maya Kapoor<");
      expect(html).toContain(">P 3<");
      expect(html).toContain(">Pts 9<");
      expect(html).not.toContain(`>${esc(line(locale, "og.standings.empty"))}<`);
      expect(html).toContain(`>${esc(line(locale, "og.tagline"))}<`);
    });
  }

  // No division means no org, so English is the only locale there is: this
  // pins that the placeholder name now comes from the dictionary. A literal
  // "Division" is byte-identical in en and cannot be told apart — recorded as
  // an equivalent mutant, not claimed as a kill.
  it("a missing division draws the English dictionary's placeholder name", async () => {
    state.missing = true;
    const html = await draw();
    expect(html).toContain(`>${esc(DICTS.en!["og.division"]!)}<`);
    expect(html).toContain(`>${esc(line("en", "og.standings.empty"))}<`);
  });
});
