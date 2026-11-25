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
import { BuyStreamCredits } from "@/components/buy-stream-credits";
import { expandAll, textOfAll } from "./_receipt-tree";

const EN = enUi as Record<string, string>;
const fill = (s: string, count: number) => s.replace("{count}", String(count));
/** The confirm's words for `n` credits, the dictionary's own one/other pair (the leaf's camera difference is 1 at size 16). */
const payText = (n: number) => fill(EN[n === 1 ? "onlineChess.payLine.pay.one" : "onlineChess.payLine.pay.other"]!, n);
const creditsText = (n: number) => fill(EN[n === 1 ? "onlineChess.receipt.credits.one" : "onlineChess.receipt.credits.other"]!, n);
const { refreshMock, pay, read } = vi.hoisted(() => ({ refreshMock: vi.fn(), pay: vi.fn(), read: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }) }));
// The chooser is the one seam this chain reads rather than renders: its `returnTo` prop IS what the buyer's checkout is told to come back to.
vi.mock("@/components/buy-stream-credits", () => ({ BuyStreamCredits: () => null }));
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

// Fix round 3 (Important): buying credits for the camera add with a SHORT balance must come back to a receipt (ruling 5). The sequence, end to end through
// the real host and receipt: tick the camera with too few credits -> Buy credits -> the chooser is told to return with the paid size AND the camera intent
// -> the checkout comes back (the request the page would read from that return) -> the camera receipt reopens on the paid size, ticked -> it pays ->
// the page re-reads with the camera paid -> the SAME address (a reload) opens nothing. Producer and consumer are the real ones on both sides of the return.
describe("a short balance for the camera add: buy credits, come back to the receipt, pay, and a reload opens nothing", () => {
  const SHORT_BY_HOLDING = (size: OnlineSize, held: number) => async (_d: string, c: { size: OnlineSize; addCameras: boolean }) =>
    quoteOf({ size: c.size, cameras: c.addCameras, paid: { size, camerasPaid: false }, monthly: 0, pack: held });

  it("the whole sequence, at every paid size (sweep)", async () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      current = size;
      const diff = packagePrice(size, true) - packagePrice(size, false);
      // 1. the organiser holds nothing: the camera add is short, so the button says Buy credits
      read.mockReset().mockImplementation(SHORT_BY_HOLDING(size, 0));
      const r = fromTheChip(size);
      r.tick(true);
      await flush();
      expect(r.label(), `paid ${size}`).toBe(EN["onlineChess.receipt.confirm.buy"]);
      await (propsOf(r.by("online-receipt-confirm")!).onClick as () => Promise<void>)();
      // 2. the chooser the receipt shows is handed the paid size and the camera intent - the address Stripe will return to
      const chooser = r.els().find((e) => e.type === BuyStreamCredits);
      expect(chooser, `paid ${size}: the buy view shows the chooser`).toBeDefined();
      const returnTo = (propsOf(chooser!) as unknown as { returnTo: { divisionId: string; size: OnlineSize; cameras?: true } }).returnTo;
      expect(returnTo, `paid ${size}`).toEqual({ divisionId: "div-1", size, cameras: true });
      // 3. Stripe returns (the route writes `size` and `cameras=1`; the page's parser reads them back - proven end to end in route-online-chess.test.ts):
      //    the page hands the host that request over the same stored package, and the camera receipt reopens on the paid size with the box ticked
      const request = { size: returnTo.size, key: "cs_after_stripe", cameras: returnTo.cameras! };
      read.mockReset().mockImplementation(SHORT_BY_HOLDING(size, diff + 5));
      const back = renderIsland(OnlinePackageHost, { ...hostProps(size), request });
      const reopened = back.tree().find((e): e is ReactElement => e.type === OnlineReceipt);
      expect(reopened, `paid ${size}: the return reopens a receipt (ruling 5)`).toBeDefined();
      const given = propsOf(reopened!) as unknown as OnlineReceiptProps;
      expect(given, `paid ${size}`).toMatchObject({ mode: "change", size, addCameras: true });
      const receipt = renderIsland(OnlineReceipt, given);
      expect(read, `paid ${size}: the quote is read at once, for the paid size with the camera`).toHaveBeenCalledWith("div-1", { size, addCameras: true });
      await flush();
      const pressEls = () => expandAll(receipt.tree());
      const confirm = pressEls().find((e) => propsOf(e)["data-testid"] === "online-receipt-confirm")!;
      expect(textOfAll([confirm]), `paid ${size}`).toBe(payText(diff));
      expect(propsOf(pressEls().find((e) => propsOf(e)["data-testid"] === "online-receipt-cameras")!).checked, `paid ${size}: ticked`).toBe(true);
      // 4. pay: the door gets the camera add; the page re-reads
      pay.mockClear();
      await (propsOf(confirm).onClick as () => Promise<void>)();
      await flush();
      expect(pay, `paid ${size}`).toHaveBeenCalledWith("div-1", { size, expectedOwed: diff, addCameras: true });
      // 5. the camera is paid now: a reload of the SAME address opens nothing (m4 kept)
      const reloaded = renderIsland(OnlinePackageHost, { ...hostProps(size), stored: { size, paid: { size, camerasPaid: true }, frozen: false }, request });
      expect(reloaded.tree().some((e) => e.type === OnlineReceipt), `paid ${size}: the reload after a completed camera purchase`).toBe(false);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every size ran the whole sequence").toBe(ONLINE_SIZES.length);
  });

  it("the same short balance on a plain move (no camera) hands the chooser NO intent, and that return opens the move without the box ticked", async () => {
    current = 32;
    read.mockReset().mockImplementation(SHORT_BY_HOLDING(32, 0));
    const r = fromTheChip(32);
    (propsOf(r.by("online-receipt-size-64")!).onChange as () => void)();
    await flush();
    await (propsOf(r.by("online-receipt-confirm")!).onClick as () => Promise<void>)();
    const returnTo = (propsOf(r.els().find((e) => e.type === BuyStreamCredits)!) as unknown as { returnTo: object }).returnTo;
    expect(returnTo).toEqual({ divisionId: "div-1", size: 64 });
    const back = renderIsland(OnlinePackageHost, { ...hostProps(32), request: { size: 64, key: "cs_move" } });
    const given = propsOf(back.tree().find((e) => e.type === OnlineReceipt)!) as unknown as OnlineReceiptProps;
    expect(given).toMatchObject({ mode: "change", size: 64 });
    expect(given.addCameras, "no intent, no seeded box").toBeUndefined();
  });
});
