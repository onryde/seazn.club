// The Online Chess "Players, up to" select and its price line (spec 2026-11-23-online-chess-credits-design.md §8.1, §8.6; plan Task 11).
// Node render (`renderToStaticMarkup`, assertions anchored on `="` - an omitted prop is serialised as `"$undefined"` in a Next body) for
// what the organiser SEES, and the hook harness for what a pick DOES. The words are the English dictionary's; the numbers are the
// leaf's (the ladder, the rounds each size includes, the price table), never typed into the component and never read back from it.
//
// Anti-vacuity: every sweep reports how many options it checked, and zero is a failure.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { ONLINE_SIZES, includedRounds, packagePrice, type OnlineSize } from "@/lib/online-chess-package";

import { OnlineSizeSelect, type OnlineSizeSelectProps } from "../size-select";
import { OnlinePriceLine } from "../price-line";

const EN = enUi as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

const BASE: OnlineSizeSelectProps = {
  value: 16,
  planCap: null,
  viewerPlan: "pro",
  held: 0,
  rounds: 0,
  cameras: false,
  paid: null,
  onChange: () => {},
};
const html = (props: Partial<OnlineSizeSelectProps> = {}) =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      <OnlineSizeSelect {...BASE} {...props} />
    </DictProvider>,
  );
/** The select's options as the browser reads them: value, disabled, selected, text. Anchored on `="`. */
function optionsOf(markup: string): { value: string; disabled: boolean; selected: boolean; text: string }[] {
  return [...markup.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
    value: m[1]!,
    disabled: /\sdisabled=""/.test(m[2]!),
    selected: /\sselected=""/.test(m[2]!),
    text: m[3]!.replaceAll("&amp;", "&"),
  }));
}
const optionText = (size: OnlineSize, rounds = includedRounds(size)) => fill(EN["onlineChess.size.option"]!, { size, rounds });

