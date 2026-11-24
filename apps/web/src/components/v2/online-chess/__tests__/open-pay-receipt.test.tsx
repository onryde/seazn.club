// The receipt an Open on an unpaid package stands up on Match Day (components/v2/online-chess/open-pay-receipt.tsx; spec
// 2026-11-23-online-chess-credits-design.md §7.6, §8.4, decision 15; plan Task 12): which size it opens on, which quote it draws first, and what it hands
// the receipt. The 402's quote shapes are the server's (`OnlinePackageQuote`); sizes and prices come from the price leaf, never from the wrapper.
import { describe, expect, it, vi } from "vitest";
import { renderIsland, propsOf } from "@/components/__tests__/_hook-harness";
import { BuyStreamCredits } from "@/components/buy-stream-credits";
import { ONLINE_SIZES, packagePrice } from "@/lib/online-chess-package";
import { quoteOf } from "@/lib/__tests__/_receipt-quote";
import { OnlineReceipt } from "../receipt";
import { OpenPayReceipt, type OpenPayReceiptProps } from "../open-pay-receipt";

const readQuote = vi.hoisted(() => vi.fn());
vi.mock("@/lib/online-package-client", () => ({ readPackageQuote: (d: string, c: unknown) => readQuote(d, c), payPackage: vi.fn() }));

const BASE: OpenPayReceiptProps = {
  ask: { quote: quoteOf({ size: 64, held: 41, rounds: 5, cameras: true }), next: null },
  divisionId: "div-9",
  viewerPlan: "community",
  buy: { orgId: "org-1", currency: "gbp" },
  buyMoreHref: "/o/club/settings/credits?kind=stream",
  onPay: vi.fn(async () => {}),
  onClose: vi.fn(),
};
const receiptOf = (over: Partial<OpenPayReceiptProps> = {}) => {
  const ui = renderIsland(OpenPayReceipt, { ...BASE, ...over });
  const el = ui.tree().find((e) => e.type === OnlineReceipt)!;
  return propsOf(el) as unknown as { mode: string; size: number | null; quote: { size: number } | null; facts: Record<string, unknown>; readQuote(c: unknown): Promise<unknown>; onConfirm: unknown; renderBuy(a: { pack: 1 | 5 | 20; size: 64 }): { type: unknown; props: Record<string, unknown> }; onClose: unknown };
};

describe("OpenPayReceipt: a pay-and-open receipt on the STORED size (decision 15)", () => {
  it("opens in payAndOpen mode on the size the 402 quoted, drawn from that quote at once (no read), with the facts the quote carries", () => {
    const r = receiptOf();
    expect(r.mode).toBe("payAndOpen");
    expect(r.size).toBe(64);
    expect(r.quote).toBe(BASE.ask.quote);
    expect(r.facts).toEqual({ planCap: null, held: 41, rounds: 5, cameras: true, paid: null, storedSize: 64, viewerPlan: "community" });
    expect(packagePrice(64, true), "premise: the camera is in the figure the quote carries").toBe(BASE.ask.quote.owed);
  });

  it("sweep: every stored size opens on ITSELF, never the smallest that fits (the organiser's choice stands)", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      const r = receiptOf({ ask: { quote: quoteOf({ size, held: 3, rounds: 2 }), next: null } });
      expect(r.size, `size ${size}`).toBe(size);
      expect(r.facts.storedSize).toBe(size);
      checked += 1;
    }
    expect(checked).toBe(ONLINE_SIZES.length);
  });

  it("when the server REFUSED the stored size for this division, it opens on the smallest size it offered (next), drawn from next's own quote - the stored size stays the reference", () => {
    const stored = quoteOf({ size: 16, held: 41, rounds: 5, refusal: "below_held" });
    const next = quoteOf({ size: 64, held: 41, rounds: 5 });
    const r = receiptOf({ ask: { quote: stored, next } });
    expect(r.size).toBe(64);
    expect(r.quote).toBe(next);
    expect(r.facts.storedSize, "the organiser's own choice is still the reference the late-entrant line and the consequences compare to").toBe(16);
  });

  it("refused and nothing fits (no next): opens on no size at all, so the list is where a size is chosen - never a refused quote drawn as payable", () => {
    const stored = quoteOf({ size: 16, held: 300, rounds: 5, refusal: "below_held" });
    const r = receiptOf({ ask: { quote: stored, next: null } });
    expect(r.size).toBeNull();
    expect(r.quote).toBeNull();
  });

  it("reads a size's quote from THIS division (the row's, not the page's), and its confirm and close are the caller's", async () => {
    readQuote.mockResolvedValue(quoteOf({ size: 128 }));
    const r = receiptOf();
    await r.readQuote({ size: 128, addCameras: false });
    expect(readQuote).toHaveBeenCalledWith("div-9", { size: 128, addCameras: false });
    expect(r.onConfirm).toBe(BASE.onPay);
    expect(r.onClose).toBe(BASE.onClose);
  });

  it("a short balance's chooser is the credits chooser for THIS division with the covering pack and the receipt's size - or the credits link with no org to charge", () => {
    const choose = receiptOf().renderBuy({ pack: 5, size: 64 });
    expect(choose.type).toBe(BuyStreamCredits);
    expect(choose.props).toMatchObject({ orgId: "org-1", currency: "gbp", preselect: 5, returnTo: { divisionId: "div-9", size: 64 } });
    const link = receiptOf({ buy: null }).renderBuy({ pack: 5, size: 64 });
    expect(link.type).toBe("a");
    expect(link.props.href).toBe("/o/club/settings/credits?kind=stream");
  });
});
