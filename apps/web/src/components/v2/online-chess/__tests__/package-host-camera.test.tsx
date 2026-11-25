// The camera upgrade at the PAID size, driven from the REAL entry point (fix round 2; spec 2026-11-23-online-chess-credits-design.md §8.6 "Add Fair-play camera",
// §7.4 `addCameras`): the paid chip's Change size -> the receipt the host really opens -> the camera tick -> the quote for (paid size, camera) -> the confirm
// the pay door receives. Nothing here is a receipt mounted on a state the test constructs: the receipt's props are the HOST's own, taken after the press.
//
// What is real: the host, the chip, the receipt and its state machine. What is replaced: the two package doors (`online-package-client`) and `router.refresh`.
// The door answers with the server's quote SHAPE, its figures derived from the price leaf the way the server derives them (`quoteOf`); the server's own
// arithmetic for (paid size, addCameras) is proven against the real database by `online-package/__tests__/quote.test.ts` ("paid sweep") and `pay.test.ts`.
// Anti-vacuity: the sweep reports how many sizes it drove.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { ONLINE_SIZES, packagePrice, type OnlineSize } from "@/lib/online-chess-package";
import type { PayBody } from "@/lib/online-receipt";
import { quoteOf } from "@/lib/__tests__/_receipt-quote";
import enUi from "@/dictionaries/en/ui.json";
import { OnlinePaidChip } from "../paid-chip";
import { OnlineReceipt, type OnlineReceiptProps } from "../receipt";
import { OnlinePackageHost, type OnlinePackageHostProps } from "../package-host";
import { expandAll, textOfAll } from "./_receipt-tree";

