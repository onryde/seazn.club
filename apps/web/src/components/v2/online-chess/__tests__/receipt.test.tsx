// The Online Chess receipt (spec 2026-11-23-online-chess-credits-design.md §8.4-§8.6; plan Task 12), driven the way a browser would: the hook
// harness for what a pick and a press DO (the read, the 409, the short balance, the double tap), `renderToStaticMarkup` for what the organiser
// SEES (assertions anchored on `="`).
//
// Expected values come from the spec and the price leaf (`packagePrice`, `includedRounds`), never from the receipt. Anti-vacuity: every sweep
// reports how many cells it checked and zero is a failure. Every quote is the SERVER's own shape (`OnlinePackageQuote`), built by `quoteOf`.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import { ApiV1Error } from "@/lib/client-v1";
import type { Dict } from "@/lib/i18n-constants";
import { ONLINE_PACKAGE_CODES, ONLINE_SIZES, includedRounds, packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import type { PayBody, ReceiptMode, ReceiptQuote } from "@/lib/online-receipt";
import { quoteOf, type QuoteSpec } from "@/lib/__tests__/_receipt-quote";
import { OnlineReceipt, type OnlineReceiptProps, type ReceiptFacts } from "../receipt";
import { expandAll, textOfAll } from "./_receipt-tree";

const EN = enUi as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
const clean = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const FACTS: ReceiptFacts = { planCap: null, held: 0, rounds: 0, cameras: false, paid: null, storedSize: 64, viewerPlan: "pro" };
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

interface Over extends Partial<Omit<OnlineReceiptProps, "facts">> {
  facts?: Partial<ReceiptFacts>;
}
function make(over: Over = {}) {
  const readQuote = vi.fn(async (choice: { size: OnlineSize; addCameras: boolean }): Promise<ReceiptQuote> => quoteOf({ size: choice.size, cameras: choice.addCameras, monthly: 20, pack: 20 }));
  const onConfirm = vi.fn(async (body: PayBody): Promise<void> => { void body; });
  const onClose = vi.fn();
  const props: OnlineReceiptProps = {
    mode: "pay",
    facts: { ...FACTS, ...over.facts },
    size: 64,
    quote: null,
    readQuote,
    onConfirm,
    onClose,
    ...over,
  } as OnlineReceiptProps;
  props.facts = { ...FACTS, ...over.facts };
  const island = renderIsland(OnlineReceipt, props);
  const els = () => expandAll(island.tree());
  const by = (id: string) => els().find((e) => propsOf(e)["data-testid"] === id);
  const has = (id: string) => by(id) !== undefined;
  const text = () => textOfAll([island.tree()[0]!]);
  const press = (id: string) => (propsOf(by(id)!).onClick as () => unknown)();
  const pick = (size: number) => (propsOf(by(`online-receipt-size-${size}`)!).onChange as () => void)();
  // The mocks the receipt was GIVEN: an override replaces the default, and a test asserting on the default would read zero calls for ever.
  return {
    island, props, els, by, has, text, press, pick,
    readQuote: props.readQuote as unknown as ReturnType<typeof vi.fn>,
    onConfirm: props.onConfirm as unknown as ReturnType<typeof vi.fn>,
    onClose: props.onClose as unknown as ReturnType<typeof vi.fn>,
  };
}
const root = (m: ReturnType<typeof make>) => propsOf(m.by("online-receipt")!);
const confirmLabel = (m: ReturnType<typeof make>) => textOfAll([m.by("online-receipt-confirm")!]);
const spec = (s: QuoteSpec) => quoteOf(s);

describe("pay mode: the receipt of the stored size (spec 8.4)", () => {
  it("reads the quote for the stored size on open, then draws the rows, the total and the confirm: 64 with camera = 8 credits, 3 + 5", async () => {
    const m = make({ readQuote: vi.fn(async () => spec({ size: 64, cameras: true, monthly: 3, pack: 5 })) });
    expect(m.readQuote).toHaveBeenCalledWith({ size: 64, addCameras: false });
    expect(m.text()).toContain(EN["onlineChess.receipt.checking"]);
    await flush();
    expect(m.text()).toContain("Up to 64 players · up to 8 rounds");
    expect(m.text()).toContain("Fair-play camera");
    expect(propsOf(m.by("online-receipt-row-monthly")!).children).toBeDefined();
    expect(textOfAll([m.by("online-receipt-row-monthly")!])).toBe("From this month's credits expire 30 Nov 3");
    expect(textOfAll([m.by("online-receipt-row-bought")!])).toBe("From bought credits 5");
    expect(textOfAll([m.by("online-receipt-row-total")!])).toBe("Total 8 credits");
    expect(confirmLabel(m)).toBe("Pay 8 credits");
    expect(root(m)["data-confirm"]).toBe("pay");
    expect(includedRounds(64)).toBe(8); // the leaf behind the "up to 8 rounds" line
  });

  it("a row with 0 is not shown: nothing from this month's credits hides that row; nothing bought hides the other", async () => {
    const onlyBought = make({ readQuote: vi.fn(async () => spec({ size: 32, monthly: 0, pack: 10 })), size: 32 });
    await flush();
    expect(onlyBought.has("online-receipt-row-monthly")).toBe(false);
    expect(onlyBought.has("online-receipt-row-bought")).toBe(true);
    const onlyMonthly = make({ readQuote: vi.fn(async () => spec({ size: 32, monthly: 10, pack: 0 })), size: 32 });
    await flush();
    expect(onlyMonthly.has("online-receipt-row-monthly")).toBe(true);
    expect(onlyMonthly.has("online-receipt-row-bought")).toBe(false);
  });

  it("the confirm sends the size and the total shown, and closes on success", async () => {
    const m = make({ size: 32, readQuote: vi.fn(async () => spec({ size: 32, monthly: 1, pack: 5 })) });
    await flush();
    await m.press("online-receipt-confirm");
    expect(m.onConfirm).toHaveBeenCalledTimes(1);
    expect(m.onConfirm).toHaveBeenCalledWith({ size: 32, expectedOwed: packagePrice(32, false) });
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it("the confirm is off while the quote is read, and says so", () => {
    const m = make();
    expect(propsOf(m.by("online-receipt-confirm")!).disabled).toBe(true);
    expect(confirmLabel(m)).toBe(EN["onlineChess.receipt.confirm.checking"]);
  });

  it("a read that fails says the price could not be checked and leaves nothing to press", async () => {
    const m = make({ readQuote: vi.fn(async () => { throw new Error("offline"); }) });
    await flush();
    expect(m.has("online-receipt-unclear")).toBe(true);
    expect(propsOf(m.by("online-receipt-confirm")!).disabled).toBe(true);
    expect(m.has("online-receipt-rows")).toBe(false);
    expect(m.readQuote).toHaveBeenCalledTimes(1); // not read again in a loop
  });

  it("never sends a figure the server did not give: a quote whose parts do not add up is not payable", async () => {
    const good = spec({ size: 32, monthly: 5, pack: 5 });
    const m = make({ size: 32, readQuote: vi.fn(async () => ({ ...good, take: { monthly: 1, pack: 0 } })) });
    await flush();
    expect(m.has("online-receipt-unclear")).toBe(true);
    expect(propsOf(m.by("online-receipt-confirm")!).disabled).toBe(true);
    await m.press("online-receipt-confirm");
    expect(m.onConfirm).not.toHaveBeenCalled();
  });
});

describe("payAndOpen: Open round 1 on an unpaid division (spec 8.5, decision 15)", () => {
  const FACT = { held: 30, storedSize: 64 as OnlineSize };

  it("opens on the STORED size with the others listed: each with its price, and a smaller one that fits with where late entry would stop", async () => {
    const stored = spec({ size: 64, monthly: 20, held: 30 });
    const m = make({ mode: "payAndOpen", size: 64, quote: stored, facts: FACT });
    expect(m.readQuote).not.toHaveBeenCalled(); // the 402's quote is in hand
    const radios = ONLINE_SIZES.map((s) => propsOf(m.by(`online-receipt-size-${s}`)!));
    expect(radios.map((r) => r.checked)).toEqual([false, false, true, false, false]);
    expect(radios.map((r) => r.disabled)).toEqual([true, false, false, false, false]); // 16 holds fewer than the 30 entered
    expect(m.text()).toContain(fill(EN["onlineChess.receipt.size.price.other"]!, { count: packagePrice(128, false) }));
    expect(m.text()).toContain(fill(EN["onlineChess.receipt.size.price.other"]!, { count: packagePrice(32, false) }));
    expect(textOfAll([m.by("online-receipt-size-32-why")!])).toBe("30 have entered. Late entry would stop at 32.");
    expect(textOfAll([m.by("online-receipt-size-16-why")!])).toBe("30 already entered");
    expect(m.has("online-receipt-size-64-why")).toBe(false); // the chosen size has no consequence
    expect(m.has("online-receipt-size-128-why")).toBe(false); // a larger one has none
    expect(m.text()).toContain(EN["onlineChess.receipt.size.yours"]);
    expect(confirmLabel(m)).toBe("Pay 4 credits and open round 1");
    expect(m.text()).toContain(EN["onlineChess.receipt.line.fixed"]);
  });

  it("picking another size hides the old total at once and reads that size's own price", async () => {
    const m = make({ mode: "payAndOpen", size: 64, quote: spec({ size: 64, monthly: 20, held: 30 }), facts: FACT });
    m.pick(128);
    expect(root(m)["data-size"]).toBe("128");
    expect(m.has("online-receipt-row-total")).toBe(false); // the old size's total is not under the new pick
    expect(m.text()).toContain(EN["onlineChess.receipt.checking"]);
    expect(propsOf(m.by("online-receipt-confirm")!).disabled).toBe(true);
    expect(m.readQuote).toHaveBeenCalledWith({ size: 128, addCameras: false });
    await flush();
    expect(textOfAll([m.by("online-receipt-row-total")!])).toBe(`Total ${packagePrice(128, false)} credits`);
    expect(confirmLabel(m)).toBe(`Pay ${packagePrice(128, false)} credits and open round 1`);
  });

  it("a greyed size is never picked, even by a hand-made event", () => {
    const m = make({ mode: "payAndOpen", size: 64, quote: spec({ size: 64, monthly: 20, held: 30 }), facts: FACT });
    expect(propsOf(m.by("online-receipt-size-16")!).disabled).toBe(true);
  });

  it("every disabled size carries the reason the server's order gives: held, then plan, then rounds (sweep)", () => {
    const m = make({ mode: "payAndOpen", size: 64, quote: spec({ size: 64, monthly: 20, held: 20 }), facts: { held: 20, rounds: 8, planCap: 64, storedSize: 64 } });
    const reasons = ONLINE_SIZES.map((s) => (m.has(`online-receipt-size-${s}-why`) ? textOfAll([m.by(`online-receipt-size-${s}-why`)!]) : null));
    expect(reasons).toEqual(["20 already entered", "fewer than your 8 rounds", null, "not on Pro", "not on Pro"]);
    expect(reasons.filter((r) => r !== null).length).toBe(4);
  });

  it("the server's refusal of the stored size opens on the size it offered, which is confirmed by its own price", async () => {
    const m = make({ mode: "payAndOpen", size: 32, quote: spec({ size: 32, monthly: 20, held: 30 }), facts: { ...FACT, storedSize: 16 } });
    expect(root(m)["data-size"]).toBe("32");
    expect(confirmLabel(m)).toBe(`Pay ${packagePrice(32, false)} credits and open round 1`);
  });

  it("warns when nobody can be invited yet: pay now, re-open free once they link", () => {
    const m = make({ mode: "payAndOpen", size: 64, quote: spec({ size: 64, monthly: 20 }), warnings: { noInvitable: true } });
    expect(m.text()).toContain("No player has linked Lichess yet. You'll pay now and can re-open round 1 for free once they link.");
    const quiet = make({ mode: "payAndOpen", size: 64, quote: spec({ size: 64, monthly: 20 }) });
    expect(quiet.has("online-receipt-no-invitable")).toBe(false);
  });

  it("says promoted waiting-list players miss round 1 ONLY when the pay moves the size up (ruling 4)", async () => {
    const stored = spec({ size: 32, monthly: 20, held: 32 });
    const m = make({ mode: "payAndOpen", size: 32, quote: stored, facts: { held: 32, storedSize: 32 } });
    expect(m.has("online-receipt-late-entrants")).toBe(false); // the stored size: nobody is promoted
    m.pick(64);
    await flush();
    expect(m.has("online-receipt-late-entrants")).toBe(true);
    expect(textOfAll([m.by("online-receipt-late-entrants")!])).toBe("Anyone promoted from the waiting list joins as a late entrant and misses round 1.");
    m.pick(128);
    await flush();
    expect(m.has("online-receipt-late-entrants")).toBe(true);
    m.pick(32);
    await flush();
    expect(m.has("online-receipt-late-entrants")).toBe(false);
    // a smaller size promotes nobody, and a refused one prices nothing
    const down = make({ mode: "payAndOpen", size: 64, quote: spec({ size: 64, monthly: 20, held: 20 }), facts: { held: 20, storedSize: 64 } });
    down.pick(32);
    await flush();
    expect(down.has("online-receipt-late-entrants")).toBe(false);
    // and never on a pay or a change receipt: only Open round promotes at open
    const pay = make({ mode: "pay", size: 32, readQuote: vi.fn(async () => spec({ size: 32, monthly: 20 })) });
    await flush();
    expect(pay.has("online-receipt-late-entrants")).toBe(false);
  });
});

describe("change mode: a paid size moved up or down (spec 8.6)", () => {
  const PAID = { size: 64 as OnlineSize, camerasPaid: false };
  const CH = { paid: PAID, storedSize: 64 as OnlineSize };

  it("opens on its size list with no size chosen: every other size, each with its difference, and nothing to confirm yet", () => {
    const m = make({ mode: "change", size: null, facts: CH });
    expect(m.readQuote).not.toHaveBeenCalled();
    expect(ONLINE_SIZES.filter((s) => m.has(`online-receipt-size-${s}`))).toEqual([16, 32, 128, 256]); // not the paid one
    expect(m.text()).toContain("3 credits back"); // 16: 1 - 4
    expect(m.text()).toContain("pay 4 more credits"); // 128: 8 - 4
    expect(confirmLabel(m)).toBe(EN["onlineChess.receipt.confirm.choose"]);
    expect(propsOf(m.by("online-receipt-confirm")!).disabled).toBe(true);
  });

  it("a move down shows the quote's back split and sends the credits the receipt said would not come back", async () => {
    // 64 with camera paid (8) moved to 32 with camera (4): 4 return; 1 of them is an earlier month's included credit, forfeited.
    const down = spec({ size: 32, cameras: true, paid: { size: 64, camerasPaid: true }, forfeited: 1, backMonthly: 1 });
    const m = make({ mode: "change", size: 32, facts: { paid: { size: 64, camerasPaid: true }, storedSize: 64, cameras: true }, readQuote: vi.fn(async () => down) });
    await flush();
    expect(textOfAll([m.by("online-receipt-row-back-bought")!])).toBe("Back to bought credits 2");
    expect(textOfAll([m.by("online-receipt-row-back-monthly")!])).toBe("Back to this month's credits expire 30 Nov 1");
    expect(textOfAll([m.by("online-receipt-row-not-returned")!])).toBe("Not returned 1");
    expect(textOfAll([m.by("online-receipt-not-returned-why")!])).toBe("1 included credit from an earlier month has expired.");
    // RULING 2: the button says what comes BACK (bought + this month's = 3), never the quote's owed (4) - the forfeited one does not return.
    expect(confirmLabel(m)).toBe("Move down · 3 credits back");
    expect(confirmLabel(m)).not.toContain("4");
    await m.press("online-receipt-confirm");
    expect(m.onConfirm).toHaveBeenCalledWith({ size: 32, expectedOwed: -4, expectedForfeited: 1 });
  });

  it("the Not returned row is shown at 0 on a move down and carries no reason (the spec's own mock)", async () => {
    const down = spec({ size: 32, paid: { size: 64, camerasPaid: false }, backMonthly: 1 });
    const m = make({ mode: "change", size: 32, facts: CH, readQuote: vi.fn(async () => down) });
    await flush();
    expect(textOfAll([m.by("online-receipt-row-not-returned")!])).toBe("Not returned 0");
    expect(m.has("online-receipt-not-returned-why")).toBe(false);
    expect(confirmLabel(m)).toBe("Move down · 2 credits back");
  });

  it("a move up pays the difference, and the title says so", async () => {
    const up = spec({ size: 128, paid: PAID, monthly: 20 });
    const m = make({ mode: "change", size: 128, facts: CH, readQuote: vi.fn(async () => up) });
    await flush();
    expect(confirmLabel(m)).toBe("Pay 4 credits");
    expect(textOfAll([m.by("online-receipt-row-total")!])).toBe("Total 4 credits");
    expect(propsOf(m.els()[0]!).title).toBe("Move up to 128 players");
  });

  // Fix round 2: the OLD version of this test mounted the receipt on size 64, the paid size - a state no entry point creates (the chip opens a change
  // receipt with NO size chosen, and the list leaves the paid size out). It passed while the camera upgrade was unreachable. The state below is the chip's.
  const cameraRead = vi.fn(async (c: { size: OnlineSize; addCameras: boolean }) => spec({ size: c.size, cameras: c.addCameras, paid: PAID, monthly: 20 }));
  const CAMERA_DIFF = () => packagePrice(64, true) - packagePrice(64, false);
  const tick = (m: ReturnType<typeof make>, checked: boolean) => (propsOf(m.by("online-receipt-cameras")!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked } });

  it("Add Fair-play camera from the state the chip opens (NO size chosen): the tick chooses the PAID size, reads its camera quote, owes the camera difference and sends addCameras", async () => {
    cameraRead.mockClear();
    const m = make({ mode: "change", size: null, facts: CH, readQuote: cameraRead });
    await flush();
    expect(cameraRead, "premise: nothing is chosen, so nothing is read").not.toHaveBeenCalled();
    expect(confirmLabel(m), "premise: the button waits for a size").toBe("Choose a size");
    expect(m.has("online-receipt-cameras")).toBe(true);
    expect(m.has("online-receipt-cameras-paid")).toBe(false);
    tick(m, true);
    expect(cameraRead).toHaveBeenLastCalledWith({ size: 64, addCameras: true });
    await flush();
    expect(CAMERA_DIFF(), "premise: the camera costs credits at 64").toBeGreaterThan(0);
    expect(confirmLabel(m)).toBe(`Pay ${CAMERA_DIFF()} credits`);
    expect(textOfAll([m.by("online-receipt-row-total")!])).toBe(`Total ${CAMERA_DIFF()} credits`);
    expect(propsOf(m.els()[0]!).title, "it is not a move UP to the size it already is").toBe("Add the Fair-play camera");
    expect(textOfAll([m.by("online-receipt-cameras-paid")!])).toBe("Fair-play camera is paid. Turn it on in Division rules.");
    await m.press("online-receipt-confirm");
    expect(m.onConfirm).toHaveBeenCalledWith({ size: 64, expectedOwed: CAMERA_DIFF(), addCameras: true });
  });

  it("unticking the camera gives the 'choose a size' state back (the paid size without a camera is nothing to pay)", async () => {
    cameraRead.mockClear();
    const m = make({ mode: "change", size: null, facts: CH, readQuote: cameraRead });
    tick(m, true);
    await flush();
    expect(confirmLabel(m)).toBe(`Pay ${CAMERA_DIFF()} credits`);
    tick(m, false);
    await flush();
    expect(confirmLabel(m)).toBe("Choose a size");
    expect(m.has("online-receipt-row-total")).toBe(false);
    expect(propsOf(m.els()[0]!).title).toBe("Change the Online Chess size");
  });

  it("a move with cameras still works: pick a size, then tick - the quote is for THAT size with the camera, and the title is the move's", async () => {
    cameraRead.mockClear();
    const m = make({ mode: "change", size: null, facts: CH, readQuote: cameraRead });
    m.pick(128);
    await flush();
    tick(m, true);
    expect(cameraRead).toHaveBeenLastCalledWith({ size: 128, addCameras: true });
    await flush();
    expect(confirmLabel(m)).toBe(`Pay ${packagePrice(128, true) - packagePrice(64, false)} credits`);
    expect(propsOf(m.els()[0]!).title).toBe("Move up to 128 players");
    await m.press("online-receipt-confirm");
    expect(m.onConfirm).toHaveBeenCalledWith({ size: 128, expectedOwed: packagePrice(128, true) - packagePrice(64, false), addCameras: true });
  });

  it("no camera checkbox where the camera is already paid, or the package is not paid yet", () => {
    expect(make({ mode: "change", size: null, facts: { paid: { size: 64, camerasPaid: true }, storedSize: 64 } }).has("online-receipt-cameras")).toBe(false);
    expect(make({ mode: "pay", size: 64 }).has("online-receipt-cameras")).toBe(false);
  });
});

describe("409 ONLINE_QUOTE_CHANGED: redraw, say so, take nothing until the organiser confirms the new figure (ruling 7)", () => {
  it("redraws with the fresh quote and the price-changed line; onConfirm is called exactly once", async () => {
    const first = spec({ size: 32, monthly: 20 });
    const fresh = spec({ size: 32, cameras: true, monthly: 20 }); // someone turned the camera on
    const onConfirm = vi.fn(async (): Promise<void> => {
      throw new ApiV1Error("changed", 409, ONLINE_PACKAGE_CODES.quoteChanged, { quote: fresh });
    });
    const m = make({ size: 32, readQuote: vi.fn(async () => first), onConfirm });
    await flush();
    expect(confirmLabel(m)).toBe("Pay 2 credits");
    await m.press("online-receipt-confirm");
    await flush();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(m.onClose).not.toHaveBeenCalled(); // still open
    expect(textOfAll([m.by("online-receipt-changed")!])).toBe("The price changed. Check it and confirm again.");
    expect(textOfAll([m.by("online-receipt-row-total")!])).toBe(`Total ${packagePrice(32, true)} credits`);
    expect(confirmLabel(m)).toBe(`Pay ${packagePrice(32, true)} credits`);
    expect(propsOf(m.by("online-receipt-confirm")!).disabled).toBe(false);
    expect(m.readQuote).toHaveBeenCalledTimes(1); // the 409 carried the quote: no second read
  });

  it("the NEXT press, and only a deliberate one, sends the new total", async () => {
    const first = spec({ size: 32, monthly: 20 });
    const fresh = spec({ size: 32, cameras: true, monthly: 20 });
    let calls = 0;
    const onConfirm = vi.fn(async (b: PayBody): Promise<void> => {
      void b;
      calls += 1;
      if (calls === 1) throw new ApiV1Error("changed", 409, ONLINE_PACKAGE_CODES.quoteChanged, { quote: fresh });
    });
    const m = make({ size: 32, readQuote: vi.fn(async () => first), onConfirm });
    await flush();
    await m.press("online-receipt-confirm");
    await flush();
    expect(onConfirm.mock.calls.map((c) => c[0].expectedOwed)).toEqual([packagePrice(32, false)]); // nothing sent for the new figure yet
    await m.press("online-receipt-confirm");
    expect(onConfirm.mock.calls.map((c) => c[0].expectedOwed)).toEqual([packagePrice(32, false), packagePrice(32, true)]);
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it("a 409 whose body carries no usable quote is a failure sentence, not a half-drawn receipt", async () => {
    const onConfirm = vi.fn(async (): Promise<void> => {
      throw new ApiV1Error("changed", 409, ONLINE_PACKAGE_CODES.quoteChanged, {});
    });
    const m = make({ size: 32, readQuote: vi.fn(async () => spec({ size: 32, monthly: 20 })), onConfirm });
    await flush();
    await m.press("online-receipt-confirm");
    await flush();
    expect(m.has("online-receipt-changed")).toBe(false);
    expect(m.has("online-receipt-error")).toBe(true);
    expect(m.text()).toContain(EN["onlineChess.receipt.err.generic"]);
  });
});

describe("a double tap is one payment", () => {
  it("two presses before the first settles call onConfirm once (the in-flight guard is a ref)", async () => {
    let release: () => void = () => {};
    const onConfirm = vi.fn((b: PayBody) => new Promise<void>((res) => { void b; release = res; }));
    const m = make({ size: 32, readQuote: vi.fn(async () => spec({ size: 32, monthly: 20 })), onConfirm });
    await flush();
    const handler = propsOf(m.by("online-receipt-confirm")!).onClick as () => unknown;
    void handler();
    void handler(); // the same render's handler, before `submitting` has re-rendered anything
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(propsOf(m.by("online-receipt-confirm")!).disabled).toBe(true);
    release();
    await flush();
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it("while a payment is in flight the dialog cannot be dismissed from behind (Escape and the backdrop are no-ops), and Cancel is off", async () => {
    let release: () => void = () => {};
    const onConfirm = vi.fn((b: PayBody) => new Promise<void>((res) => { void b; release = res; }));
    const m = make({ size: 32, readQuote: vi.fn(async () => spec({ size: 32, monthly: 20 })), onConfirm });
    await flush();
    expect(typeof propsOf(m.els()[0]!).onClose).toBe("function");
    void (propsOf(m.by("online-receipt-confirm")!).onClick as () => unknown)();
    (propsOf(m.els()[0]!).onClose as () => void)();
    expect(m.onClose).not.toHaveBeenCalled();
    expect(propsOf(m.by("online-receipt-cancel")!).disabled).toBe(true);
    release();
    await flush();
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it("a failed press leaves the receipt open and armed again, with a sentence and no half-state", async () => {
    let n = 0;
    const onConfirm = vi.fn(async (b: PayBody): Promise<void> => {
      void b;
      n += 1;
      if (n === 1) throw new ApiV1Error("boom", 500, "INTERNAL", {});
    });
    const m = make({ size: 32, readQuote: vi.fn(async () => spec({ size: 32, monthly: 20 })), onConfirm });
    await flush();
    await m.press("online-receipt-confirm");
    await flush();
    expect(m.text()).toContain(EN["onlineChess.receipt.err.generic"]);
    expect(m.onClose).not.toHaveBeenCalled();
    expect(propsOf(m.by("online-receipt-confirm")!).disabled).toBe(false);
    await m.press("online-receipt-confirm");
    expect(onConfirm).toHaveBeenCalledTimes(2);
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });
});

// Fix round 1 (m2): what a failed press SAYS. "Nothing was taken" is a claim about money - made only for an answer the server gave (a coded refusal).
// A press that got NO answer (offline, a proxy page, a dropped connection: `UNKNOWN`) may have reached the server, so it says we could not confirm and
// how to check; on Match Day a refusal the ROUND names (409 changed, 402 frozen, 403 off) is the round's own reason (spec §8.5), not a payment sentence.
describe("a failed press: what it says (m2)", () => {
  const failing = (err: unknown, over: Over = {}) => {
    const onConfirm = vi.fn(async (b: PayBody): Promise<void> => { void b; throw err; });
    return make({ size: 32, readQuote: vi.fn(async () => spec({ size: 32, monthly: 20 })), onConfirm, ...over });
  };
  const pressIt = async (m: ReturnType<typeof make>) => {
    await flush();
    await m.press("online-receipt-confirm");
    await flush();
  };
  const errorText = (m: ReturnType<typeof make>) => textOfAll([m.by("online-receipt-error")!]);

  it("no answer at all (a thrown network error, or an ApiV1Error with the UNKNOWN code the client gives a non-JSON body): says we could not confirm, never 'Nothing was taken'", async () => {
    let checked = 0;
    for (const err of [new Error("Failed to fetch"), new ApiV1Error("Bad gateway", 502, "UNKNOWN")]) {
      const m = failing(err);
      await pressIt(m);
      expect(m.has("online-receipt-error"), "a sentence is drawn").toBe(true);
      expect(propsOf(m.by("online-receipt-error")!)["data-code"]).toBe("UNKNOWN");
      expect(errorText(m)).toBe(EN["onlineChess.receipt.err.unknown"]);
      expect(errorText(m)).not.toContain("Nothing was taken");
      expect(errorText(m), "it tells the organiser how to check").toMatch(/balance/i);
      expect(errorText(m)).toMatch(/history/i);
      expect(m.onClose, "the receipt stays open and armed").not.toHaveBeenCalled();
      expect(propsOf(m.by("online-receipt-confirm")!).disabled).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("a CODED refusal the server gave still says nothing was taken (an answered 'no' took nothing): a 500 INTERNAL and a malformed 409 keep the generic sentence", async () => {
    for (const err of [new ApiV1Error("boom", 500, "INTERNAL", {}), new ApiV1Error("changed", 409, ONLINE_PACKAGE_CODES.quoteChanged, {})]) {
      const m = failing(err);
      await pressIt(m);
      expect(errorText(m)).toBe(EN["onlineChess.receipt.err.generic"]);
    }
    expect(EN["onlineChess.receipt.err.generic"]).toContain("Nothing was taken");
  });

  it("the copy is told apart per locale: the unknown sentence exists in all four and is not the generic one", async () => {
    const dicts = await Promise.all((["en", "es", "fr", "nl"] as const).map(async (l) => [l, (await import(`@/dictionaries/${l}/ui.json`)).default as Record<string, string>] as const));
    let checked = 0;
    for (const [l, d] of dicts) {
      expect(d["onlineChess.receipt.err.unknown"], l).toBeTruthy();
      expect(d["onlineChess.receipt.err.unknown"], `${l}: not the generic sentence`).not.toBe(d["onlineChess.receipt.err.generic"]);
      if (l !== "en") expect(d["onlineChess.receipt.err.unknown"], `${l}: translated`).not.toBe(EN["onlineChess.receipt.err.unknown"]);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("on Match Day a refusal the round names is the ROUND's reason: failureWords is asked with the code and its sentence is drawn in place of the payment one", async () => {
    const words: Record<string, string> = { ROUND_CHANGED: "The round changed.", PAYMENT_REQUIRED: "Billing is paused.", ONLINE_CHESS_DISABLED: "Online chess is off.", ROUND_NOT_ONLINE: "Not an online round." };
    let checked = 0;
    for (const [code, sentence] of Object.entries(words)) {
      const failureWords = vi.fn((c: string): string | null => words[c] ?? null);
      const m = failing(new ApiV1Error("x", 409, code), { failureWords });
      await pressIt(m);
      expect(failureWords).toHaveBeenCalledWith(code);
      expect(errorText(m), code).toBe(sentence);
      expect(propsOf(m.by("online-receipt-error")!)["data-code"]).toBe(code);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("a code the round does not name falls to the generic sentence; no answer never asks the round for a reason; a package refusal keeps the package's own words", async () => {
    const failureWords = vi.fn((c: string): string | null => (c === "ROUND_CHANGED" ? "The round changed." : null));
    const generic = failing(new ApiV1Error("boom", 500, "INTERNAL"), { failureWords });
    await pressIt(generic);
    expect(errorText(generic)).toBe(EN["onlineChess.receipt.err.generic"]);
    const none = failing(new Error("offline"), { failureWords });
    await pressIt(none);
    expect(errorText(none)).toBe(EN["onlineChess.receipt.err.unknown"]);
    expect(failureWords).not.toHaveBeenCalledWith("UNKNOWN");
    const pkg = failing(new ApiV1Error("Need a bigger size", 422, ONLINE_PACKAGE_CODES.roundsAboveMax, { rounds: 99, max: 16 }), { failureWords });
    await pressIt(pkg);
    expect(failureWords).not.toHaveBeenCalledWith(ONLINE_PACKAGE_CODES.roundsAboveMax);
    expect(errorText(pkg)).not.toBe(EN["onlineChess.receipt.err.generic"]);
  });

  it("without failureWords (the division page: no round in play) a round code is the generic sentence - the optional prop changes nothing there", async () => {
    const m = failing(new ApiV1Error("changed", 409, "ROUND_CHANGED"));
    await pressIt(m);
    expect(errorText(m)).toBe(EN["onlineChess.receipt.err.generic"]);
  });
});

describe("short balance: the confirm reads Buy credits and preselects the covering pack (ruling 8)", () => {
  // 64 with camera = 8 credits; the org holds 5 (2 + 3): 3 short, so the 5 pack covers it.
  const SHORT = spec({ size: 64, cameras: true, monthly: 2, pack: 3 });

  it("reads Buy credits, says how short, and never sends a payment", async () => {
    const m = make({ readQuote: vi.fn(async () => SHORT) });
    await flush();
    expect(confirmLabel(m)).toBe("Buy credits");
    expect(root(m)["data-confirm"]).toBe("buy");
    expect(textOfAll([m.by("online-receipt-short")!])).toBe("This needs 8 credits and you have 5. You are 3 credits short.");
    expect(propsOf(m.by("online-receipt-short")!)["data-pack"]).toBe(5);
    expect(m.has("online-receipt-row-monthly")).toBe(false);
    await m.press("online-receipt-confirm");
    expect(m.onConfirm).not.toHaveBeenCalled();
  });

  it("opens the credits chooser with the smallest covering pack, and Back returns to the receipt", async () => {
    const renderBuy = vi.fn(({ pack }: { pack: number }) => <div data-testid="buy-stub" data-pack={pack} />);
    const m = make({ readQuote: vi.fn(async () => SHORT), renderBuy: renderBuy as OnlineReceiptProps["renderBuy"] });
    await flush();
    await m.press("online-receipt-confirm");
    expect(renderBuy).toHaveBeenCalledWith({ pack: 5, size: 64 });
    expect(propsOf(m.by("buy-stub")!)["data-pack"]).toBe(5);
    expect(root(m)["data-view"]).toBe("buy");
    expect(m.text()).toContain("You are 3 credits short. Pick a pack to cover them");
    await m.press("online-receipt-back");
    expect(root(m)["data-view"]).toBe("receipt");
    expect(confirmLabel(m)).toBe("Buy credits");
  });

  it("the chooser returns for the size PICKED in the list, not the stored one (an unpaid pick is not stored until it is paid)", async () => {
    const renderBuy = vi.fn(() => null);
    const m = make({
      mode: "payAndOpen", size: 32, quote: spec({ size: 32, monthly: 20 }), facts: { held: 10, storedSize: 32 }, renderBuy,
      readQuote: vi.fn(async (c) => spec({ size: c.size, pack: 1 })), // the org holds 1 credit: a 64 (4 credits) is 3 short
    });
    m.pick(64);
    await flush();
    await m.press("online-receipt-confirm");
    expect(renderBuy).toHaveBeenCalledWith({ pack: 5, size: 64 });
  });

  it("the covering pack follows the shortfall of 8: 1 short is the 1 pack, 5 short the 5 pack, 6 short the 20 pack (sweep)", async () => {
    let checked = 0;
    for (const [balance, pack] of [[7, 1], [5, 5], [3, 5], [2, 20], [1, 20]] as const) {
      const q = spec({ size: 64, cameras: true, pack: balance }); // owed 8
      const renderBuy = vi.fn(() => null);
      const m = make({ readQuote: vi.fn(async () => q), renderBuy });
      await flush();
      await m.press("online-receipt-confirm");
      expect(renderBuy, `balance ${balance}`).toHaveBeenCalledWith({ pack, size: 64 });
      checked += 1;
    }
    expect(checked).toBe(5);
  });

  it("a debit that finds the balance short (402 ONLINE_CHESS_NO_CREDITS) turns the receipt into Buy credits from the server's numbers", async () => {
    const onConfirm = vi.fn(async (): Promise<void> => {
      throw new ApiV1Error("no credits", 402, ONLINE_PACKAGE_CODES.noCredits, { owed: 4, balance: 1 });
    });
    const m = make({ size: 64, readQuote: vi.fn(async () => spec({ size: 64, monthly: 20 })), onConfirm });
    await flush();
    await m.press("online-receipt-confirm");
    await flush();
    expect(confirmLabel(m)).toBe("Buy credits");
    expect(textOfAll([m.by("online-receipt-short")!])).toBe("This needs 4 credits and you have 1. You are 3 credits short.");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("refused sizes and view states", () => {
  it("a refused quote says the server's reason and arms nothing, for every reason (sweep)", async () => {
    const cases: [NonNullable<ReceiptQuote["refusal"]>, string][] = [
      ["below_held", "This size is too small: 30 have already entered."],
      ["plan", "Your plan does not include this size."],
      ["rounds", "This size includes fewer rounds than your 9."],
      ["rounds_above_max", "Online Chess includes up to 10 Swiss rounds."],
      ["frozen", "A round has opened, so the size can no longer change."],
    ];
    for (const [refusal, sentence] of cases) {
      const m = make({ size: 16, readQuote: vi.fn(async () => spec({ size: 16, monthly: 20, held: 30, rounds: 9, refusal })) });
      await flush();
      expect(textOfAll([m.by("online-receipt-refused")!]), refusal).toBe(sentence);
      expect(propsOf(m.by("online-receipt-confirm")!).disabled, refusal).toBe(true);
      expect(m.has("online-receipt-rows"), refusal).toBe(false);
    }
    expect(cases.length).toBe(5);
  });

  it("the modes title the receipt in the organiser's words", () => {
    const titles: Record<ReceiptMode, string> = { pay: "Pay for Online Chess", payAndOpen: "Pay and open round 1", change: "Change the Online Chess size" };
    for (const mode of Object.keys(titles) as ReceiptMode[]) {
      const m = make({ mode, size: mode === "change" ? null : 64, quote: mode === "payAndOpen" ? spec({ size: 64, monthly: 20 }) : null, facts: mode === "change" ? { paid: { size: 64, camerasPaid: false }, storedSize: 64 } : {} });
      expect(propsOf(m.els()[0]!).title, mode).toBe(titles[mode]);
    }
  });

  it("Cancel closes, and nothing else is called", () => {
    const m = make({ size: 32 });
    m.press("online-receipt-cancel");
    expect(m.onClose).toHaveBeenCalledTimes(1);
    expect(m.onConfirm).not.toHaveBeenCalled();
  });

  it("renders as markup: the dialog, the rows and the buttons anchored on `=\"`", () => {
    const quote = spec({ size: 64, cameras: true, monthly: 3, pack: 5 });
    const markup = renderToStaticMarkup(
      <DictProvider dict={enUi as Dict} locale="en">
        <OnlineReceipt mode="payAndOpen" facts={{ ...FACTS, held: 30 }} size={64} quote={quote} readQuote={async () => quote} onConfirm={async () => {}} onClose={() => {}} />
      </DictProvider>,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('data-testid="online-receipt"');
    expect(markup).toContain('data-mode="payAndOpen"');
    expect(markup).toContain('data-confirm="pay"');
    expect(markup).toContain('data-testid="online-receipt-confirm"');
    expect(clean(markup)).toContain("Pay 8 credits and open round 1");
    expect(clean(markup)).toContain("From this month's credits expire 30 Nov 3");
    expect(markup).toMatch(/min-h-11/);
  });
});
