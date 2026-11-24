// The paid chip (spec 2026-11-23-online-chess-credits-design.md §8.6, §8.7; plan Task 12): "Online Chess · up to 64 · paid" with Change size before
// the freeze and none after. Node render, assertions anchored on `="`; the numbers are the ladder's.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { ONLINE_SIZES } from "@/lib/online-chess-package";
import { OnlinePaidChip, type OnlinePaidChipProps } from "../paid-chip";

const EN = enUi as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
const render = (node: React.ReactNode) => renderToStaticMarkup(<DictProvider dict={enUi as Dict} locale="en">{node}</DictProvider>);
const clean = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const CHIP: OnlinePaidChipProps = { size: 64, frozen: false, onChangeSize: () => {} };

describe("OnlinePaidChip: 'Online Chess · up to 64 · paid' with Change size before the freeze, none after", () => {
  it("before the freeze it names the size and offers Change size", () => {
    const markup = render(<OnlinePaidChip {...CHIP} />);
    expect(clean(markup)).toContain("Online Chess · up to 64 · paid");
    expect(markup).toContain('data-testid="online-paid-chip"');
    expect(markup).toContain('data-frozen="false"');
    expect(markup).toContain('data-testid="online-paid-chip-change"');
    expect(clean(markup)).toContain("Change size");
  });

  it("after the freeze the chip stays and Change size is gone (spec 8.7)", () => {
    const markup = render(<OnlinePaidChip {...CHIP} frozen />);
    expect(clean(markup)).toContain("Online Chess · up to 64 · paid");
    expect(markup).toContain('data-frozen="true"');
    expect(markup).not.toContain("online-paid-chip-change");
    expect(clean(markup)).not.toContain("Change size");
  });

  it("a view-only reader gets the chip and no Change size, frozen or not", () => {
    expect(render(<OnlinePaidChip {...CHIP} readOnly />)).not.toContain("online-paid-chip-change");
  });

  it("names every size on the ladder (sweep) and Change size calls its handler once", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      expect(clean(render(<OnlinePaidChip {...CHIP} size={size} />))).toContain(fill(EN["onlineChess.chip.text"]!, { size }));
      checked += 1;
    }
    expect(checked).toBe(5);
    const onChangeSize = vi.fn();
    const tree = renderIsland(OnlinePaidChip, { ...CHIP, onChangeSize }).tree();
    (propsOf(tree.find((e) => propsOf(e)["data-testid"] === "online-paid-chip-change")!).onClick as () => void)();
    expect(onChangeSize).toHaveBeenCalledTimes(1);
  });
});
