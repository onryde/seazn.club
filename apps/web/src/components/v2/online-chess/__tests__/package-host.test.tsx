// The Online Chess package on the division page (components/v2/online-chess/package-host.tsx; spec 2026-11-23-online-chess-credits-design.md §8.3-§8.7;
// plan Task 12): which of the pay line and the chip is drawn, and WHEN the receipt opens - on a press, on a paid pick, and on the checkout return, once
// per arrival (owner ruling 5) however the page was reached. Driven through the hook harness (the host's own handlers), the receipt and the pay line
// opened one level so a press and a prop are what they are in a browser.
//
// What is real: the host, the receipt's open/close wiring, `apiV1`'s error class. What is replaced: the two package doors (`online-package-client`) and
// `router.refresh`. Expected sizes and prices come from the price leaf, never from the host. Anti-vacuity: every sweep reports its count.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { BuyStreamCredits } from "@/components/buy-stream-credits";
import { ONLINE_SIZES, packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import type { PayBody } from "@/lib/online-receipt";
import enUi from "@/dictionaries/en/ui.json";
import { OnlinePaidChip } from "../paid-chip";
import { OnlinePayLine } from "../pay-line";
import { OnlineReceipt } from "../receipt";
import { OnlinePackageHost, type OnlinePackageHostProps } from "../package-host";

const EN = enUi as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));

