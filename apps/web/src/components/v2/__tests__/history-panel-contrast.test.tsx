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

// R3.5 accessibility fix (owner-approved 2026-08-26) — FixtureConsole's "vs"
// separator rendered at text-slate-400 on a white card: an UNSCOPED axe run
// during the football pass flagged it (pre-existing, not caused by that
// wave), ~2.6:1 against WCAG AA's 4.5:1 floor for normal text. Same class of
// bug the HistoryPanel suite above already caught once (slate-400/500 both
// too faint on white) — computed here rather than eyeballed.
//
// The WCAG formula is re-derived HERE rather than imported from
// ../scorepad/v3/__tests__/contrast.ts, matching that file's own stated
// reason for keeping it inline there: each contrast suite proves itself,
// rather than trusting a cross-file import to still mean what it did.
//
// Hex values are Tailwind v4's ACTUAL compiled output — read from this repo's
// own node_modules/tailwindcss/theme.css oklch() swatches and converted to
// sRGB (OKLab -> linear sRGB -> gamma), NOT the classic Tailwind v3 palette;
// ../scorepad/v3/__tests__/contrast.test.ts's own notes document several
// places where the two disagree enough to flip a real AA verdict.
describe("FixtureConsole — 'vs' separator contrast (regression, R3.5)", () => {
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

  const WHITE = "#ffffff";
  // Tailwind v4's compiled sRGB for --color-slate-400 / --color-slate-600
  // (oklch(70.4% 0.04 256.788) / oklch(44.6% 0.043 257.281) respectively).
  const SLATE_400 = "#90a1b9";
  const SLATE_600 = "#45556c";

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
