// The match-credit tiles on Settings → Credits → Streaming (components/buy-stream-credits.tsx), driven through the hook
// harness: the click, the state it moves, and what it POSTs. `apps/web` has no DOM, so a static render can show the tiles
// and cannot witness a tap — the join between the tile, the request body and the sheet is the thing under test.
//
// The seam this exists for: the request names `returnTo: "settings"` and no fixture. A tile that posted the panel's shape
// (a fixture id) would 400 at the route; one that posted neither would 400 too; this is the only layer that sees what the
// real button sends.
//
// Mutant table (each applied once by hand):
//   B1 body shape     post `{orgId, pack}` / add a fixtureId                       → "a tap asks the route for a Settings return: org, pack, returnTo — no fixture"
//   B2 sheet first    fetch the Session before the sheet's code is in hand (R5a)    → "the sheet's code is in hand before a Checkout Session is asked for"
//   B3 one session    drop the `buying` ref guard                                   → "a second tap while a Session is in flight asks for nothing"
//   B4 refusals       map 402 / 403 to the wrong message                             → "each refusal says its own thing"
//   B5 lock release   keep `buying` held after a refusal / a close                   → "the lock is released by a refusal, a close and a sheet that fails to load"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "./_hook-harness";

const lazy = vi.hoisted(() => ({ made: [] as { C: (props: Record<string, unknown>) => null }[] }));
vi.mock("next/dynamic", () => ({
  default: () => {
    const C: (props: Record<string, unknown>) => null = () => null;
    lazy.made.push({ C });
    return C;
  },
}));
const sheetLoader = vi.hoisted(() => ({ load: vi.fn<() => Promise<unknown>>() }));
vi.mock("@/components/v2/stream-checkout-sheet-loader", () => ({ loadCheckoutSheet: () => sheetLoader.load() }));
const checkout = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/billing-checkout-client", () => ({ fetchRelayCheckoutClientSecret: (args: unknown) => checkout.fetch(args) }));

import { BuyStreamCredits, CheckoutSheetBoundary } from "../buy-stream-credits";
import { STREAM_CREDIT_PACKS } from "@/lib/stream-credit-packs";

const EN: Record<string, string> = JSON.parse(readFileSync(path.join(process.cwd(), "src/dictionaries/en/ui.json"), "utf8"));
const flush = () => new Promise<void>((r) => setImmediate(r));
const byTestId = (tree: ReactElement[], id: string) => tree.find((el) => propsOf(el)["data-testid"] === id);
const tap = (island: ReturnType<typeof open>, size: number) => {
  const tile = byTestId(island.tree(), `credits-stream-buy-pack-${size}`);
  const onClick = tile && (propsOf(tile).onClick as (() => void) | undefined);
  if (!onClick) throw new Error(`no tile for pack ${size}`);
  onClick();
};
const open = (currency: "gbp" | "usd" | "eur" | "inr" = "gbp") => renderIsland(BuyStreamCredits, { orgId: "org-1", currency });
const sheetOf = (island: ReturnType<typeof open>) => island.tree().find((el) => lazy.made.some((m) => m.C === el.type));
const textOf = (island: ReturnType<typeof open>, id: string): string | undefined => {
  const el = byTestId(island.tree(), id);
  return el ? String(propsOf(el).children) : undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  sheetLoader.load.mockResolvedValue({});
  checkout.fetch.mockResolvedValue({ ok: true, clientSecret: "cs_secret_1" });
});