const EN = enUi as Record<string, string>;
const fill = (s: string, count: number) => s.replace("{count}", String(count));
/** The confirm's words for `n` credits, the dictionary's own one/other pair (the leaf's camera difference is 1 at size 16). */
const payText = (n: number) => fill(EN[n === 1 ? "onlineChess.payLine.pay.one" : "onlineChess.payLine.pay.other"]!, n);
const creditsText = (n: number) => fill(EN[n === 1 ? "onlineChess.receipt.credits.one" : "onlineChess.receipt.credits.other"]!, n);
const { refreshMock, pay, read } = vi.hoisted(() => ({ refreshMock: vi.fn(), pay: vi.fn(), read: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/online-package-client", () => ({ payPackage: (d: string, b: PayBody) => pay(d, b), readPackageQuote: (d: string, c: unknown) => read(d, c) }));

const paidWithoutCameras = (size: OnlineSize) => ({ size, paid: { size, camerasPaid: false }, frozen: false });
const hostProps = (size: OnlineSize): OnlinePackageHostProps => ({
  divisionId: "div-1",
  stored: paidWithoutCameras(size),
  planCap: null,
  held: 3,
  rounds: 2,
  cameras: false,
  viewerPlan: "pro",
  canEdit: true,
  request: null,
  pick: null,
  onChangeSize: vi.fn(),
  buy: { orgId: "org-1", currency: "gbp" },
  buyMoreHref: "/o/acme/settings/credits?kind=stream",
});
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The organiser's path: the host, the chip's Change size, and the receipt the host opened - rendered with the props the HOST gave it. */
function fromTheChip(size: OnlineSize) {
  const host = renderIsland(OnlinePackageHost, hostProps(size));
  const chip = host.tree().find((e) => e.type === OnlinePaidChip)!;
  (propsOf(chip).onChangeSize as () => void)();
  const opened = host.tree().find((e): e is ReactElement => e.type === OnlineReceipt);
  expect(opened, "the chip opened a receipt").toBeDefined();
  const given = propsOf(opened!) as unknown as OnlineReceiptProps;
  const island = renderIsland(OnlineReceipt, given);
  const els = () => expandAll(island.tree());
  const by = (id: string) => els().find((e) => propsOf(e)["data-testid"] === id);
  const label = () => textOfAll([by("online-receipt-confirm")!]);
  const tick = (checked: boolean) => (propsOf(by("online-receipt-cameras")!).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked } });
  return { host, given, island, els, by, label, tick, title: () => propsOf(els()[0]!).title as string };
}

beforeEach(() => {
  refreshMock.mockReset();
  pay.mockReset().mockResolvedValue({ applied: true, capacityLoweredTo: null });
  read.mockReset().mockImplementation(async (_d: string, c: { size: OnlineSize; addCameras: boolean }) =>
    quoteOf({ size: c.size, cameras: c.addCameras, paid: { size: paidSize(), camerasPaid: false }, monthly: 50 }));
});
let current: OnlineSize = 32;
const paidSize = (): OnlineSize => current;

describe("the camera upgrade at the already-paid size, from the paid chip's Change size (spec 8.6)", () => {
  it("the receipt the chip opens is a change receipt with no size chosen, over a package paid without cameras - the state the old test never reached through the host", () => {
    current = 64;
    const r = fromTheChip(64);
    expect(r.given).toMatchObject({ mode: "change", size: null, facts: { paid: { size: 64, camerasPaid: false } } });
    expect(r.label(), "the button waits for a size").toBe(EN["onlineChess.receipt.confirm.choose"]);
    expect(r.by("online-receipt-cameras"), "the camera box is there").toBeDefined();
    expect(read, "nothing is read before a choice").not.toHaveBeenCalled();
  });

  it("tick the camera: the quote is read for the PAID size with the camera, the total is the camera difference, and the confirm pays it through the door with addCameras", async () => {
    current = 64;
    const r = fromTheChip(64);
    r.tick(true);
    expect(read).toHaveBeenCalledWith("div-1", { size: 64, addCameras: true });
    await flush();
    const diff = packagePrice(64, true) - packagePrice(64, false);
    expect(diff, "premise: the leaf prices the camera at 64").toBeGreaterThan(0);
    expect(r.label()).toBe(payText(diff));
    expect(textOfAll([r.by("online-receipt-row-total")!])).toBe(`${EN["onlineChess.receipt.row.total"]} ${creditsText(diff)}`);
    expect(r.title()).toBe(EN["onlineChess.receipt.title.cameras"]);
    await (propsOf(r.by("online-receipt-confirm")!).onClick as () => Promise<void>)();
    await flush();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay).toHaveBeenCalledWith("div-1", { size: 64, expectedOwed: diff, addCameras: true });
    expect(refreshMock, "the page re-reads: the chip now says the camera is paid").toHaveBeenCalledTimes(1);
  });

  it("sweep: at every paid size the same path reads THAT size, owes the leaf's camera difference and pays it (a size is never moved by a camera)", async () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      current = size;
      read.mockClear();
      pay.mockClear();
      const r = fromTheChip(size);
      r.tick(true);
      await flush();
      const diff = packagePrice(size, true) - packagePrice(size, false);
      expect(read, `paid ${size}`).toHaveBeenCalledWith("div-1", { size, addCameras: true });
      expect(r.label(), `paid ${size}`).toBe(payText(diff));
      await (propsOf(r.by("online-receipt-confirm")!).onClick as () => Promise<void>)();
      await flush();
      expect(pay, `paid ${size}`).toHaveBeenCalledWith("div-1", { size, expectedOwed: diff, addCameras: true });
      checked += 1;
    }
    expect(checked).toBe(ONLINE_SIZES.length);
  });

  it("a move up or down WITH the camera still works from the same chip: pick a size, tick, and the door gets that size with addCameras", async () => {
    current = 64;
    const r = fromTheChip(64);
    (propsOf(r.by("online-receipt-size-128")!).onChange as () => void)();
    await flush();
    r.tick(true);
    await flush();
    const owed = packagePrice(128, true) - packagePrice(64, false);
    expect(r.label()).toBe(payText(owed));
    expect(r.title()).toBe(EN["onlineChess.receipt.title.up"]!.replace("{size}", "128"));
    await (propsOf(r.by("online-receipt-confirm")!).onClick as () => Promise<void>)();
    await flush();
    expect(pay).toHaveBeenCalledWith("div-1", { size: 128, expectedOwed: owed, addCameras: true });
  });

  it("a package already paid WITH cameras has no camera box: nothing to add", () => {
    const host = renderIsland(OnlinePackageHost, { ...hostProps(64), stored: { size: 64, paid: { size: 64, camerasPaid: true }, frozen: false } });
    (propsOf(host.tree().find((e) => e.type === OnlinePaidChip)!).onChangeSize as () => void)();
    const given = propsOf(host.tree().find((e) => e.type === OnlineReceipt)!) as unknown as OnlineReceiptProps;
    const island = renderIsland(OnlineReceipt, given);
    expect(expandAll(island.tree()).some((e) => propsOf(e)["data-testid"] === "online-receipt-cameras")).toBe(false);
  });
});
