// The heading level of a format preview's phase titles, per consumer (axe `heading-order`, found by the Blog P2 Lighthouse
// pass on /help/formats/swiss: an <h4> straight under the page's <h2>).
//
// FormatPreviewView has two consumers, and they sit at DIFFERENT depths, which is why the level is the caller's to say:
//   - /help/formats/<family>: h1 (family) > h2 "What you get with 8 entrants" > the phase titles, so h3.
//   - the division builder's "How this works" panel: h2 (format name) > h3 "Live example" > the phase titles, so h4.
// (The component's own header comment also named the marketing /formats page; no such consumer exists.)
//
// Both are driven through their REAL modules over every format family (the registry sweep), with the phases the real
// generator makes (previewDivisionFixtures, the same call the help page makes and the format-preview endpoint answers with).
// The expected level is the rule, not a number read back from the component: a title sits one level below the heading
// above it, and no heading skips a level on the way down. The numbers 3 and 4 are pinned beside it, per consumer.
//
// Single-sport reason: no sport is involved; a format family is a bracket shape, and every family is swept.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// The panel's phases arrive from a fetch in an effect, which a server render never runs. Its one useState is the phases, so
// the test seeds it, and nothing else about React is replaced (the real dispatcher still runs every other hook).
const seed = vi.hoisted(() => ({ phases: null as unknown }));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useState: ((initial: unknown) => (seed.phases === null ? real.useState(initial) : [seed.phases, () => {}])) as typeof real.useState,
    useEffect: (() => {}) as typeof real.useEffect,
  };
});
vi.mock("@/lib/pricing-matrix-server", () => ({ loadPricingMatrix: vi.fn(async () => ({})) }));

import FormatExplainerPage from "@/app/help/formats/[family]/page";
import { DictProvider } from "@/components/i18n/dict-provider";
import { FormatExplainerPanel } from "@/components/v2/format-explainer-panel";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import ui from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { previewDivisionFixtures } from "@/server/usecases/stages";

interface Heading { level: number; text: string }

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

/** Every heading in the markup, in document order, tags inside it stripped. */
function headings(markup: string): Heading[] {
  return [...markup.matchAll(/<h([1-6])\b[^>]*>(.*?)<\/h\1>/gs)].map((m) => ({
    level: Number(m[1]),
    text: decode(m[2]!.replace(/<[^>]*>/g, "")).trim(),
  }));
}

/** axe's heading-order, as a rule: a heading may be at most one level deeper than the one before it. */
function skips(hs: Heading[]): string[] {
  const out: string[] = [];
  hs.forEach((h, i) => {
    if (i > 0 && h.level > hs[i - 1]!.level + 1) out.push(`h${h.level} "${h.text}" follows h${hs[i - 1]!.level} "${hs[i - 1]!.text}"`);
  });
  return out;
}

interface Consumer {
  name: string;
  /** The level its phase titles must sit at, pinned. */
  level: number;
  /** The heading the preview sits under: the page's "What you get" h2, the panel's "Live example" h3. */
  anchor: string;
  render: (familySlug: string) => Promise<string>;
}

const consumers: Consumer[] = [
  {
    name: "the /help/formats/<family> page",
    level: 3,
    anchor: "What you get with 8 entrants",
    render: async (family) => {
      seed.phases = null;
      return renderToStaticMarkup((await FormatExplainerPage({ params: Promise.resolve({ family }) })) as ReactElement);
    },
  },
  {
    name: "the division builder's format explainer panel",
    level: 4,
    // From the dictionary the panel reads, not a string typed here.
    anchor: (ui as Record<string, string>)["format.explainer.liveExample"]!,
    render: async (family) => {
      const f = FORMAT_FAMILIES.find((x) => x.slug === family)!;
      seed.phases = previewDivisionFixtures(f.cannedStages, 8);
      try {
        return renderToStaticMarkup(
          <DictProvider dict={ui as unknown as Dict} locale="en">
            <FormatExplainerPanel familySlug={family} onClose={() => {}} />
          </DictProvider>,
        );
      } finally {
        seed.phases = null;
      }
    },
  },
];

describe("FormatPreviewView: phase titles sit one level under their consumer's own heading", () => {
  for (const c of consumers) {
    it(`${c.name}: every family's phase titles are h${c.level}, directly under an h${c.level - 1}, and no heading skips a level`, async () => {
      let titlesChecked = 0;
      for (const f of FORMAT_FAMILIES) {
        const phases = previewDivisionFixtures(f.cannedStages, 8);
        expect(phases.length, `anti-vacuity: ${f.slug} generates at least one phase`).toBeGreaterThan(0);
        const hs = headings(await c.render(f.slug));
        const at = hs.findIndex((h) => h.text === c.anchor);
        expect(at, `${c.name}, ${f.slug}: the "${c.anchor}" heading is on the page`).toBeGreaterThanOrEqual(0);
        // Every generated phase title, in order, is the run of headings straight after the anchor.
        const titles = hs.slice(at + 1, at + 1 + phases.length);
        expect(titles.map((h) => h.text), `${c.name}, ${f.slug}: the phase titles follow "${c.anchor}"`).toEqual(phases.map((p) => p.title));
        // The rule, derived from the markup: the first title sits one level below the anchor (the others are its siblings).
        expect(titles[0]!.level, `${c.name}, ${f.slug}: the first title sits one level below "${c.anchor}"`).toBe(hs[at]!.level + 1);
        for (const h of titles) {
          titlesChecked++;
          expect(h.level, `${c.name}, ${f.slug}: "${h.text}"`).toBe(c.level);
        }
        expect(skips(hs), `${c.name}, ${f.slug}: headings that skip a level`).toEqual([]);
      }
      expect(titlesChecked, `phase titles checked across ${FORMAT_FAMILIES.length} families`).toBeGreaterThanOrEqual(FORMAT_FAMILIES.length);
    });
  }

  it("the sweep reaches both consumers over a real registry (anti-vacuity)", () => {
    expect(FORMAT_FAMILIES.length).toBeGreaterThanOrEqual(5);
    expect(consumers.map((c) => c.level)).toEqual([3, 4]);
  });
});
