// The demo island's server render (chase-demo.tsx): what a visitor sees before script runs, or without it. Taps are
// proven in the browser (marketing-product.spec.ts); this suite has no DOM.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChaseDemo, type ChaseTile } from "../chase-demo";
import { chaseDemoLabels } from "../chase-demo-labels";
import { CHASE, ballsLeft, openingChase, oversText } from "@/lib/marketing/cricket-chase";
import { BALLS_PER_OVER } from "@/lib/marketing/cricket-chase-rules";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";
import enPublic from "@/dictionaries/en/public.json";
import frPublic from "@/dictionaries/fr/public.json";
import esPublic from "@/dictionaries/es/public.json";
import nlPublic from "@/dictionaries/nl/public.json";

const DICTS = { en, fr, es, nl } as unknown as Record<string, Dict>;
const PUBLIC = { en: enPublic, fr: frPublic, es: esPublic, nl: nlPublic } as unknown as Record<string, Dict>;
const TEAMS = { batting: "Thorpe Bay Tigers", bowling: "Southend Blue Blazers" };
const ALL: ChaseTile[] = ["pad", "matchCentre", "table", "stream"];
const render = (lang: string, tiles: ChaseTile[], streamControls: boolean) =>
  renderToStaticMarkup(<ChaseDemo tiles={tiles} streamControls={streamControls} labels={chaseDemoLabels(DICTS[lang]!, PUBLIC[lang]!)} teams={TEAMS} ballsPerOver={BALLS_PER_OVER} />);
const KEYS = ["0", "1", "2", "3", "4", "6", "wide", "out"];

describe("ChaseDemo server render", () => {
  it.each(LOCALES.map((l) => [l]))("%s: shows the opening state in every tile", (lang) => {
    const html = render(lang, ALL, false);
    const o = openingChase();
    const score = `${o.runs}/${o.wkts}`;
    for (const tile of ALL) {
      const at = html.indexOf(`data-testid="chase-tile-${tile}"`);
      expect(at, tile).toBeGreaterThan(-1);
    }
    // pad, match page and stream each print the score; pad, match page and stream each print the overs
    expect(html.split(`>${score}<`).length - 1).toBe(3);
    expect(html.split(`>${oversText(o.balls, BALLS_PER_OVER)}<`).length - 1).toBeGreaterThanOrEqual(3);
    expect(html).toContain(String(CHASE.target - o.runs));
    expect(html).toContain(String(ballsLeft(o, BALLS_PER_OVER)));
    expect(html).not.toMatch(/\{[a-z]+\}/); // no unfilled placeholder
    expect(html).not.toContain("demo."); // no raw dictionary key
  });

  it("streaming configuration renders the pad and the stream only, with the stream's switches", () => {
    const html = render("en", ["pad", "stream"], true);
    expect(html).toContain('data-testid="chase-tile-pad"');
    expect(html).toContain('data-testid="chase-tile-stream"');
    expect(html).not.toContain('data-testid="chase-tile-matchCentre"');
    expect(html).not.toContain('data-testid="chase-tile-table"');
    expect(html.match(/data-testid="chase-seg-style-[a-z]+"/g)).toHaveLength(2);
    expect(html.match(/data-testid="chase-seg-state-[a-z]+"/g)).toHaveLength(4);
    expect(render("en", ALL, false)).not.toContain("chase-seg-");
  });

  it("every key has a button, and undo has one", () => {
    const html = render("en", ALL, false);
    let found = 0;
    for (const k of KEYS) {
      expect(html.split(`data-testid="chase-key-${k}"`), k).toHaveLength(2);
      found++;
    }
    expect(found).toBe(8);
    expect(html.split('data-testid="chase-undo"')).toHaveLength(2);
    expect(html.match(/<button /g)!.length).toBe(9);
  });
});

// The island runs in the visitor's browser on a marketing page. Importing the engine there cost ~380 KB of script for
// one number (measured 2026-11-16: 1177 KB against Pricing's 798), so the over length is read on the server and handed
// in. This walks the island's own import closure so a later convenience import cannot quietly bring the engine back.
describe("ChaseDemo ships no engine to the browser", () => {
  it("nothing the island imports, directly or through its own modules, reaches @seazn/engine", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.resolve(__dirname, "../../../..");
    const seen = new Set<string>();
    const resolve = (from: string, spec: string) => {
      const base = spec.startsWith("@/") ? path.join(src, spec.slice(2)) : path.resolve(path.dirname(from), spec);
      return [".ts", ".tsx", "/index.ts"].map((e) => base + e).find((f) => fs.existsSync(f));
    };
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)) {
        const [, typeOnly, spec] = m;
        if (typeOnly) continue; // erased at build
        expect(spec, `${path.basename(file)} imports ${spec}`).not.toMatch(/^@seazn\/engine/);
        if (spec!.startsWith(".") || spec!.startsWith("@/")) {
          const next = resolve(file, spec!);
          if (next) walk(next);
        }
      }
    };
    walk(path.join(src, "components/marketing/product/chase-demo.tsx"));
    expect(seen.size).toBeGreaterThanOrEqual(2);
    expect([...seen].some((f) => f.endsWith("cricket-chase.ts"))).toBe(true);
  });

  it("the stream tile's moments are worded by the real overlay's dictionary, and none shows before a tap", () => {
    let checked = 0;
    for (const lang of LOCALES) {
      const l = chaseDemoLabels(DICTS[lang]!, PUBLIC[lang]!);
      const pub = PUBLIC[lang] as unknown as Record<string, string>;
      for (const [label, key] of [["moment.six", "overlay.moment.six"], ["moment.four", "overlay.moment.four"], ["moment.out", "overlay.moment.out"], ["moment.endOfOver", "overlay.endOfOver.title"], ["moment.runsScore", "overlay.endOfOver.runsScore"]] as const) {
        expect(pub[key], `${lang} ${key}`).toBeTruthy();
        expect(l[label], `${lang} ${label}`).toBe(pub[key]);
        checked++;
      }
      expect(render(lang, ALL, false)).not.toContain('data-testid="chase-moment"');
    }
    expect(checked).toBe(LOCALES.length * 5);
  });
});
