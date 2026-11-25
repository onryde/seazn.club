// The Fair-play camera answer at the PAID size, driven from the REAL entry point (Task 15; spec 2026-11-23-online-chess-credits-design.md §8.6, §7.4
// `cameras`): the paid chip's Change size -> the receipt the host really opens -> Yes or No -> the quote for (paid size, answer) -> the confirm the pay
// door receives. Nothing here is a receipt mounted on a state the test constructs: the receipt's props are the HOST's own, taken after the press.
//
// What is real: the host, the chip, the receipt and its state machine. What is replaced: the two package doors (`online-package-client`) and `router.refresh`.
// The door answers with the server's quote SHAPE, its figures derived from the price leaf the way the server derives them (`quoteOf`); the server's own
// arithmetic for (paid size, cameras) is proven against the real database by `online-package/__tests__/quote.test.ts` and `pay.test.ts`.
// Anti-vacuity: the sweeps report how many sizes they drove.
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
const offText = (n: number) => fill(EN[n === 1 ? "onlineChess.receipt.confirm.camerasOff.one" : "onlineChess.receipt.confirm.camerasOff.other"]!, n);
const creditsText = (n: number) => fill(EN[n === 1 ? "onlineChess.receipt.credits.one" : "onlineChess.receipt.credits.other"]!, n);
const { refreshMock, pay, read } = vi.hoisted(() => ({ refreshMock: vi.fn(), pay: vi.fn(), read: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }) }));
// The chooser is the one seam this chain reads rather than renders: its `returnTo` prop IS what the buyer's checkout is told to come back to.
vi.mock("@/components/buy-stream-credits", () => ({ BuyStreamCredits: () => null }));
vi.mock("@/lib/online-package-client", () => ({ payPackage: (d: string, b: PayBody) => pay(d, b), readPackageQuote: (d: string, c: unknown) => read(d, c) }));

