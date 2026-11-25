// The amber pay line (spec 2026-11-23-online-chess-credits-design.md §8.3; plan Task 12).
// Node render (`renderToStaticMarkup`, assertions anchored on `="` - an omitted prop is serialised as `"$undefined"` in a Next body) for what the
// organiser SEES; the hook harness for what a press DOES. The words are the English dictionary's, the numbers are the price leaf's.
//
// Anti-vacuity: every sweep reports how many cells it checked and zero is a failure.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { ONLINE_SIZES, packagePrice } from "@/lib/online-chess-package";
import { OnlinePayLine, type OnlinePayLineProps } from "../pay-line";

const EN = enUi as Record<string, string>;
const render = (node: React.ReactNode, dict: Dict = enUi as Dict, locale: "en" | "es" | "fr" | "nl" = "en") =>
  renderToStaticMarkup(<DictProvider dict={dict} locale={locale}>{node}</DictProvider>);
const clean = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const LINE: OnlinePayLineProps = { held: 41, size: 64, owed: packagePrice(64, true), onChangeSize: () => {}, onPay: () => {} };

describe("OnlinePayLine: 'Online Chess not paid. {held} registered, up to {size}. No Online Chess round can open until it's paid.'", () => {
  it("says the sentence the spec gives, with the held count and the stored size", () => {
    const markup = render(<OnlinePayLine {...LINE} />);
    expect(clean(markup)).toContain("Online Chess not paid. 41 registered, up to 64. No Online Chess round can open until it's paid.");
    expect(markup).toContain('data-testid="online-pay-line"');
  });

  it("offers Change size and Pay {owed} credits, owed from the leaf (64 players with the Fair-play camera = 8 credits, the spec's example)", () => {
    const markup = render(<OnlinePayLine {...LINE} />);
    expect(LINE.owed).toBe(8); // the spec's own example: 64 players is 4 credits, the camera doubles it
    expect(markup).toContain('data-testid="online-pay-line-change"');
    expect(markup).toContain('data-testid="online-pay-line-pay"');
    expect(clean(markup)).toContain("Change size");
    expect(clean(markup)).toContain("Pay 8 credits");
  });

  it("the amount follows the leaf at every size and camera state, and one credit reads 'credit' (sweep)", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      for (const cameras of [false, true]) {
        const owed = packagePrice(size, cameras);
        const text = clean(render(<OnlinePayLine {...LINE} size={size} owed={owed} />));
        expect(text, `${size}/${cameras}`).toContain(owed === 1 ? "Pay 1 credit" : `Pay ${owed} credits`);
        expect(text).not.toContain("Pay 1 credits");
        checked += 1;
      }
    }
    expect(checked).toBe(10);
    expect(clean(render(<OnlinePayLine {...LINE} size={16} owed={1} />))).toContain("Pay 1 credit");
  });

  it("zero registered still reads as a sentence, and the buttons are 44px tall on a phone", () => {
    const markup = render(<OnlinePayLine {...LINE} held={0} />);
    expect(clean(markup)).toContain("0 registered, up to 64");
    expect(markup.match(/min-h-11/g)?.length).toBe(2);
  });

  it("Pay is the first button on a phone (reversed column) and Change size sits left of it from md", () => {
    const markup = render(<OnlinePayLine {...LINE} />);
    expect(markup).toMatch(/flex min-w-0 flex-col-reverse gap-2 md:flex-row/);
    expect(markup.indexOf("online-pay-line-change")).toBeLessThan(markup.indexOf("online-pay-line-pay")); // DOM: Change, Pay; the column reverses it on a phone
  });

  it("the buttons call their handlers, once each, and nothing else", () => {
    const onChangeSize = vi.fn();
    const onPay = vi.fn();
    const tree = renderIsland(OnlinePayLine, { ...LINE, onChangeSize, onPay }).tree();
    const by = (id: string) => tree.find((e) => propsOf(e)["data-testid"] === id)!;
    (propsOf(by("online-pay-line-pay")).onClick as () => void)();
    expect([onChangeSize.mock.calls.length, onPay.mock.calls.length]).toEqual([0, 1]);
    (propsOf(by("online-pay-line-change")).onClick as () => void)();
    expect([onChangeSize.mock.calls.length, onPay.mock.calls.length]).toEqual([1, 1]);
  });

  it("a view-only reader reads the sentence and gets no buttons", () => {
    const markup = render(<OnlinePayLine {...LINE} readOnly />);
    expect(clean(markup)).toContain("Online Chess not paid");
    expect(markup).not.toContain("online-pay-line-pay");
    expect(markup).not.toContain("online-pay-line-change");
  });

  it("is in every language the product ships, with the same placeholders (sweep)", () => {
    let checked = 0;
    for (const [name, dict] of [["es", esUi], ["fr", frUi], ["nl", nlUi]] as const) {
      const d = dict as Record<string, string>;
      for (const key of ["onlineChess.payLine.text", "onlineChess.payLine.change", "onlineChess.payLine.pay.one", "onlineChess.payLine.pay.other", "onlineChess.chip.text", "onlineChess.chip.change", "onlineChess.flag.text"]) {
        expect(d[key], `${name} ${key}`).toBeTruthy();
        expect(d[key], `${name} ${key} is translated`).not.toBe(EN[key]);
        const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(holes(d[key]!), `${name} ${key} placeholders`).toEqual(holes(EN[key]!));
        checked += 1;
      }
    }
    expect(checked).toBe(21);
    const fr = render(<OnlinePayLine {...LINE} />, frUi as Dict, "fr");
    expect(clean(fr)).toContain("41 inscrits, jusqu'à 64");
  });
});