const { refreshMock, pay, read } = vi.hoisted(() => ({ refreshMock: vi.fn(), pay: vi.fn(), read: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/online-package-client", () => ({ payPackage: (d: string, b: PayBody) => pay(d, b), readPackageQuote: (d: string, c: unknown) => read(d, c) }));

const UNPAID = { size: 64 as OnlineSize, paid: null, frozen: false };
const PAID = { size: 32 as OnlineSize, paid: { size: 32 as OnlineSize, camerasPaid: false }, frozen: false };
const FROZEN_PAID = { ...PAID, frozen: true };
const GRANDFATHERED = { size: 16 as OnlineSize, paid: null, frozen: true };

const PROPS: OnlinePackageHostProps = {
  divisionId: "div-1",
  stored: UNPAID,
  planCap: null,
  held: 41,
  rounds: 5,
  cameras: false,
  viewerPlan: "pro",
  canEdit: true,
  request: null,
  pick: null,
  onChangeSize: vi.fn(),
  buy: { orgId: "org-1", currency: "gbp" },
  buyMoreHref: "/o/acme/settings/credits?kind=stream",
};
const mount = (over: Partial<OnlinePackageHostProps> = {}) => renderIsland(OnlinePackageHost, { ...PROPS, ...over });
type Host = ReturnType<typeof mount>;
const find = (h: Host, type: unknown): ReactElement | undefined => h.tree().find((e) => e.type === type);
const receipt = (h: Host) => find(h, OnlineReceipt);
const receiptProps = (h: Host) => propsOf(receipt(h)!) as unknown as { mode: string; size: OnlineSize | null; facts: Record<string, unknown>; onClose: () => void; onConfirm: (b: PayBody) => Promise<void>; renderBuy: (a: { pack: 1 | 5 | 20; size: OnlineSize }) => ReactElement };
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  refreshMock.mockReset();
  pay.mockReset().mockResolvedValue({ applied: true, capacityLoweredTo: null });
  read.mockReset();
});

describe("which line is drawn", () => {
  it("an unpaid package draws the amber pay line with the stored size, the held count and the price from the leaf - and no chip, no receipt", () => {
    const h = mount({ cameras: true });
    expect(find(h, OnlinePayLine)).toBeDefined();
    expect(propsOf(find(h, OnlinePayLine)!)).toMatchObject({ held: 41, size: 64, owed: packagePrice(64, true), readOnly: false });
    expect(packagePrice(64, true), "premise: the camera is in the owed figure").toBe(8);
    expect(find(h, OnlinePaidChip)).toBeUndefined();
    expect(receipt(h)).toBeUndefined();
  });

  it("a paid package draws the chip (Change size available) and not the pay line; a frozen one draws the chip with the freeze and no Change size", () => {
    const paid = mount({ stored: PAID });
    expect(propsOf(find(paid, OnlinePaidChip)!)).toMatchObject({ size: 32, frozen: false, readOnly: false });
    expect(find(paid, OnlinePayLine)).toBeUndefined();
    const frozen = mount({ stored: FROZEN_PAID });
    expect(propsOf(find(frozen, OnlinePaidChip)!)).toMatchObject({ size: 32, frozen: true });
    expect(find(frozen, OnlinePayLine)).toBeUndefined();
  });

  it("draws NOTHING for no live row, and for a grandfathered package (frozen, never paid): there is nothing owed and nothing paid to show", () => {
    let checked = 0;
    for (const stored of [null, GRANDFATHERED]) {
      const h = mount({ stored });
      expect(find(h, OnlinePayLine), String(stored)).toBeUndefined();
      expect(find(h, OnlinePaidChip), String(stored)).toBeUndefined();
      expect(receipt(h)).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("a view-only reader (canEdit false) is told, never asked: the line is read-only and no receipt opens, even on a checkout return", () => {
    const h = mount({ canEdit: false, request: { size: null, key: "cs_test_1" } });
    expect(propsOf(find(h, OnlinePayLine)!).readOnly).toBe(true);
    expect(receipt(h)).toBeUndefined();
    expect(propsOf(find(mount({ canEdit: false, stored: PAID }), OnlinePaidChip)!).readOnly).toBe(true);
  });
});

describe("what a press opens", () => {
  it("Pay on the amber line opens a PAY receipt on the stored size, with the facts the line was drawn from", () => {
    const h = mount({ held: 41, rounds: 5, planCap: 128, cameras: true, viewerPlan: "community" });
    (propsOf(find(h, OnlinePayLine)!).onPay as () => void)();
    expect(receiptProps(h)).toMatchObject({
      mode: "pay",
      size: 64,
      facts: { planCap: 128, held: 41, rounds: 5, cameras: true, paid: null, storedSize: 64, viewerPlan: "community" },
    });
  });

  it("Change size on the chip opens a CHANGE receipt with no size chosen (the list)", () => {
    const h = mount({ stored: PAID });
    (propsOf(find(h, OnlinePaidChip)!).onChangeSize as () => void)();
    expect(receiptProps(h)).toMatchObject({ mode: "change", size: null, facts: { paid: { size: 32, camerasPaid: false }, storedSize: 32 } });
  });

  it("Change size on the AMBER line is the strip's, not a receipt: it calls the parent's handler and opens nothing", () => {
    const onChangeSize = vi.fn();
    const h = mount({ onChangeSize });
    (propsOf(find(h, OnlinePayLine)!).onChangeSize as () => void)();
    expect(onChangeSize).toHaveBeenCalledTimes(1);
    expect(receipt(h)).toBeUndefined();
  });

  it("closing the receipt removes it, and the next press opens a FRESH one (a new key: no state carried over)", () => {
    const h = mount();
    (propsOf(find(h, OnlinePayLine)!).onPay as () => void)();
    const first = receipt(h)!.key;
    receiptProps(h).onClose();
    expect(receipt(h)).toBeUndefined();
    (propsOf(find(h, OnlinePayLine)!).onPay as () => void)();
    expect(receipt(h)!.key, "a new receipt, not the old one reshown").not.toBe(first);
  });
});

describe("a pick on a PAID row's select (the strip's counter)", () => {
  it("opens a CHANGE receipt on the picked size, once per pick; the same size picked again opens again after a close", () => {
    const h = mount({ stored: PAID, pick: null });
    expect(receipt(h)).toBeUndefined();
    h.rerender({ ...PROPS, stored: PAID, pick: { size: 128, n: 1 } });
    expect(receiptProps(h)).toMatchObject({ mode: "change", size: 128 });
    receiptProps(h).onClose();
    h.rerender({ ...PROPS, stored: PAID, pick: { size: 128, n: 1 } }); // the same pick re-rendered: nothing new
    expect(receipt(h), "an unchanged pick does not reopen what was closed").toBeUndefined();
    h.rerender({ ...PROPS, stored: PAID, pick: { size: 128, n: 2 } });
    expect(receiptProps(h)).toMatchObject({ mode: "change", size: 128 });
  });

  it("opens nothing for an unpaid, frozen or missing package (a pick there is not a purchase)", () => {
    let checked = 0;
    for (const stored of [UNPAID, FROZEN_PAID, GRANDFATHERED, null]) {
      const h = mount({ stored, pick: null });
      h.rerender({ ...PROPS, stored, pick: { size: 128, n: 1 } });
      expect(receipt(h), String(stored?.size)).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

describe("the checkout return (?oc=pay): opens once per arrival, however the page was reached (owner ruling 5)", () => {
  it("a first payment's return opens a PAY receipt on the size the address named, else the stored size", () => {
    expect(receiptProps(mount({ request: { size: 128, key: "cs_a" } }))).toMatchObject({ mode: "pay", size: 128 });
    expect(receiptProps(mount({ request: { size: null, key: "cs_a" } }))).toMatchObject({ mode: "pay", size: 64 });
  });

  it("a PAID package's return (an upgrade) opens a CHANGE receipt on the size the address named", () => {
    expect(receiptProps(mount({ stored: PAID, request: { size: 128, key: "cs_a" } }))).toMatchObject({ mode: "change", size: 128 });
    expect(receiptProps(mount({ stored: PAID, request: { size: null, key: "cs_a" } }))).toMatchObject({ mode: "change", size: null });
  });

  it("a frozen or missing package has nothing to pay: the arrival opens nothing", () => {
    for (const stored of [FROZEN_PAID, GRANDFATHERED, null]) expect(receipt(mount({ stored, request: { size: null, key: "cs_a" } })), String(stored?.size)).toBeUndefined();
  });

  it("a CLIENT navigation that hands the mounted host a new arrival opens the receipt (a second key); a refresh of the same one does not reopen a closed receipt", () => {
    const h = mount();
    expect(receipt(h)).toBeUndefined();
    h.rerender({ ...PROPS, request: { size: null, key: "cs_a" } });
    expect(receiptProps(h)).toMatchObject({ mode: "pay", size: 64 });
    receiptProps(h).onClose();
    h.rerender({ ...PROPS, request: { size: null, key: "cs_a" } }); // router.refresh(): same arrival
    expect(receipt(h), "a refresh of the same arrival").toBeUndefined();
    h.rerender({ ...PROPS, request: { size: 128, key: "cs_b" } }); // a second payment's return
    expect(receiptProps(h)).toMatchObject({ mode: "pay", size: 128 });
  });

  it("an arrival that goes away is forgotten: the same session reached again opens again", () => {
    const h = mount({ request: { size: null, key: "cs_a" } });
    receiptProps(h).onClose();
    h.rerender({ ...PROPS, request: null });
    expect(receipt(h)).toBeUndefined();
    h.rerender({ ...PROPS, request: { size: null, key: "cs_a" } });
    expect(receipt(h), "?oc=pay reached a second time").toBeDefined();
  });

  it("an address with no session (key '') still opens once and is not re-opened by a re-render", () => {
    const h = mount({ request: { size: null, key: "" } });
    expect(receipt(h)).toBeDefined();
    receiptProps(h).onClose();
    h.rerender({ ...PROPS, request: { size: null, key: "" } });
    expect(receipt(h)).toBeUndefined();
  });
});

describe("what a confirm does", () => {
  const BODY: PayBody = { size: 64, expectedOwed: 4 };

  it("sends the body to the package door for THIS division, refreshes the page and resolves", async () => {
    const h = mount({ request: { size: null, key: "cs_a" } });
    await receiptProps(h).onConfirm(BODY);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay).toHaveBeenCalledWith("div-1", BODY);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("a refusal (409 changed, 402 short, a 500) rejects to the receipt and the page is NOT refreshed", async () => {
    pay.mockRejectedValueOnce(new Error("boom"));
    const h = mount({ request: { size: null, key: "cs_a" } });
    await expect(receiptProps(h).onConfirm(BODY)).rejects.toThrow("boom");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("a move that lowered the registration capacity is said on the page, in the organiser's words; a move that did not says nothing", async () => {
    pay.mockResolvedValueOnce({ applied: true, capacityLoweredTo: 32 });
    const h = mount({ stored: PAID, request: { size: 32, key: "cs_a" } });
    await receiptProps(h).onConfirm({ size: 32, expectedOwed: -1, expectedForfeited: 0 });
    await flush();
    const note = h.tree().find((e) => propsOf(e)["data-testid"] === "online-package-notice");
    expect(note).toBeDefined();
    expect(String(propsOf(note!).children)).toBe(fill(EN["onlineChess.capacityLowered"]!, { size: 32 }));
    pay.mockResolvedValueOnce({ applied: true, capacityLoweredTo: null });
    await receiptProps(h).onConfirm({ size: 64, expectedOwed: 2 });
    await flush();
    expect(h.tree().find((e) => propsOf(e)["data-testid"] === "online-package-notice"), "the next move that lowers nothing clears the line").toBeUndefined();
  });
});

describe("the credits chooser a short balance opens (owner ruling 8)", () => {
  it("is the credits chooser for THIS division: the covering pack preselected, the division and the receipt's size as the return", () => {
    const h = mount({ request: { size: null, key: "cs_a" } });
    const chooser = receiptProps(h).renderBuy({ pack: 5, size: 128 });
    expect(chooser.type).toBe(BuyStreamCredits);
    expect(propsOf(chooser)).toMatchObject({ orgId: "org-1", currency: "gbp", preselect: 5, returnTo: { divisionId: "div-1", size: 128 } });
  });

  it("sweeps every pack and every size: the return names each exactly", () => {
    const h = mount({ request: { size: null, key: "cs_a" } });
    let checked = 0;
    for (const pack of [1, 5, 20] as const) {
      for (const size of ONLINE_SIZES) {
        expect(propsOf(receiptProps(h).renderBuy({ pack, size }))).toMatchObject({ preselect: pack, returnTo: { divisionId: "div-1", size } });
        checked += 1;
      }
    }
    expect(checked).toBe(15);
  });

  it("with no org to charge (a reader the page could not resolve one for) it is a link to the credits page, never a dead button", () => {
    const h = mount({ buy: null, request: { size: null, key: "cs_a" } });
    const link = receiptProps(h).renderBuy({ pack: 5, size: 64 });
    expect(link.type).toBe("a");
    expect(propsOf(link).href).toBe("/o/acme/settings/credits?kind=stream");
  });
});
