// Regression: the checkpoint list (the "Save points" panel) rendered nearly
// illegible for any viewer with OS dark mode on — stray `dark:*` Tailwind
// classes fired (this app has NO dark-mode support anywhere else; `dark:`
// here is the unconfigured, automatic `prefers-color-scheme` variant, not an
// opt-in class toggle), swapping labels/timestamps to colors meant for a
// dark background while the card itself stayed white. The baseline
// light-mode colors (`text-slate-400`/`text-slate-500` at 10-12.5px) were
// ALSO already below WCAG AA on their own — the same class of bug already
// fixed once in this codebase (Move panel's hint text, board-view-redesign
// 2026-08-10).
//
// Same harness as history-panel-eviction-notice.test.tsx: a static render
// can't reach the checkpoint list — it loads via an effect on mount.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf, textOf } from "@/components/__tests__/_hook-harness";
import type { ReactElement, ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const apiV1 = vi.fn();
vi.mock("@/lib/client-v1", () => ({
  apiV1: (...args: unknown[]) => apiV1(...args),
  ApiV1Error: class extends Error {},
}));

const { HistoryPanel } = await import("../history-panel");

interface PanelProps {
  divisionId: string;
  scheduleLocked: boolean;
  canEdit: boolean;
}
type Island = ReturnType<typeof renderIsland<PanelProps>>;

async function renderWithCheckpoints(checkpoints: unknown[]): Promise<Island> {
  apiV1.mockReset();
  apiV1.mockImplementation(async (path: string) => {
    if (path.endsWith("/history")) return { watermark: 1, seq: 1, events: [] };
    return checkpoints;
  });
  const island = renderIsland<PanelProps>((props: PanelProps) => HistoryPanel(props), {
    divisionId: "d1",
    scheduleLocked: false,
    canEdit: true,
  });
  // The mount-time `load()` effect defers via `setTimeout(0)` and awaits two
  // fetches — two ticks lets both settle, same margin the eviction-notice
  // suite already uses for its own post-submit reload.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return island;
}

const findByText = (island: Island, text: string): ReactElement | undefined =>
  island.tree().find((el: ReactElement) => textOf(propsOf(el).children as ReactNode) === text);

describe("HistoryPanel — save-point list stays legible (contrast regression)", () => {
  it("carries no dark: utility anywhere in the panel", async () => {
    const island = await renderWithCheckpoints([
      { id: "c1", seq: 1, label: "asdasd", kind: "manual", created_at: "2026-07-29T21:24:28.000Z" },
    ]);
    const classNames = island
      .tree()
      .map((el) => String(propsOf(el).className ?? ""))
      .join(" ");
    expect(classNames).not.toMatch(/dark:/);
  });

  it("a superseded save point's label stays readable at slate-600 — the strikethrough carries 'inactive', not an illegible color", async () => {
    const island = await renderWithCheckpoints([
      {
        id: "c1",
        seq: 1,
        label: "old one",
        kind: "ai",
        superseded: true,
        created_at: "2026-08-06T23:56:59.000Z",
      },
      {
        id: "c2",
        seq: 2,
        label: "Before AI",
        kind: "ai",
        superseded: false,
        created_at: "2026-08-06T23:56:59.000Z",
      },
    ]);
    const label = findByText(island, "old one");
    expect(label).toBeTruthy();
    expect(String(propsOf(label!).className)).toContain("slate-600");
    expect(String(propsOf(label!).className)).not.toContain("slate-400");
  });

  it("the group heading and count ('Yours', '1 used') use slate-600, not the too-faint slate-400/500", async () => {
    const island = await renderWithCheckpoints([
      { id: "c1", seq: 1, label: "asdasd", kind: "manual", created_at: "2026-07-29T21:24:28.000Z" },
    ]);
    const heading = findByText(island, "Yours");
    const count = findByText(island, "1 used");
    expect(heading).toBeTruthy();
    expect(count).toBeTruthy();
    expect(String(propsOf(heading!).className)).toContain("slate-600");
    expect(String(propsOf(count!).className)).toContain("slate-600");
  });
});

// ---- Shared WCAG contrast primitives + Tailwind v4 hex table -------------
// Hoisted to module scope so every describe block below (the original 'vs'-
// separator regression suite, and the R3.5/Task P sweep-completion suite
// added after it) shares one set of constants instead of each duplicating
// them — two copies of the same OKLCH-derived hex values could quietly
// drift apart.
//
// The formula is re-derived HERE rather than imported from
// ../scorepad/v3/__tests__/contrast.ts, matching that file's own stated
// reason for keeping it inline there: each contrast suite proves itself,
// rather than trusting a cross-file import to still mean what it did.
//
// Hex values are Tailwind v4's ACTUAL compiled output — read from this repo's
// own node_modules/tailwindcss/theme.css oklch() swatches and converted to
// sRGB (OKLab -> linear sRGB -> gamma), NOT the classic Tailwind v3 palette;
// ../scorepad/v3/__tests__/contrast.test.ts's own notes document several
// places where the two disagree enough to flip a real AA verdict.
function srgbChannelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function relativeLuminance(hex: string): number {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}
function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Tailwind v4's compiled sRGB for every slate tier touched by the suites in
// this file (see the sourcing note above).
const SLATE_100 = "#f1f5f9"; // oklch(96.8% 0.007 247.896)  — the chips' bg-slate-100
const SLATE_400 = "#90a1b9"; // oklch(70.4% 0.04 256.788)   — the failing OLD token
const SLATE_500 = "#62748e"; // oklch(55.4% 0.046 257.417)
const SLATE_600 = "#45556c"; // oklch(44.6% 0.043 257.281)  — the fixed NEW token
const SLATE_HEX: Record<string, string> = {
  "100": SLATE_100,
  "400": SLATE_400,
  "500": SLATE_500,
  "600": SLATE_600,
};

// `.card`'s background is what every non-chip instance in this file renders
// on. Read LIVE from globals.css rather than trusting a bare "#ffffff"
// literal with no tie back to the token the spans actually sit on (the gap
// a reviewer found here): if `.card` is ever restyled off bg-white, the
// sanity test below fails loudly instead of leaving every ratio in this
// file silently wrong.
const globalsCss = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const cardRuleMatch = /\.card\s*\{\s*@apply\s+([^;]+);/.exec(globalsCss);
const WHITE = "#ffffff";

describe("shared token sanity — .card's background", () => {
  it("globals.css's .card rule still applies bg-white — every card-background ratio in this file depends on it", () => {
    expect(cardRuleMatch, "globals.css must still define `.card { @apply ...; }`").not.toBeNull();
    expect(cardRuleMatch![1]).toMatch(/\bbg-white\b/);
  });
});

// R3.5 accessibility fix (owner-approved 2026-08-26) — FixtureConsole's "vs"
// separator rendered at text-slate-400 on a white card: an UNSCOPED axe run
// during the football pass flagged it (pre-existing, not caused by that
// wave), ~2.6:1 against WCAG AA's 4.5:1 floor for normal text. Same class of
// bug the HistoryPanel suite above already caught once (slate-400/500 both
// too faint on white) — computed here rather than eyeballed.
describe("FixtureConsole — 'vs' separator contrast (regression, R3.5)", () => {
  it("sanity: the formula agrees with the known black-on-white extreme", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("the OLD token (text-slate-400 on white) really did fail WCAG AA — the regression this fix closes", () => {
    const ratio = contrastRatio(SLATE_400, WHITE);
    expect(ratio).toBeCloseTo(2.63, 1);
    expect(ratio).toBeLessThan(4.5);
  });

  it("the NEW token (text-slate-600 on white) clears the normal-text floor (4.5:1)", () => {
    expect(contrastRatio(SLATE_600, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it("fixture-console.tsx's 'vs' span actually renders the new token, not a silent reintroduction of the old one", () => {
    const src = readFileSync(join(process.cwd(), "src/components/v2/fixture-console.tsx"), "utf8");
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const vsSpan = /<span className="text-slate-(\d+)">\{msg\("schedule\.vs"\)\}<\/span>/.exec(codeOnly);
    expect(vsSpan, "fixture-console.tsx must still render schedule.vs in its own span").not.toBeNull();
    expect(vsSpan![1], "the 'vs' span must use slate-600 (>=4.5:1), never slate-400 or slate-500").toBe(
      "600",
    );
  });
});

// R3.5/Task P — the rest of the contrast sweep the owner approved after Task
// J's 'vs'-separator fix above: the five remaining non-chip text-slate-400
// instances in fixture-console.tsx (the page an organiser opens for every
// match), the two status chips (a DIFFERENT background — bg-slate-100, not
// white — judged on their own rather than assumed to inherit the 7.58:1
// figure above), and match-rules.tsx's shared field-help span, which Task I
// put two new strings (shootoutWin/shootoutLoss) behind without the wave
// noticing the span itself was already failing AA.
//
// Each instance is checked two ways, closing the gap a reviewer found in
// the suite above (WHITE hardcoded with no tie back to what the span
// actually sits on): (1) the ACTUAL source is read and regex-matched, so a
// silent reintroduction of text-slate-400 is caught, not assumed fixed
// forever; (2) the ratio is COMPUTED from whatever tier is actually present
// (not a hardcoded assumption of "600"), so a partial fix — e.g. landing on
// slate-500 instead of slate-600 — still fails, instead of passing a bare
// "!= text-slate-400" spelling check.
describe("FixtureConsole & MatchRuleFields — contrast sweep completion (R3.5/Task P)", () => {
  const fixtureConsoleCode = readFileSync(
    join(process.cwd(), "src/components/v2/fixture-console.tsx"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const activityPanelCode = readFileSync(
    join(process.cwd(), "src/components/v2/scorepad/v3/activity.tsx"),
    "utf8",
  );
  const matchRulesCode = readFileSync(join(process.cwd(), "src/components/v2/match-rules.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  function tierHex(tier: string, siteLabel: string): string {
    const hex = SLATE_HEX[tier];
    expect(hex, `${siteLabel}: unrecognized slate tier text-slate-${tier}`).toBeDefined();
    return hex;
  }

  // Both call sites of MatchRuleFields (division-builder.tsx's format-tab
  // `<section className="card ...">` and division-settings.tsx's `Group`,
  // which renders `<section className="card p-0 ...">`) wrap it in a
  // `.card` — confirmed by reading both, not assumed — so the help span
  // belongs in the white-background group below, same as the fixture-
  // console instances.
  const cardInstances = [
    {
      label: "fixture header — round/scheduled-time line",
      src: fixtureConsoleCode,
      regex: /<p className="mt-1 text-xs text-slate-(\d+)">\s*\{msg\("schedule\.round"/,
    },
    // R7/C1 (D-4) — these four used to read `fixture-console.tsx`'s own
    // hand-rolled ledger, which this wave DELETED and merged into the pad's
    // panel. The guard moves with the markup rather than dying with it: the
    // count chip, the empty line, the recorded-by attribution and the
    // timestamp all still render, one file over, and the merge is exactly
    // when a sub-AA tier could slip back in unnoticed.
    {
      label: "activity panel header — event count",
      src: activityPanelCode,
      regex: /className="text-sm font-medium text-slate-(\d+) tabular-nums"/,
    },
    {
      label: "activity panel — empty state message",
      src: activityPanelCode,
      regex: /<p className="px-4 py-4 text-sm text-slate-(\d+)">\{t\("pad\.activity\.empty"\)\}<\/p>/,
    },
    {
      label: "activity row — provenance line (time + recorded by)",
      src: activityPanelCode,
      // Tail left open (`[^"]*"` rather than a bare closing `"`) on purpose:
      // this guard's job is the slate TIER, not the full class string, and a
      // legitimate phone-composition class (`max-md:truncate`) now sits after
      // `no-underline` in production markup.
      regex: /className="mt-0\.5 block text-xs font-normal text-slate-(\d+) no-underline[^"]*"/,
    },
    {
      label: "activity row — #seq column",
      src: activityPanelCode,
      regex: /className="mt-px shrink-0 font-mono text-xs tabular-nums text-slate-(\d+)"/,
    },
    {
      label: "match-rules.tsx — shared field help span",
      src: matchRulesCode,
      regex: /<span className="mt-0\.5 block text-\[11px\] text-slate-(\d+)">\{field\.help\}<\/span>/,
    },
  ];

  it.each(cardInstances)(
    "$label renders a slate tier that clears 4.5:1 on .card's white",
    ({ label, src, regex }) => {
      const m = regex.exec(src);
      expect(m, `${label}: source no longer matches the expected markup shape`).not.toBeNull();
      const tier = m![1];
      const ratio = contrastRatio(tierHex(tier, label), WHITE);
      expect(
        ratio,
        `${label}: text-slate-${tier} on white must clear 4.5:1 (got ${ratio.toFixed(2)})`,
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("pins the fixed ratio: text-slate-600 on .card's white is 7.58:1 — same fix as the 'vs' separator", () => {
    expect(contrastRatio(SLATE_600, WHITE)).toBeCloseTo(7.58, 1);
  });

  // The two status chips sit on bg-slate-100, NOT white — the 7.58 figure
  // above does not transfer. Computed independently: slate-400-on-slate-100
  // is actually SLIGHTLY worse than slate-400-on-white (2.40:1 vs 2.63:1),
  // since slate-100 sits closer to slate-400 on the lightness scale than
  // white does.
  const chipInstances = [
    { label: "abandoned", regex: /abandoned:\s*"bg-slate-(\d+) text-slate-(\d+)"/ },
    { label: "cancelled", regex: /cancelled:\s*"bg-slate-(\d+) text-slate-(\d+)"/ },
  ];

  it.each(chipInstances)(
    "STATUS_STYLE.$label clears 4.5:1 against its OWN background, not white",
    ({ label, regex }) => {
      const m = regex.exec(fixtureConsoleCode);
      expect(m, `STATUS_STYLE.${label}: source no longer matches "bg-slate-N text-slate-M"`).not.toBeNull();
      const [, bgTier, textTier] = m!;
      const bgHex = tierHex(bgTier, `STATUS_STYLE.${label} background`);
      const ratio = contrastRatio(tierHex(textTier, `STATUS_STYLE.${label} text`), bgHex);
      expect(
        ratio,
        `STATUS_STYLE.${label}: text-slate-${textTier} on bg-slate-${bgTier} must clear 4.5:1 (got ${ratio.toFixed(2)})`,
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("pins both chip ratios: slate-400 on slate-100 was 2.40:1 (fails AA), slate-600 on slate-100 is 6.92:1 (fixed)", () => {
    expect(contrastRatio(SLATE_400, SLATE_100)).toBeCloseTo(2.4, 1);
    expect(contrastRatio(SLATE_600, SLATE_100)).toBeCloseTo(6.92, 1);
  });
});
