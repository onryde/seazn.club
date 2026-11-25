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
const receiptProps = (h: Host) => propsOf(receipt(h)!) as unknown as { addCameras?: boolean; mode: string; size: OnlineSize | null; facts: Record<string, unknown>; onClose: () => void; onConfirm: (b: PayBody) => Promise<void>; renderBuy: (a: { pack: 1 | 5 | 20; size: OnlineSize }) => ReactElement };
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
    expect(receiptProps(mount({ stored: PAID, request: { size: 16, key: "cs_a" } })), "a size below the paid one is still a move the buyer named").toMatchObject({ mode: "change", size: 16 });
  });

  // Fix round 1 (m4): `?oc=pay&size=N` stays in the address after the buyer pays, so a RELOAD hands the host the same request over a package that is now
  // paid at that size - a `change` receipt that owes nothing. An arrival whose business is done (the paid size IS the size it names, or it names none:
  // a first payment, already made) opens nothing; a request that names a DIFFERENT size is a genuine move and still opens (ruling 5).
  it("a PAID package whose paid size IS the size the address names, or that names none, opens nothing: the reload after paying (m4)", () => {
    expect(receipt(mount({ stored: PAID, request: { size: 32, key: "cs_a" } })), "named size = paid size").toBeUndefined();
    expect(receipt(mount({ stored: PAID, request: { size: null, key: "cs_a" } })), "no size named: the first payment is already made").toBeUndefined();
  });

  it("sweep: for every paid size S, the arrival opens a change receipt exactly for the sizes that are not S, and for no size when it names none", () => {
    let opened = 0;
    let skipped = 0;
    for (const paid of ONLINE_SIZES) {
      const stored = { size: paid, paid: { size: paid, camerasPaid: false }, frozen: false };
      for (const named of ONLINE_SIZES) {
        const r = receipt(mount({ stored, request: { size: named, key: "cs_a" } }));
        if (named === paid) {
          expect(r, `paid ${paid}, named ${named}`).toBeUndefined();
          skipped += 1;
        } else {
          expect(r, `paid ${paid}, named ${named}`).toBeDefined();
          expect(receiptProps(mount({ stored, request: { size: named, key: "cs_a" } })), `paid ${paid}, named ${named}`).toMatchObject({ mode: "change", size: named });
          opened += 1;
        }
      }
      expect(receipt(mount({ stored, request: { size: null, key: "cs_a" } })), `paid ${paid}, none named`).toBeUndefined();
    }
    expect(skipped, "one skipped cell per size").toBe(ONLINE_SIZES.length);
    expect(opened, "every other cell opened").toBe(ONLINE_SIZES.length * (ONLINE_SIZES.length - 1));
  });

  it("the whole sequence: pay on the return, then RELOAD the same address - the paid package opens no receipt; a genuine NEW arrival after that still does (ruling 5)", async () => {
    const first = mount({ request: { size: null, key: "cs_a" } });
    expect(receiptProps(first)).toMatchObject({ mode: "pay", size: 64 });
    await receiptProps(first).onConfirm({ size: 64, expectedOwed: 8 });
    expect(pay).toHaveBeenCalledTimes(1);
    const paid = { size: 64 as OnlineSize, paid: { size: 64 as OnlineSize, camerasPaid: false }, frozen: false };
    const reload = mount({ stored: paid, request: { size: null, key: "cs_a" } }); // a browser reload: a fresh mount, the same address
    expect(receipt(reload), "the reload after paying").toBeUndefined();
    reload.rerender({ ...PROPS, stored: paid, request: null });
    reload.rerender({ ...PROPS, stored: paid, request: { size: 128, key: "cs_b" } }); // another payment's return, naming a size the package is not at
    expect(receiptProps(reload)).toMatchObject({ mode: "change", size: 128 });
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

// Fix round 3: the CAMERA of a paid package, bought with a short balance, comes back as `?oc=pay&size=<paid size>&cameras=1`. The paid size alone names
// nothing to pay (m4: it opens nothing), so the intent is what reopens the receipt - on the paid size with the camera box ticked - until the camera is
// paid; once it is (`camerasPaid`), the same address is a finished arrival and a reload opens nothing (m4 holds).
describe("the checkout return for the CAMERA of a paid package (the intent rides `cameras=1`)", () => {
  const PAID_WITH_CAMERA = { ...PAID, paid: { size: 32 as OnlineSize, camerasPaid: true } };

  it("paid WITHOUT cameras + the intent: a change receipt on the PAID size with the camera ticked - whether the address names the paid size or none", () => {
    for (const request of [{ size: 32 as OnlineSize, key: "cs_a", cameras: true as const }, { size: null, key: "cs_a", cameras: true as const }]) {
      const r = receiptProps(mount({ stored: PAID, request }));
      expect(r, JSON.stringify(request)).toMatchObject({ mode: "change", size: 32, addCameras: true, facts: { paid: { size: 32, camerasPaid: false } } });
    }
  });

  it("a move WITH the camera (the address names another size): the change receipt opens on THAT size with the camera ticked", () => {
    expect(receiptProps(mount({ stored: PAID, request: { size: 128, key: "cs_a", cameras: true } }))).toMatchObject({ mode: "change", size: 128, addCameras: true });
  });

  it("m4 holds: no intent over a paid package at the paid size opens nothing, and a MOVE without the intent opens a receipt with the box off", () => {
    expect(receipt(mount({ stored: PAID, request: { size: 32, key: "cs_a" } })), "the reload after paying").toBeUndefined();
    expect(receiptProps(mount({ stored: PAID, request: { size: 128, key: "cs_a" } }))).toMatchObject({ mode: "change", size: 128 });
    expect(receiptProps(mount({ stored: PAID, request: { size: 128, key: "cs_a" } })).addCameras, "no intent, box off").toBeUndefined();
  });

  it("the camera already paid: the same address opens nothing at the paid size (the reload after the purchase), and a move opens WITHOUT the intent", () => {
    expect(receipt(mount({ stored: PAID_WITH_CAMERA, request: { size: 32, key: "cs_a", cameras: true } })), "reload after a completed camera purchase").toBeUndefined();
    expect(receipt(mount({ stored: PAID_WITH_CAMERA, request: { size: null, key: "cs_a", cameras: true } }))).toBeUndefined();
    const moved = receiptProps(mount({ stored: PAID_WITH_CAMERA, request: { size: 128, key: "cs_a", cameras: true } }));
    expect(moved).toMatchObject({ mode: "change", size: 128 });
    expect(moved.addCameras, "nothing to add: the package has the camera").toBeUndefined();
  });

  it("an UNPAID package ignores the intent (there is nothing to add a camera to): the pay receipt opens as before, with no seeded box", () => {
    const r = receiptProps(mount({ request: { size: 128, key: "cs_a", cameras: true } }));
    expect(r).toMatchObject({ mode: "pay", size: 128 });
    expect(r.addCameras).toBeUndefined();
  });

  it("frozen and missing packages open nothing, intent or not", () => {
    for (const stored of [FROZEN_PAID, GRANDFATHERED, null]) expect(receipt(mount({ stored, request: { size: null, key: "cs_a", cameras: true } })), String(stored?.size)).toBeUndefined();
  });

  it("sweep: at every paid size, the paid size + intent opens the camera receipt on THAT size; once the camera is paid it opens nothing", () => {
    let checked = 0;
    for (const size of ONLINE_SIZES) {
      const without = { size, paid: { size, camerasPaid: false }, frozen: false };
      const withCam = { size, paid: { size, camerasPaid: true }, frozen: false };
      expect(receiptProps(mount({ stored: without, request: { size, key: "cs_a", cameras: true } })), `paid ${size}`).toMatchObject({ mode: "change", size, addCameras: true });
      expect(receipt(mount({ stored: withCam, request: { size, key: "cs_a", cameras: true } })), `paid ${size}, camera paid`).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBe(ONLINE_SIZES.length);
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
    const h = mount({ stored: PAID, request: { size: 64, key: "cs_a" } }); // an upgrade's return (a request naming the paid size opens nothing: m4)
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

// Fix round 3: spec 8.6 puts "Fair-play camera is paid. Turn it on in Division rules." AFTER payment. The receipt closes on success, so the host says it on the page.
describe("after a camera payment the page says where to turn the camera on (spec 8.6)", () => {
  const SAYS = EN["onlineChess.receipt.cameras.paid"]!;
  const noteOf = (h: Host) => h.tree().find((e) => propsOf(e)["data-testid"] === "online-package-notice");

  it("a paid-and-applied payment that included the camera shows the line; one that did not shows none; the next payment without it clears it (sequence)", async () => {
    const h = mount({ stored: PAID });
    expect(noteOf(h), "before any payment").toBeUndefined();
    await (propsOf(find(h, OnlinePaidChip)!).onChangeSize as () => void)();
    await receiptProps(h).onConfirm({ size: 32, expectedOwed: 1, addCameras: true });
    await flush();
    expect(String(propsOf(noteOf(h)!).children)).toBe(SAYS);
    (propsOf(find(h, OnlinePaidChip)!).onChangeSize as () => void)();
    await receiptProps(h).onConfirm({ size: 64, expectedOwed: 4 });
    await flush();
    expect(noteOf(h), "a payment without the camera says nothing about it").toBeUndefined();
  });

  it("nothing is said when the door did not apply the payment (the camera was already paid), and a lowered capacity is said beside it", async () => {
    pay.mockResolvedValueOnce({ applied: false, capacityLoweredTo: null });
    const h = mount({ stored: PAID });
    (propsOf(find(h, OnlinePaidChip)!).onChangeSize as () => void)();
    await receiptProps(h).onConfirm({ size: 32, expectedOwed: 0, addCameras: true });
    await flush();
    expect(noteOf(h), "applied: false").toBeUndefined();
    pay.mockResolvedValueOnce({ applied: true, capacityLoweredTo: 16 });
    (propsOf(find(h, OnlinePaidChip)!).onChangeSize as () => void)();
    await receiptProps(h).onConfirm({ size: 16, expectedOwed: -1, addCameras: true });
    await flush();
    expect(String(propsOf(noteOf(h)!).children)).toBe(`${fill(EN["onlineChess.capacityLowered"]!, { size: 16 })} ${SAYS}`);
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