const paidAt = (size: OnlineSize, camerasPaid: boolean) => ({ size, paid: { size, camerasPaid }, frozen: false });
const hostProps = (size: OnlineSize, camerasPaid = false): OnlinePackageHostProps => ({
  divisionId: "div-1",
  stored: paidAt(size, camerasPaid),
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
function fromTheChip(size: OnlineSize, camerasPaid = false) {
  const host = renderIsland(OnlinePackageHost, hostProps(size, camerasPaid));
  const chip = host.tree().find((e) => e.type === OnlinePaidChip)!;
  (propsOf(chip).onChangeSize as () => void)();
  const opened = host.tree().find((e): e is ReactElement => e.type === OnlineReceipt);
  expect(opened, "the chip opened a receipt").toBeDefined();
  const given = propsOf(opened!) as unknown as OnlineReceiptProps;
  const island = renderIsland(OnlineReceipt, given);
  const els = () => expandAll(island.tree());
  const by = (id: string) => els().find((e) => propsOf(e)["data-testid"] === id);
  const label = () => textOfAll([by("online-receipt-confirm")!]);
  const answer = (yes: boolean) => (propsOf(by(yes ? "online-receipt-cameras-yes" : "online-receipt-cameras-no")!).onChange as () => void)();
  const yesChecked = () => propsOf(by("online-receipt-cameras-yes")!).checked as boolean;
  const confirm = async () => {
    await (propsOf(by("online-receipt-confirm")!).onClick as () => Promise<void>)();
    await flush();
  };
  return { host, given, island, els, by, label, answer, yesChecked, confirm, title: () => propsOf(els()[0]!).title as string };
}

beforeEach(() => {
  refreshMock.mockReset();
  pay.mockReset().mockResolvedValue({ applied: true, capacityLoweredTo: null, cameraPolicySetTo: null });
  read.mockReset().mockImplementation(async (_d: string, c: { size: OnlineSize; cameras: boolean }) =>
    quoteOf({ size: c.size, cameras: c.cameras, paid: { size: current, camerasPaid: currentCameras }, monthly: 50, backMonthly: 50 }));
});
let current: OnlineSize = 32;
let currentCameras = false;

describe("the camera answer at the already-paid size, from the paid chip's Change size (spec 8.6)", () => {
  it("the receipt the chip opens is a change receipt with no size chosen, the answer at what the package holds, and nothing read", () => {
    let checked = 0;
    for (const camerasPaid of [false, true]) {
      current = 64;
      currentCameras = camerasPaid;
      read.mockClear();
      const r = fromTheChip(64, camerasPaid);
      expect(r.given).toMatchObject({ mode: "change", size: null, facts: { paid: { size: 64, camerasPaid } } });
      expect(r.label(), "the button waits for a choice").toBe(EN["onlineChess.receipt.confirm.choose"]);
      expect(r.yesChecked(), `paid ${camerasPaid}: the answer the package holds`).toBe(camerasPaid);
      expect(read, "nothing is read before a choice").not.toHaveBeenCalled();
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("Yes over a package paid without it: the quote is read for the PAID size with the camera, the total is the camera difference, the door gets cameras: true", async () => {
    current = 64;
    currentCameras = false;
    const r = fromTheChip(64);
    r.answer(true);
    expect(read).toHaveBeenCalledWith("div-1", { size: 64, cameras: true });
    await flush();
    const diff = packagePrice(64, true) - packagePrice(64, false);
    expect(diff, "premise: the leaf prices the camera at 64").toBeGreaterThan(0);
    expect(r.label()).toBe(payText(diff));
    expect(textOfAll([r.by("online-receipt-row-total")!])).toBe(`${EN["onlineChess.receipt.row.total"]} ${creditsText(diff)}`);
    expect(r.title()).toBe(EN["onlineChess.receipt.title.cameras"]);
    await r.confirm();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay).toHaveBeenCalledWith("div-1", { size: 64, expectedOwed: diff, cameras: true });
    expect(refreshMock, "the page re-reads").toHaveBeenCalledTimes(1);
  });

  it("No over a package paid WITH it, before round 1: a move down at the paid size - the camera price comes back through the door with cameras: false", async () => {
    current = 64;
    currentCameras = true;
    const r = fromTheChip(64, true);
    r.answer(false);
    expect(read).toHaveBeenCalledWith("div-1", { size: 64, cameras: false });
    await flush();
    const back = packagePrice(64, true) - packagePrice(64, false);
    expect(r.label()).toBe(offText(back));
    expect(r.title()).toBe(EN["onlineChess.receipt.title.camerasOff"]);
    await r.confirm();
    expect(pay).toHaveBeenCalledWith("div-1", { size: 64, expectedOwed: -back, cameras: false, expectedForfeited: 0 });
  });

  it("sweep: at every paid size, each answer the package does not hold is read at THAT size, priced by the leaf and paid (a size is never moved by a camera)", async () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      for (const camerasPaid of [false, true]) {
        current = size;
        currentCameras = camerasPaid;
        read.mockClear();
        pay.mockClear();
        const r = fromTheChip(size, camerasPaid);
        r.answer(!camerasPaid);
        await flush();
        const owed = packagePrice(size, !camerasPaid) - packagePrice(size, camerasPaid);
        expect(read, `paid ${size}/${camerasPaid}`).toHaveBeenCalledWith("div-1", { size, cameras: !camerasPaid });
        expect(r.label(), `paid ${size}/${camerasPaid}`).toBe(owed > 0 ? payText(owed) : offText(-owed));
        await r.confirm();
        expect(pay, `paid ${size}/${camerasPaid}`).toHaveBeenCalledWith("div-1", {
          size, expectedOwed: owed, cameras: !camerasPaid, ...(owed < 0 ? { expectedForfeited: 0 } : {}),
        });
        checked += 1;
      }
    }
    expect(checked).toBe(ONLINE_SIZES.length * 2);
  });

  it("a size AND the camera from the same chip are one payment: pick 128, Yes - the door gets that size, the answer, and the net of both", async () => {
    current = 64;
    currentCameras = false;
    const r = fromTheChip(64);
    (propsOf(r.by("online-receipt-size-128")!).onChange as () => void)();
    await flush();
    r.answer(true);
    await flush();
    const owed = packagePrice(128, true) - packagePrice(64, false);
    expect(r.label()).toBe(payText(owed));
    expect(r.title()).toBe(EN["onlineChess.receipt.title.up"]!.replace("{size}", "128"));
    await r.confirm();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(pay).toHaveBeenCalledWith("div-1", { size: 128, expectedOwed: owed, cameras: true });
  });
});

// Buying credits for the camera with a SHORT balance must come back to a receipt (ruling 5), on the answer the buyer left with. The sequence, end to end
// through the real host and receipt: Yes with too few credits -> Buy credits -> the chooser is told to return with the paid size AND `cameras: true` ->
// the checkout comes back (the request the page would read from that return) -> the receipt reopens on Yes -> it pays -> the page re-reads with the
// camera paid -> the SAME address (a reload) opens nothing. Producer and consumer are the real ones on both sides of the return.
describe("a short balance for the camera: buy credits, come back to the receipt, pay, and a reload opens nothing", () => {
  const SHORT_BY_HOLDING = (size: OnlineSize, held: number) => async (_d: string, c: { size: OnlineSize; cameras: boolean }) =>
    quoteOf({ size: c.size, cameras: c.cameras, paid: { size, camerasPaid: false }, monthly: 0, pack: held });

  it("the whole sequence, at every paid size (sweep)", async () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      current = size;
      currentCameras = false;
      const diff = packagePrice(size, true) - packagePrice(size, false);
      // 1. the organiser holds nothing: Yes is short, so the button says Buy credits
      read.mockReset().mockImplementation(SHORT_BY_HOLDING(size, 0));
      const r = fromTheChip(size);
      r.answer(true);
      await flush();
      expect(r.label(), `paid ${size}`).toBe(EN["onlineChess.receipt.confirm.buy"]);
      await (propsOf(r.by("online-receipt-confirm")!).onClick as () => Promise<void>)();
      // 2. the chooser the receipt shows is handed the paid size and the answer - the address Stripe will return to
      const chooser = r.els().find((e) => e.type === BuyStreamCredits);
      expect(chooser, `paid ${size}: the buy view shows the chooser`).toBeDefined();
      const returnTo = (propsOf(chooser!) as unknown as { returnTo: { divisionId: string; size: OnlineSize; cameras?: boolean } }).returnTo;
      expect(returnTo, `paid ${size}`).toEqual({ divisionId: "div-1", size, cameras: true });
      // 3. Stripe returns (the route writes `size` and `cameras=1`; the page's parser reads them back - proven end to end in route-online-chess.test.ts):
      //    the page hands the host that request over the same stored package, and the receipt reopens on Yes, quoted at the paid size
      const request = { size: returnTo.size, key: "cs_after_stripe", cameras: returnTo.cameras! };
      read.mockReset().mockImplementation(SHORT_BY_HOLDING(size, diff + 5));
      const back = renderIsland(OnlinePackageHost, { ...hostProps(size), request });
      const reopened = back.tree().find((e): e is ReactElement => e.type === OnlineReceipt);
      expect(reopened, `paid ${size}: the return reopens a receipt (ruling 5)`).toBeDefined();
      const given = propsOf(reopened!) as unknown as OnlineReceiptProps;
      expect(given, `paid ${size}`).toMatchObject({ mode: "change", size: null, cameras: true });
      const receipt = renderIsland(OnlineReceipt, given);
      expect(read, `paid ${size}: the quote is read at once, for the paid size with the camera`).toHaveBeenCalledWith("div-1", { size, cameras: true });
      await flush();
      const pressEls = () => expandAll(receipt.tree());
      const confirm = pressEls().find((e) => propsOf(e)["data-testid"] === "online-receipt-confirm")!;
      expect(textOfAll([confirm]), `paid ${size}`).toBe(payText(diff));
      expect(propsOf(pressEls().find((e) => propsOf(e)["data-testid"] === "online-receipt-cameras-yes")!).checked, `paid ${size}: Yes`).toBe(true);
      // 4. pay: the door gets the camera answer; the page re-reads
      pay.mockClear();
      await (propsOf(confirm).onClick as () => Promise<void>)();
      await flush();
      expect(pay, `paid ${size}`).toHaveBeenCalledWith("div-1", { size, expectedOwed: diff, cameras: true });
      // 5. the camera is paid now: a reload of the SAME address opens nothing (m4 kept)
      const reloaded = renderIsland(OnlinePackageHost, { ...hostProps(size, true), request });
      expect(reloaded.tree().some((e) => e.type === OnlineReceipt), `paid ${size}: the reload after a completed camera purchase`).toBe(false);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every size ran the whole sequence").toBe(ONLINE_SIZES.length);
  });

  it("the same short balance on a plain move hands the chooser the answer No, and that return opens the move on No", async () => {
    current = 32;
    currentCameras = false;
    read.mockReset().mockImplementation(SHORT_BY_HOLDING(32, 0));
    const r = fromTheChip(32);
    (propsOf(r.by("online-receipt-size-64")!).onChange as () => void)();
    await flush();
    await (propsOf(r.by("online-receipt-confirm")!).onClick as () => Promise<void>)();
    const returnTo = (propsOf(r.els().find((e) => e.type === BuyStreamCredits)!) as unknown as { returnTo: { size: OnlineSize; cameras: boolean } }).returnTo;
    expect(returnTo).toEqual({ divisionId: "div-1", size: 64, cameras: false });
    const back = renderIsland(OnlinePackageHost, { ...hostProps(32), request: { size: 64, key: "cs_move", cameras: returnTo.cameras } });
    const given = propsOf(back.tree().find((e) => e.type === OnlineReceipt)!) as unknown as OnlineReceiptProps;
    expect(given).toMatchObject({ mode: "change", size: 64, cameras: false });
  });
});