describe("BuyStreamCredits", () => {
  it("one tile per pack the catalogue sells, captioned from the dictionary, the popular one marked", () => {
    const island = open();
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const tile = byTestId(island.tree(), `credits-stream-buy-pack-${pack.size}`);
      expect(tile, `pack ${pack.size}`).toBeDefined();
      expect(JSON.stringify(propsOf(tile!).children)).toContain(EN[pack.labelKey]!);
      expect(propsOf(tile!).disabled).toBe(false);
      checked++;
    }
    expect(checked).toBe(STREAM_CREDIT_PACKS.length);
    expect(checked).toBeGreaterThan(0);
    expect(JSON.stringify(byTestId(island.tree(), "credits-stream-buy-pack-5"))).toContain(EN["stream.credits.popular"]!);
  });

  it("a tap asks the route for a Settings return: org, pack, returnTo — and no fixture (B1)", async () => {
    const island = open();
    tap(island, 5);
    await flush();
    expect(checkout.fetch).toHaveBeenCalledTimes(1);
    expect(checkout.fetch).toHaveBeenCalledWith({ orgId: "org-1", pack: 5, returnTo: "settings" });
    expect(Object.keys(checkout.fetch.mock.calls[0]![0] as object).sort()).toEqual(["orgId", "pack", "returnTo"]);
    // each tile names its OWN pack
    for (const pack of STREAM_CREDIT_PACKS) {
      checkout.fetch.mockClear();
      const fresh = open();
      tap(fresh, pack.size);
      await flush();
      expect((checkout.fetch.mock.calls[0]![0] as { pack: number }).pack).toBe(pack.size);
    }
  });

  it("the sheet opens over the page with the Session's secret, inside its own error boundary", async () => {
    const island = open();
    expect(sheetOf(island), "no sheet before a tap").toBeUndefined();
    tap(island, 20);
    await flush();
    const sheet = sheetOf(island);
    expect(sheet).toBeDefined();
    expect(propsOf(sheet!).clientSecret).toBe("cs_secret_1");
    expect(island.tree().some((el) => el.type === CheckoutSheetBoundary)).toBe(true);
  });

  it("the sheet's code is in hand before a Checkout Session is asked for (B2) — a chunk that will not load opens no Session, and the next tap retries", async () => {
    const order: string[] = [];
    sheetLoader.load.mockImplementation(async () => { order.push("load"); return {}; });
    checkout.fetch.mockImplementation(async () => { order.push("fetch"); return { ok: true, clientSecret: "x" }; });
    tap(open(), 1);
    await flush();
    expect(order).toEqual(["load", "fetch"]);

    vi.clearAllMocks();
    sheetLoader.load.mockRejectedValueOnce(new Error("ChunkLoadError"));
    const island = open();
    tap(island, 1);
    await flush();
    expect(checkout.fetch, "no Session without the sheet").not.toHaveBeenCalled();
    expect(textOf(island, "credits-stream-buy-error")).toBe(EN["stream.credits.error.unknown"]);
    // …and the lock is free: the next tap loads again and buys
    sheetLoader.load.mockResolvedValue({});
    tap(island, 1);
    await flush();
    expect(sheetLoader.load).toHaveBeenCalledTimes(2);
    expect(checkout.fetch).toHaveBeenCalledTimes(1);
    expect(textOf(island, "credits-stream-buy-error"), "a new attempt clears the old error").toBeUndefined();
  });

  it("a second tap while a Session is in flight asks for nothing (B3)", async () => {
    let release: (v: unknown) => void = () => {};
    checkout.fetch.mockImplementation(() => new Promise((r) => { release = r; }));
    const island = open();
    tap(island, 5);
    tap(island, 20);
    tap(island, 5);
    await flush();
    expect(checkout.fetch).toHaveBeenCalledTimes(1);
    release({ ok: true, clientSecret: "s" });
    await flush();
    // the sheet is up and holds the lock: another tile is still refused
    tap(island, 1);
    await flush();
    expect(checkout.fetch).toHaveBeenCalledTimes(1);
  });

  it("each refusal says its own thing (B4): 402 the plan lost streaming, 403 ask the billing owner, anything else try again", async () => {
    let checked = 0;
    for (const [status, testid, sentence] of [
      [402, "credits-stream-buy-gate", EN["stream.phone.switchedOff"]],
      [403, "credits-stream-buy-error", EN["stream.credits.error.owner"]],
      [500, "credits-stream-buy-error", EN["stream.credits.error.unknown"]],
      [502, "credits-stream-buy-error", EN["stream.credits.error.unknown"]],
    ] as const) {
      checkout.fetch.mockResolvedValue({ ok: false, status, error: "x" });
      const island = open();
      tap(island, 5);
      await flush();
      expect(textOf(island, testid), String(status)).toBe(sentence);
      expect(sheetOf(island), `${status}: no sheet`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("a 402 switches the tiles off — the plan has no streaming, so there is nothing to retry; the other refusals leave them live", async () => {
    checkout.fetch.mockResolvedValue({ ok: false, status: 402, error: "x" });
    const gated = open();
    tap(gated, 5);
    await flush();
    for (const p of STREAM_CREDIT_PACKS) expect(propsOf(byTestId(gated.tree(), `credits-stream-buy-pack-${p.size}`)!).disabled).toBe(true);

    checkout.fetch.mockResolvedValue({ ok: false, status: 403, error: "x" });
    const owner = open();
    tap(owner, 5);
    await flush();
    for (const p of STREAM_CREDIT_PACKS) expect(propsOf(byTestId(owner.tree(), `credits-stream-buy-pack-${p.size}`)!).disabled).toBe(false);
  });

  it("the lock is released by a refusal, a close and a sheet that fails to load (B5)", async () => {
    // a refusal
    checkout.fetch.mockResolvedValueOnce({ ok: false, status: 500, error: "x" });
    const island = open();
    tap(island, 5);
    await flush();
    tap(island, 5);
    await flush();
    expect(checkout.fetch, "after a refusal the next tap buys").toHaveBeenCalledTimes(2);
    expect(sheetOf(island)).toBeDefined();

    // a close
    (propsOf(sheetOf(island)!).onClose as () => void)();
    expect(sheetOf(island), "closed").toBeUndefined();
    checkout.fetch.mockClear();
    tap(island, 1);
    await flush();
    expect(checkout.fetch, "after a close the next tap buys").toHaveBeenCalledTimes(1);

    // a sheet that cannot load once the Session exists (M1)
    const boundary = island.tree().find((el) => el.type === CheckoutSheetBoundary)!;
    (propsOf(boundary).onFail as () => void)();
    expect(sheetOf(island), "failed sheet is gone").toBeUndefined();
    expect(textOf(island, "credits-stream-buy-error")).toBe(EN["stream.credits.error.unknown"]);
    checkout.fetch.mockClear();
    tap(island, 20);
    await flush();
    expect(checkout.fetch, "after a failed sheet the next tap buys").toHaveBeenCalledTimes(1);
  });

  it("every shipped currency renders every pack's tile with a price in that currency's own symbol", () => {
    const SYMBOL = { gbp: "£", eur: "€", usd: "$", inr: "₹" } as const;
    let quoted = 0;
    for (const currency of ["gbp", "eur", "usd", "inr"] as const) {
      const island = open(currency);
      for (const pack of STREAM_CREDIT_PACKS) {
        const tile = byTestId(island.tree(), `credits-stream-buy-pack-${pack.size}`)!;
        const text = JSON.stringify(propsOf(tile).children);
        expect(text, `${currency}/${pack.size}: label`).toContain(EN[pack.labelKey]!);
        expect(text, `${currency}/${pack.size}: price`).toContain(SYMBOL[currency]);
        quoted++;
      }
    }
    expect(quoted).toBe(4 * STREAM_CREDIT_PACKS.length);
  });
});

// Online Chess credits (spec 2026-11-23-online-chess-credits-design.md §8.4; plan Task 12): the chooser a receipt with a short balance opens.
// The seam: the request names `returnTo: "division"` with the division and the receipt's size (so Stripe returns the buyer to that division with
// the receipt reopened), and the covering pack is marked and focused - nothing is bought until a tile is tapped.
describe("BuyStreamCredits from an Online Chess receipt", () => {
  const openDivision = (over: { returnTo?: { divisionId: string; size?: 16 | 32 | 64 | 128 | 256; cameras?: boolean }; preselect?: 1 | 5 | 20 } = {}) =>
    renderIsland(BuyStreamCredits, { orgId: "org-1", currency: "gbp" as const, ...over });

  it("a tap asks the route for a DIVISION return: org, pack, returnTo, the division and the size, and no fixture", async () => {
    const island = openDivision({ returnTo: { divisionId: "div-1", size: 64 }, preselect: 5 });
    tap(island as never, 5);
    await flush();
    expect(checkout.fetch).toHaveBeenCalledTimes(1);
    expect(checkout.fetch).toHaveBeenCalledWith({ orgId: "org-1", pack: 5, returnTo: "division", divisionId: "div-1", size: 64 });
  });

  it("the receipt's camera answer rides in the body beside the size, either way (Task 15); no answer sends no `cameras` key at all", async () => {
    for (const cameras of [true, false]) {
      const island = openDivision({ returnTo: { divisionId: "div-1", size: 64, cameras }, preselect: 5 });
      tap(island as never, 5);
      await flush();
      expect(checkout.fetch, String(cameras)).toHaveBeenLastCalledWith({ orgId: "org-1", pack: 5, returnTo: "division", divisionId: "div-1", size: 64, cameras });
    }
    const plain = openDivision({ returnTo: { divisionId: "div-1", size: 64 }, preselect: 5 });
    tap(plain as never, 5);
    await flush();
    expect("cameras" in (checkout.fetch.mock.calls.at(-1)![0] as object), "no camera intent: no key").toBe(false);
  });

  it("a first payment sends no size (it is stored on the unpaid row)", async () => {
    const island = openDivision({ returnTo: { divisionId: "div-1" } });
    tap(island as never, 1);
    await flush();
    expect(checkout.fetch).toHaveBeenCalledWith({ orgId: "org-1", pack: 1, returnTo: "division", divisionId: "div-1" });
    expect("size" in (checkout.fetch.mock.calls[0]![0] as object)).toBe(false);
  });

  it("the preselected tile is the one marked and focused; the others are not; none when no pack is named (sweep)", () => {
    let checked = 0;
    for (const pack of STREAM_CREDIT_PACKS) {
      const island = openDivision({ returnTo: { divisionId: "d" }, preselect: pack.size });
      for (const other of STREAM_CREDIT_PACKS) {
        const props = propsOf(byTestId(island.tree(), `credits-stream-buy-pack-${other.size}`)!);
        expect(props["data-preselected"], `${pack.size} preselected, tile ${other.size}`).toBe(other.size === pack.size ? "true" : undefined);
        expect(props.autoFocus, `${pack.size} preselected, tile ${other.size}`).toBe(other.size === pack.size);
        checked += 1;
      }
    }
    expect(checked).toBe(STREAM_CREDIT_PACKS.length * STREAM_CREDIT_PACKS.length);
    const none = openDivision({ returnTo: { divisionId: "d" } });
    for (const other of STREAM_CREDIT_PACKS) expect(propsOf(byTestId(none.tree(), `credits-stream-buy-pack-${other.size}`)!)["data-preselected"]).toBeUndefined();
  });

  it("a preselected tile says it covers the shortfall, in place of 'Most clubs'", () => {
    const text = (island: ReturnType<typeof openDivision>, size: number) => JSON.stringify(propsOf(byTestId(island.tree(), `credits-stream-buy-pack-${size}`)!).children);
    const island = openDivision({ returnTo: { divisionId: "d" }, preselect: 20 });
    expect(text(island, 20)).toContain(EN["onlineChess.receipt.buy.covers"]!);
    expect(text(island, 5)).toContain(EN["stream.credits.popular"]!); // the unchosen popular tile keeps its own badge
    expect(text(openDivision({ returnTo: { divisionId: "d" }, preselect: 5 }), 5)).not.toContain(EN["stream.credits.popular"]!);
  });

  it("without a return target it is still the Settings chooser, byte for byte (the existing callers do not move)", async () => {
    const island = openDivision();
    tap(island as never, 20);
    await flush();
    expect(checkout.fetch).toHaveBeenCalledWith({ orgId: "org-1", pack: 20, returnTo: "settings" });
  });
});