describe("OnlineSizeSelect: the five sizes, each with its included rounds", () => {
  it("renders one option per size on the ladder, in order, each with the leaf's rounds, and the value selected", () => {
    const options = optionsOf(html({ value: 32 }));
    expect(options.map((o) => o.value)).toEqual(ONLINE_SIZES.map(String));
    expect(options.map((o) => o.text)).toEqual(ONLINE_SIZES.map((s) => optionText(s)));
    expect(options.map((o) => o.text)).toEqual(["16 · up to 6 rounds", "32 · up to 7 rounds", "64 · up to 8 rounds", "128 · up to 9 rounds", "256 · up to 10 rounds"]);
    expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual(["32"]);
    expect(options.every((o) => !o.disabled)).toBe(true);
  });

  it("carries the test id, the label and the help, and the select is the field's own control", () => {
    const markup = html();
    expect(markup).toContain('data-testid="online-size-select"');
    expect(markup).toContain(`>${EN["onlineChess.size.label"]}</span>`);
    expect(markup).toContain(EN["onlineChess.size.help"]!);
    expect(markup).toMatch(/<label[^>]*>[\s\S]*<select[^>]*data-testid="online-size-select"/); // label wraps its select
  });

  it("a size above the plan is disabled and names the plan; the others stay open (P17)", () => {
    const options = optionsOf(html({ planCap: 32, viewerPlan: "community" }));
    const plan = fill(EN["onlineChess.size.note.plan"]!, { plan: EN["onlineChess.size.plan.community"]! });
    expect(options.map((o) => o.disabled)).toEqual([false, false, true, true, true]);
    for (const o of options.filter((x) => x.disabled)) expect(o.text, o.value).toBe(`${optionText(Number(o.value) as OnlineSize)} · ${plan}`);
    for (const o of options.filter((x) => !x.disabled)) expect(o.text, o.value).not.toContain(plan);
    expect(plan).toBe("not on Community");
  });

  it("the plan reason names each plan's own name, and an unknown plan says 'your plan'", () => {
    const text = (viewerPlan: OnlineSizeSelectProps["viewerPlan"]) => optionsOf(html({ planCap: 16, viewerPlan })).find((o) => o.value === "256")!.text;
    expect(text("community")).toContain("not on Community");
    expect(text("pro")).toContain("not on Pro");
    expect(text("enterprise")).toContain("not on Enterprise");
    expect(text("unknown")).toContain("not on your plan");
  });

  it("a size below the places already held is disabled and says how many are held", () => {
    const options = optionsOf(html({ value: 64, held: 40 }));
    expect(options.map((o) => o.disabled)).toEqual([true, true, false, false, false]);
    expect(options[0]!.text).toBe(`${optionText(16)} · ${fill(EN["onlineChess.size.note.held"]!, { held: 40 })}`);
    expect(options[0]!.text).toContain("40 already entered");
  });

  it("a size with fewer rounds than the division counts is disabled and says so", () => {
    const options = optionsOf(html({ value: 64, rounds: 8 }));
    expect(options.map((o) => o.disabled)).toEqual([true, true, false, false, false]);
    expect(options[1]!.text).toBe(`${optionText(32)} · ${fill(EN["onlineChess.size.note.rounds"]!, { rounds: 8 })}`);
  });

  it("no value (no size holds the places and rounds): an empty option is selected, nothing is picked for the organiser", () => {
    const options = optionsOf(html({ value: null, rounds: 11 }));
    expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual([""]);
    expect(options.filter((o) => o.value !== "")).toHaveLength(ONLINE_SIZES.length);
    expect(options.filter((o) => o.value !== "").every((o) => o.disabled)).toBe(true);
  });

  it("a PAID row labels each size with what moving to it costs or returns, and its own size 'paid'", () => {
    // Paid at 32 without cameras (2 credits): 16 gives 1 back, 64 asks 2 more, 256 asks 14 more.
    const options = optionsOf(html({ value: 32, paid: { size: 32, camerasPaid: false } }));
    const note = (size: OnlineSize) => options.find((o) => o.value === String(size))!.text.replace(`${optionText(size)} · `, "");
    expect(note(32)).toBe("paid");
    expect(note(16)).toBe("1 credit back");
    expect(note(64)).toBe("pay 2 more credits");
    expect(note(256)).toBe("pay 14 more credits");
    expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual(["32"]);
  });

  it("a paid row's differences follow the leaf's price table, every size (sweep)", () => {
    let checked = 0;
    for (const paid of ONLINE_SIZES) {
      for (const camerasPaid of [false, true]) {
        const options = optionsOf(html({ value: paid, cameras: camerasPaid, paid: { size: paid, camerasPaid } }));
        expect(options).toHaveLength(ONLINE_SIZES.length);
        for (const o of options) {
          const size = Number(o.value) as OnlineSize;
          const diff = packagePrice(size, camerasPaid) - packagePrice(paid, camerasPaid);
          const expected = diff === 0 ? "paid" : diff > 0 ? `pay ${diff} more credit${diff === 1 ? "" : "s"}` : `${-diff} credit${diff === -1 ? "" : "s"} back`;
          expect(o.text, `paid ${paid}${camerasPaid ? " + cameras" : ""} → ${size}`).toBe(`${optionText(size)} · ${expected}`);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(ONLINE_SIZES.length * 2 * ONLINE_SIZES.length);
  });

  it("a frozen package reads only: the select is disabled", () => {
    const frozen = html({ value: 64, paid: { size: 64, camerasPaid: false }, frozen: true });
    expect(frozen).toMatch(/<select[^>]*\sdisabled=""/);
    expect(html({ value: 64 })).not.toMatch(/<select[^>]*\sdisabled=""/);
  });

  it("disabled (a save in flight) greys the select, and option text carries no raw key", () => {
    expect(html({ disabled: true })).toMatch(/<select[^>]*\sdisabled=""/);
    expect(html({ planCap: 16, held: 20, rounds: 9, paid: { size: 32, camerasPaid: false } })).not.toMatch(/onlineChess\./);
  });
});

describe("OnlineSizeSelect: what a pick does", () => {
  const pick = (island: { tree: () => ReactElement[] }, size: number) => {
    const select = island.tree().find((e) => propsOf(e)["data-testid"] === "online-size-select") as ReactElement;
    (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: String(size) } });
  };

  it("an unpaid pick calls onChange with the size as a number, once", () => {
    const onChange = vi.fn();
    const onPaidPick = vi.fn();
    pick(renderIsland(OnlineSizeSelect, { ...BASE, onChange, onPaidPick }), 64);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(64);
    expect(onPaidPick).not.toHaveBeenCalled();
  });

  it("on a paid division a pick calls onPaidPick and NEVER onChange (the strip's save refuses a paid row)", () => {
    const onChange = vi.fn();
    const onPaidPick = vi.fn();
    pick(renderIsland(OnlineSizeSelect, { ...BASE, value: 32, paid: { size: 32, camerasPaid: false }, onChange, onPaidPick }), 128);
    expect(onPaidPick).toHaveBeenCalledExactlyOnceWith(128);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a paid pick with no receipt callback is swallowed, never saved", () => {
    const onChange = vi.fn();
    pick(renderIsland(OnlineSizeSelect, { ...BASE, value: 32, paid: { size: 32, camerasPaid: false }, onChange }), 128);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the empty value and a size off the ladder pick nothing", () => {
    const onChange = vi.fn();
    const island = renderIsland(OnlineSizeSelect, { ...BASE, onChange });
    pick(island, 0);
    pick(island, 48);
    const select = island.tree().find((e) => propsOf(e)["data-testid"] === "online-size-select") as ReactElement;
    (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a greyed size is never picked, even by a hand-made event (below the held places, over the plan, short of the rounds)", () => {
    const onChange = vi.fn();
    const island = renderIsland(OnlineSizeSelect, { ...BASE, value: 128, held: 40, rounds: 9, planCap: 128, onChange });
    // 16 and 32 are under the 40 held, 64 is under the 9 rounds, 256 is over the 128 plan cap: only 128 is open.
    for (const size of [16, 32, 64, 256]) pick(island, size);
    expect(onChange).not.toHaveBeenCalled();
    pick(island, 128);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(128);
  });

  it("a paid pick of the row's own size is nothing to do", () => {
    const onChange = vi.fn();
    const onPaidPick = vi.fn();
    pick(renderIsland(OnlineSizeSelect, { ...BASE, value: 32, paid: { size: 32, camerasPaid: false }, onChange, onPaidPick }), 32);
    expect(onChange).not.toHaveBeenCalled();
    expect(onPaidPick).not.toHaveBeenCalled();
  });

  it("the options are real <option>s the tree can see (premise for the handler tests above)", () => {
    const island = renderIsland(OnlineSizeSelect, BASE);
    expect(island.tree().filter((e) => e.type === "option")).toHaveLength(ONLINE_SIZES.length);
  });
});

describe("OnlinePriceLine: '{price} credits · You have {balance} · Buy more'", () => {
  const line = (props: Partial<Parameters<typeof OnlinePriceLine>[0]> = {}) =>
    renderToStaticMarkup(
      <DictProvider dict={enUi as Dict} locale="en">
        <OnlinePriceLine quote={{ price: 8, balance: 11 }} buyMoreHref="/o/acme/settings/credits?kind=stream" {...props} />
      </DictProvider>,
    );
  const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("reads the price, the balance and Buy more, in that order, with the test id", () => {
    const markup = line();
    expect(markup).toContain('data-testid="online-price-line"');
    expect(text(markup)).toContain("Online Chess: 8 credits · You have 11 credits · Buy more");
    // The reassurance that nothing is spent here comes after the figures.
    expect(text(markup).indexOf("Buy more")).toBeLessThan(text(markup).indexOf(EN["onlineChess.price.later"]!));
  });

  it("the price is the quote's, whatever the size: 1 credit is singular, 0 balance reads '0 credits'", () => {
    expect(text(line({ quote: { price: 1, balance: 1 } }))).toContain("Online Chess: 1 credit · You have 1 credit · Buy more");
    expect(text(line({ quote: { price: 2, balance: 0 } }))).toContain("You have 0 credits");
  });

  it("Buy more is a real link to where credits are bought, opening a new tab so a half-made division survives", () => {
    const markup = line();
    expect(markup).toMatch(/<a [^>]*href="\/o\/acme\/settings\/credits\?kind=stream"/);
    expect(markup).toMatch(/<a [^>]*target="_blank"/);
    expect(markup).toMatch(/<a [^>]*rel="noopener noreferrer"/);
  });

  it("with a callback instead of a link, Buy more is a button that calls it", () => {
    const onBuyMore = vi.fn();
    const island = renderIsland(OnlinePriceLine, { quote: { price: 8, balance: 11 }, onBuyMore });
    const button = island.tree().find((e) => e.type === "button" && propsOf(e)["data-testid"] === "online-buy-more") as ReactElement;
    expect(button).toBeDefined();
    (propsOf(button).onClick as () => void)();
    expect(onBuyMore).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(<DictProvider dict={enUi as Dict} locale="en"><OnlinePriceLine quote={{ price: 8, balance: 11 }} onBuyMore={onBuyMore} /></DictProvider>)).not.toMatch(/<a /);
  });

  it("a short balance is marked (the price is more than the balance), an enough one is not", () => {
    expect(line({ quote: { price: 8, balance: 3 } })).toContain('data-short="true"');
    expect(line({ quote: { price: 8, balance: 8 } })).not.toContain('data-short="true"');
    expect(line({ quote: { price: 8, balance: 8 } })).toContain('data-short="false"');
  });

  it("has no pay control: nothing here spends (a button, a form or a pay word)", () => {
    const markup = line();
    expect(markup).not.toMatch(/<button/);
    expect(markup).not.toMatch(/<form/);
    expect(text(markup).toLowerCase()).not.toMatch(/\bpay now\b|\bpurchase\b|\bspend\b/);
  });
});
