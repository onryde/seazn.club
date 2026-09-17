// Spectator W2, Task 16 — the news post's share row speaks the org's language.
//
// The page loaded the `public` dictionary for its eyebrow, back link and
// download button, then mounted `<ShareBar>` with NO labels — so the one row a
// reader taps to pass the post on read "Copy link" / "Copied ✓" in every locale.
//
// Expectations are each locale's own dictionary VALUES (never an English list
// checked for absence — see `[competitionSlug]/__tests__/page.test.tsx:14-27`).
// `share` and `copied` render only after mount, so they are read at the prop
// boundary; the three server-rendered words are read in the markup as well.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { OrgPost } from "@/server/usecases/org-posts";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { ShareBar } from "@/components/share-bar";

const DICTS: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};

const state = vi.hoisted(() => ({ locale: "en" }));

const ISO = "2026-03-02T12:00:00Z";
const orgFor = () => ({
  id: "00000000-0000-0000-0000-0000000000aa",
  name: "Test Org",
  slug: "test-org",
  branded: false,
  branding: {},
  logo: null,
  about: null,
  default_locale: state.locale,
  card_payments: false,
});
const POST: OrgPost = {
  id: "00000000-0000-0000-0000-000000000001",
  orgId: "00000000-0000-0000-0000-0000000000aa",
  competitionId: null,
  divisionId: null,
  kind: "announcement",
  status: "published",
  slug: "hello",
  title: "Hello",
  bodyMd: "",
  heroImagePath: null,
  autoSource: null,
  publishedAt: ISO,
  createdAt: ISO,
  updatedAt: ISO,
};

vi.mock("@/server/public-site/data", () => ({
  getPublicOrg: async () => ({ org: orgFor(), competitions: [] }),
}));
vi.mock("@/server/usecases/org-posts", () => ({ publicPost: async () => POST }));
vi.mock("@/server/news/public-view", () => ({
  postHeroUrl: () => null,
  resolvePostSides: async () => null,
  relatedCompetition: async () => null,
}));
vi.mock("@/server/help-content", () => ({ renderHelpMarkdown: async () => "" }));

import PostPage from "../[postSlug]/page";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const page = () =>
  PostPage({ params: Promise.resolve({ orgSlug: "test-org", postSlug: POST.slug }) }) as Promise<ReactElement>;

beforeEach(() => {
  state.locale = "en";
});

describe("news post page — the share row is in the org's locale", () => {
  for (const [locale, d] of Object.entries(DICTS)) {
    it(`${locale}: ShareBar is handed all five of ${locale}'s share words`, async () => {
      state.locale = locale;
      const bars = walk(await page()).filter((el) => el.type === ShareBar);
      expect(bars).toHaveLength(1);
      expect(propsOf(bars[0]!).labels).toEqual({
        share: d["share.share"],
        whatsapp: d["share.whatsappShort"],
        // A post is not a competition: the generic "Share on WhatsApp", never
        // "Share this competition on WhatsApp".
        whatsappAria: d["share.whatsapp"],
        copy: d["share.copy"],
        copied: d["share.copied"],
      });
    });

    it(`${locale}: the rendered WhatsApp link and copy button read ${locale}'s values`, async () => {
      state.locale = locale;
      const html = renderToStaticMarkup(await page());
      expect(html).toMatch(
        new RegExp(
          `<a [^>]*aria-label="${reEsc(esc(d["share.whatsapp"]!))}"[^>]*>${reEsc(esc(d["share.whatsappShort"]!))}</a>`,
        ),
      );
      expect(html).toMatch(new RegExp(`<button [^>]*>${reEsc(esc(d["share.copy"]!))}</button>`));
      if (locale !== "en") {
        const english = DICTS.en!["share.copy"]!;
        const mine = d["share.copy"]!;
        if (mine !== english && !mine.includes(english) && !english.includes(mine)) {
          expect(html).not.toContain(`>${esc(english)}<`);
        }
      }
    });
  }
});
