// The Online Chess size choice in the Division rules strip (spec 2026-11-23-online-chess-credits-design.md §8.1, §8.2; plan Task 11):
// the "Players, up to" select and its price line under a Lichess division, the format refusal beside the Lichess option, the size a
// Save sends, what a paid pick opens, what a save says it did to the capacity, and the four package refusals in the organiser's words.
// Driven through the REAL strip (hook harness: handlers are the strip's own), with the select and price line opened one level so
// their text is what a person reads. The refusals are the server's real ones (`format.ts` builders); prices, ladder and rounds are
// the leaf's and the spec's, never read back from the strip.
//
// single-sport: Online Chess is boardgame only (online-play.ts); one case proves another sport never gets the select.
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule } from "@seazn/engine/sport";
import { expandWithHooks, propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { OnlinePriceLine } from "@/components/v2/online-chess/price-line";
import { OnlineSizeSelect } from "@/components/v2/online-chess/size-select";
import type { DivisionRulesDraft, OnlinePackageStrip } from "@/components/v2/rules/division-rules-strip";
import { ONLINE_PACKAGE_CODES, packagePrice } from "@/lib/online-chess-package";
import { ApiV1Error as RealApiV1Error } from "@/lib/client-v1";
import { camerasNeedUpgrade, formatNotSupported, roundsAboveMax, roundsNeedSize } from "@/server/usecases/online-package/format";
import uiEn from "@/dictionaries/en/ui.json";
import { ALL_PANELS, DivisionRulesStrip, expandRules, stripPropsOf } from "./_rules-strip";

const { refreshMock, confirmMock, confirmState } = vi.hoisted(() => ({ refreshMock: vi.fn(), confirmMock: vi.fn(), confirmState: { mounted: true } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn(), replace: vi.fn() }),
}));
// The house confirm dialog (a provider the root layout mounts): the answer each test hands back, or no dialog mounted at all.
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => (confirmState.mounted ? confirmMock : null) }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
  useLocaleOrDefault: () => "en" as const,
}));
const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

const UI = uiEn as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
const mod = (key: string): AnySportModule => builtinModules.find((x) => x.key === key) as AnySportModule;
const CHESS_VARIANTS = Object.entries(mod("boardgame").variants as Record<string, Record<string, unknown>>).map(([k, config]) => ({ key: k, name: k, system: true, config }));
const CLOCK = { base: 600, increment: 5 };
const ON = { variant: "classical", onlinePlay: "lichess", clock: CLOCK };
const OFF = { variant: "classical", clock: CLOCK };

/** The strip's facts about a division with an unpaid 16 that holds nothing, on a plan with no cap and 11 credits. */
const unpaid = (over: Partial<OnlinePackageStrip> = {}): OnlinePackageStrip => ({
  planCap: null, held: 0, rounds: 0, cameras: false, balance: 11, buyMoreHref: "/o/acme/settings/credits?kind=stream", stageKinds: ["swiss"],
  stored: { size: 16, paid: null, frozen: false }, receipt: null, ...over,
});

/** The tree with the select and price line opened one level (each reads `useMsg` only), as a browser renders them. */
function expandAll(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  for (const el of expandRules(node)) {
    out.push(el);
    if (el.type === OnlineSizeSelect || el.type === OnlinePriceLine) out.push(...walk(expandWithHooks(el.type as (props: unknown) => ReactNode, el.props)));
  }
  return out;
}
function mount(config: Record<string, unknown>, onlinePackage: OnlinePackageStrip | undefined, over: { sport?: string; viewerPlan?: "community" | "pro" } = {}) {
  return renderIsland(
    DivisionRulesStrip,
    stripPropsOf(
      { division: { id: "d1", sport_key: over.sport ?? "boardgame", variant_key: "classical", config }, variants: CHESS_VARIANTS, onlineChessOffered: true, viewerPlan: over.viewerPlan },
      { initialOpen: ALL_PANELS, tableKinds: ["league"], ...(onlinePackage === undefined ? {} : { onlinePackage }) },
    ),
    expandAll,
  );
}
type Strip = ReturnType<typeof mount>;
const byTestId = (island: Strip, id: string) => island.tree().find((e) => propsOf(e)["data-testid"] === id);
const sizeSelect = (island: Strip) => island.tree().find((e) => e.type === OnlineSizeSelect);
const optionsOf = (island: Strip) => island.tree().filter((e) => e.type === "option");
const lichessOption = (island: Strip) => island.tree().find((e) => e.type === "option" && propsOf(e).value === "lichess");
const saveButton = (island: Strip) => island.tree().find((n) => n.type === "button" && textOf(n).trim() === "Save match rules");
const lastPatch = () => {
  const calls = apiV1Mock.mock.calls.filter(([url, o]) => url === "/api/v1/divisions/d1" && (o as { method?: string }).method === "PATCH");
  expect(calls.length, "premise: the save went to the server").toBeGreaterThan(0);
  return (calls.at(-1)![1] as { json: Record<string, unknown> }).json;
};
const pickOnlinePlay = (island: Strip, value: "off" | "lichess") =>
  (propsOf(byTestId(island, "division-online-play")!).onChange as (e: { target: { value: string } }) => void)({ target: { value } });

beforeEach(() => {
  apiV1Mock.mockReset().mockResolvedValue({});
  refreshMock.mockReset();
  confirmMock.mockReset().mockResolvedValue(true);
  confirmState.mounted = true;
});

describe("the size select appears under a Lichess division, and only there", () => {
  it("is drawn for a division that plays on Lichess, with the places, rounds, plan and package the page read", () => {
    const island = mount(ON, unpaid({ held: 3, rounds: 5, planCap: 64 }), { viewerPlan: "community" });
    const select = sizeSelect(island);
    expect(select, "the select").toBeDefined();
    expect(propsOf(select!)).toMatchObject({ value: 16, held: 3, rounds: 5, planCap: 64, viewerPlan: "community", cameras: false, paid: null });
    expect(byTestId(island, "online-size-select"), "its own <select> is in the tree").toBeDefined();
    expect(optionsOf(island).filter((o) => /up to \d+ rounds/.test(textOf(o))).map((o) => propsOf(o).value)).toEqual([16, 32, 64, 128, 256]);
  });

  it("is absent when online play is off, appears the moment Lichess is chosen, and goes when it is turned off again", () => {
    const island = mount(OFF, unpaid({ stored: null }));
    expect(sizeSelect(island)).toBeUndefined();
    pickOnlinePlay(island, "lichess");
    expect(sizeSelect(island), "Lichess chosen: the select").toBeDefined();
    pickOnlinePlay(island, "off");
    expect(sizeSelect(island), "off again: gone").toBeUndefined();
    expect(byTestId(island, "online-price-line")).toBeUndefined();
  });

  it("is absent with no package facts (a club the feature is not offered to), and for another sport", () => {
    expect(sizeSelect(mount(ON, undefined))).toBeUndefined();
    expect(sizeSelect(mount({ onlinePlay: "lichess" }, unpaid(), { sport: "football" }))).toBeUndefined();
  });
});

describe("the size a Save sends", () => {
  it("a picked size rides the format save as online_size, beside the config", async () => {
    const island = mount(ON, unpaid());
    (propsOf(sizeSelect(island)!).onChange as (n: number) => void)(64);
    expect(propsOf(sizeSelect(island)!).value, "the select shows the pick").toBe(64);
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
    const body = lastPatch();
    expect(body.online_size).toBe(64);
    expect((body.config as Record<string, unknown>).onlinePlay).toBe("lichess");
  });

  it("an untouched select sends no size when the stored size still stands (a plain rules save moves nothing)", async () => {
    const island = mount(ON, unpaid({ stored: { size: 32, paid: null, frozen: false }, rounds: 7 }));
    expect(propsOf(sizeSelect(island)!).value).toBe(32);
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
    expect(lastPatch()).not.toHaveProperty("online_size");
  });

  it("turning Lichess on sends the size the select shows - the default for the places and rounds, never the server's own 16", async () => {
    const island = mount(OFF, unpaid({ stored: null, held: 20, rounds: 7 }));
    pickOnlinePlay(island, "lichess");
    expect(propsOf(sizeSelect(island)!).value, "20 places and 7 rounds: 32 is the smallest that holds both").toBe(32);
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
    expect(lastPatch().online_size).toBe(32);
  });

  it("a stored size the rounds have outgrown is dropped for the size that covers them, and the save moves it", async () => {
    const island = mount(ON, unpaid({ stored: { size: 16, paid: null, frozen: false }, rounds: 8 }));
    expect(propsOf(sizeSelect(island)!).value, "16 includes 6 rounds; 8 need 64").toBe(64);
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
    expect(lastPatch().online_size).toBe(64);
  });

  it("switching online play OFF sends no size", async () => {
    const island = mount(ON, unpaid());
    pickOnlinePlay(island, "off");
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
    expect(lastPatch()).not.toHaveProperty("online_size");
  });

  it("a PAID package never sends a size, and a pick opens the receipt instead of saving", async () => {
    const island = mount(ON, unpaid({ stored: { size: 32, paid: { size: 32, camerasPaid: false }, frozen: false }, rounds: 7 }));
    expect(propsOf(sizeSelect(island)!)).toMatchObject({ value: 32, paid: { size: 32, camerasPaid: false } });
    expect(byTestId(island, "online-receipt-request"), "no receipt asked yet").toBeUndefined();
    (propsOf(sizeSelect(island)!).onPaidPick as (n: number) => void)(128);
    expect(propsOf(byTestId(island, "online-receipt-request")!)["data-receipt-size"], "the receipt is asked for the picked size").toBe("128");
    expect(propsOf(sizeSelect(island)!).value, "the select keeps the paid size").toBe(32);
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
    expect(lastPatch()).not.toHaveProperty("online_size");
  });

  it("a FROZEN package is read only and never sends a size", async () => {
    const island = mount(ON, unpaid({ stored: { size: 64, paid: null, frozen: true }, rounds: 5 }));
    expect(propsOf(sizeSelect(island)!)).toMatchObject({ value: 64, frozen: true });
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
    expect(lastPatch()).not.toHaveProperty("online_size");
  });

  it("a paid or frozen package on a plan since downgraded below its size still shows its own size and sends nothing", async () => {
    // 32 paid, 64 frozen: each is over a plan cap of 16 now, so an unlocked pick would be dropped for the default (16) and a save
    // would send it - the server's 409 online_size_paid / online_size_frozen. Locked, the select keeps the package's own size.
    const cases = [
      { label: "paid", stored: { size: 32, paid: { size: 32, camerasPaid: false }, frozen: false } },
      { label: "frozen", stored: { size: 64, paid: null, frozen: true } },
    ] as const;
    for (const c of cases) {
      apiV1Mock.mockClear();
      const island = mount(ON, unpaid({ planCap: 16, rounds: 5, stored: c.stored }));
      expect(propsOf(sizeSelect(island)!).value, c.label).toBe(c.stored.size);
      (propsOf(saveButton(island)!).onClick as () => void)();
      await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalled());
      expect(lastPatch(), c.label).not.toHaveProperty("online_size");
    }
  });

  it("no size holds the rounds (more than any size includes): the save is stopped here with the rounds sentence, nothing is sent", async () => {
    const island = mount(ON, unpaid({ rounds: 11 }));
    expect(propsOf(sizeSelect(island)!).value).toBeNull();
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(byTestId(island, "division-settings-error")).toBeDefined());
    expect(textOf(byTestId(island, "division-settings-error")!)).toBe(fill(UI["onlineChess.roundsAboveMax"]!, { max: 10 }));
    expect(apiV1Mock, "nothing was sent").not.toHaveBeenCalled();
  });
});

describe("the receipt request the checkout return carries (oc=pay)", () => {
  it("opens on mount with the size the address named, or the stored size when it named none", () => {
    expect(propsOf(byTestId(mount(ON, unpaid({ receipt: { size: 64 } })), "online-receipt-request")!)["data-receipt-size"]).toBe("64");
    expect(propsOf(byTestId(mount(ON, unpaid({ receipt: { size: null } })), "online-receipt-request")!)["data-receipt-size"]).toBe("stored");
    expect(byTestId(mount(ON, unpaid({ receipt: null })), "online-receipt-request")).toBeUndefined();
  });
});

describe("the price line", () => {
  const line = (island: Strip) => {
    const el = byTestId(island, "online-price-line");
    return el === undefined ? undefined : textOf(el).replace(/\s+/g, " ").trim();
  };

  it("says what the shown size costs, what the club holds, and where to buy more", () => {
    const island = mount(ON, unpaid({ stored: { size: 32, paid: null, frozen: false }, rounds: 7, balance: 11 }));
    expect(line(island)).toContain("Online Chess: 2 credits · You have 11 credits · Buy more"); // Global Constraints: 32 -> 2 credits
    expect(propsOf(island.tree().find((e) => e.type === "a" && propsOf(e)["data-testid"] === "online-buy-more")!).href).toBe("/o/acme/settings/credits?kind=stream");
  });

  it("follows the pick, and the camera: 128 with the Fair-play camera is 16 credits (Global Constraints)", () => {
    const island = mount(ON, unpaid({ cameras: true }));
    expect(line(island)).toContain("Online Chess: 2 credits"); // 16 with cameras
    (propsOf(sizeSelect(island)!).onChange as (n: number) => void)(128);
    expect(line(island)).toContain("Online Chess: 16 credits");
  });

  it("is not drawn for a paid package (the receipt is its money line) or when no size holds the rounds", () => {
    expect(line(mount(ON, unpaid({ stored: { size: 32, paid: { size: 32, camerasPaid: false }, frozen: false } })))).toBeUndefined();
    expect(line(mount(ON, unpaid({ rounds: 11 })))).toBeUndefined();
  });
});

describe("Online Chess runs Swiss and knockout events: the Lichess option and the format", () => {
  it("a division holding a league (or group, or ladder) cannot be switched to Lichess: the option is disabled and says why", () => {
    for (const kind of ["league", "group", "ladder", "americano"]) {
      const island = mount(OFF, unpaid({ stored: null, stageKinds: ["swiss", kind] }));
      expect(propsOf(lichessOption(island)!).disabled, kind).toBe(true);
      expect(textOf(byTestId(island, "division-online-format-refused")!), kind).toBe(UI["onlineChess.format.stripLine"]);
    }
    expect(UI["onlineChess.format.stripLine"]).toBe("Online Chess runs Swiss and knockout events. Change the format to play online.");
  });

  it("Swiss and knockout formats leave the option open, with no reason shown (the positive pair)", () => {
    for (const kinds of [["swiss"], ["knockout"], ["swiss", "knockout"], ["double_elim"], []]) {
      const island = mount(OFF, unpaid({ stored: null, stageKinds: kinds }));
      expect(propsOf(lichessOption(island)!).disabled, kinds.join()).toBeFalsy();
      expect(byTestId(island, "division-online-format-refused"), kinds.join()).toBeUndefined();
    }
  });

  it("a division ALREADY online that holds one stays readable and keeps saving: the option stays open", () => {
    const island = mount(ON, unpaid({ stageKinds: ["league"] }));
    expect(propsOf(lichessOption(island)!).disabled).toBeFalsy();
    expect(byTestId(island, "division-online-format-refused")).toBeUndefined();
  });

  it("the sequence: that legacy division switched off in the form keeps the way back open (its stored play is still Lichess)", () => {
    const island = mount(ON, unpaid({ stageKinds: ["league"] }));
    pickOnlinePlay(island, "off");
    expect(propsOf(lichessOption(island)!).disabled, "stored online play is still Lichess: the way back stays open").toBeFalsy();
  });
});

describe("a refreshed package (after a save, or another tab's) re-seeds the pick", () => {
  it("the page's new stored size replaces the organiser's old pick; an unchanged package leaves the pick alone (the sequence)", () => {
    const island = mount(ON, unpaid());
    (propsOf(sizeSelect(island)!).onChange as (n: number) => void)(64);
    expect(propsOf(sizeSelect(island)!).value).toBe(64);
    // A refresh that hands back the SAME package keeps what was picked...
    island.rerender(stripPropsOf({ division: { id: "d1", sport_key: "boardgame", variant_key: "classical", config: ON }, variants: CHESS_VARIANTS, onlineChessOffered: true }, { initialOpen: ALL_PANELS, tableKinds: ["league"], onlinePackage: unpaid() }));
    expect(propsOf(sizeSelect(island)!).value, "same package: the pick stays").toBe(64);
    // ...and one that carries a different stored size (the save landed at 128, or another tab moved it) shows that.
    island.rerender(stripPropsOf({ division: { id: "d1", sport_key: "boardgame", variant_key: "classical", config: ON }, variants: CHESS_VARIANTS, onlineChessOffered: true }, { initialOpen: ALL_PANELS, tableKinds: ["league"], onlinePackage: unpaid({ stored: { size: 128, paid: null, frozen: false } }) }));
    expect(propsOf(sizeSelect(island)!).value).toBe(128);
  });
});

describe("what a save says it did to the registration capacity", () => {
  it("one localized line with the size, when the save lowered the capacity", async () => {
    apiV1Mock.mockResolvedValue({ id: "d1", online: { capacityLoweredTo: 32, refunded: null } });
    const island = mount(ON, unpaid());
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(byTestId(island, "division-capacity-lowered")).toBeDefined());
    expect(textOf(byTestId(island, "division-capacity-lowered")!)).toBe("Registration is now limited to 32 players, to match the size.");
    expect(byTestId(island, "division-rules-saved"), "the ordinary saved notice is still there").toBeDefined();
  });

  it("nothing when it lowered none, and the line goes with the next save that lowers none (the sequence)", async () => {
    apiV1Mock.mockResolvedValueOnce({ online: { capacityLoweredTo: 16, refunded: null } }).mockResolvedValue({ online: { capacityLoweredTo: null, refunded: null } });
    const island = mount(ON, unpaid());
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(byTestId(island, "division-capacity-lowered")).toBeDefined());
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(byTestId(island, "division-capacity-lowered")).toBeUndefined());
    expect(byTestId(island, "division-rules-saved")).toBeDefined();
  });
});

describe("the four package refusals, said in the organiser's words off the code", () => {
  const SERVER_WORDING = "server wording - English only";
  const asApi = (e: { status: number; code?: string; extra?: unknown }) =>
    new RealApiV1Error(SERVER_WORDING, e.status, String(e.code), (e.extra ?? {}) as Record<string, unknown>);
  const refused = async (e: { status: number; code?: string; extra?: unknown }) => {
    apiV1Mock.mockRejectedValueOnce(asApi(e));
    const island = mount(ON, unpaid());
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(byTestId(island, "division-settings-error")).toBeDefined());
    return textOf(byTestId(island, "division-settings-error")!);
  };

  it("ONLINE_FORMAT_NOT_SUPPORTED, ONLINE_ROUNDS_NEED_SIZE (offering nextSize), ONLINE_ROUNDS_ABOVE_MAX and ONLINE_CAMERAS_NEED_UPGRADE", async () => {
    expect(await refused(formatNotSupported("league"))).toBe(UI["onlineChess.format.refused"]);
    expect(await refused(roundsNeedSize(16, 8))).toBe(fill(UI["onlineChess.roundsNeedSize"]!, { nextSize: 64 }));
    expect(await refused(roundsAboveMax(11))).toBe(fill(UI["onlineChess.roundsAboveMax"]!, { max: 10 }));
    expect(await refused(camerasNeedUpgrade([{ id: "d9", name: "Under 12", owed: 2 }]))).toBe(fill(UI["onlineChess.camerasNeedUpgrade"]!, { names: "Under 12" }));
    expect(ONLINE_PACKAGE_CODES.roundsNeedSize).toBeDefined();
  });

  it("the server's own English is never shown for them", async () => {
    for (const e of [formatNotSupported("group"), roundsNeedSize(16, 8), roundsAboveMax(12)]) expect(await refused(e)).not.toContain(SERVER_WORDING);
  });
});

describe("the builder's draft: the same select, owned by the builder", () => {
  const draftOn = (over: Partial<DivisionRulesDraft> = {}): DivisionRulesDraft => ({
    variantKey: "classical", onVariantChange: vi.fn(), ruleValues: {}, setRuleValues: vi.fn(), onlinePlay: "lichess", setOnlinePlay: vi.fn(),
    pointsValues: null, setPointsValues: vi.fn(), order: null, setOrder: vi.fn(), ...over,
  });
  const facts = { planCap: null, held: 0, rounds: 0, cameras: false, balance: 11, buyMoreHref: "/o/acme/settings/credits?kind=stream", stageKinds: ["swiss"] };
  /** `config`: what the builder hands the strip - the variant's preset, plus `onlinePlay` when the draft is on Lichess. */
  const mountDraft = (draft: DivisionRulesDraft, config: Record<string, unknown> = {}) =>
    renderIsland(
      DivisionRulesStrip,
      stripPropsOf({ division: { id: "", sport_key: "boardgame", variant_key: "classical", config: { ...(mod("boardgame").variants.classical as object), ...config } }, variants: CHESS_VARIANTS, onlineChessOffered: true }, { draft, initialOpen: ALL_PANELS, tableKinds: ["league"] }),
      expandAll,
    );

  it("follows the rounds of the drafted format until a size is picked, and a pick calls the builder's setter", () => {
    const setSize = vi.fn();
    const island = mountDraft(draftOn({ onlinePackage: { ...facts, rounds: 7, size: null, setSize } }));
    expect(propsOf(sizeSelect(island)!).value, "7 Swiss rounds: 32 includes them").toBe(32);
    (propsOf(sizeSelect(island)!).onChange as (n: number) => void)(128);
    expect(setSize).toHaveBeenCalledExactlyOnceWith(128);
    expect(lastNoSave(island), "a draft has no Save").toBe(true);
  });

  it("shows the price line with the shown size's price and the club's balance, and a picked size that stopped fitting is dropped", () => {
    const island = mountDraft(draftOn({ onlinePackage: { ...facts, rounds: 8, size: 16, setSize: vi.fn() } }));
    expect(propsOf(sizeSelect(island)!).value, "16 includes 6 rounds, not 8").toBe(64);
    expect(textOf(byTestId(island, "online-price-line")!).replace(/\s+/g, " ")).toContain("Online Chess: 4 credits · You have 11 credits");
  });

  it("the Lichess option is disabled while the drafted format holds a refused stage, whatever was saved before", () => {
    const island = mountDraft(draftOn({ onlinePlay: "off", onlinePackage: { ...facts, stageKinds: ["league"], size: null, setSize: vi.fn() } }));
    expect(propsOf(lichessOption(island)!).disabled).toBe(true);
    expect(byTestId(island, "division-online-format-refused")).toBeDefined();
  });

  it("a draft already on Lichess whose format then turned to a refused one keeps the option greyed and says why (the combination the step check also stops)", () => {
    const island = mountDraft(draftOn({ onlinePlay: "lichess", onlinePackage: { ...facts, stageKinds: ["group"], size: null, setSize: vi.fn() } }), { onlinePlay: "lichess" });
    expect(propsOf(lichessOption(island)!).disabled).toBe(true);
    expect(byTestId(island, "division-online-format-refused")).toBeDefined();
  });

  it("is absent while online play is off in the draft", () => {
    expect(sizeSelect(mountDraft(draftOn({ onlinePlay: "off", onlinePackage: { ...facts, size: null, setSize: vi.fn() } })))).toBeUndefined();
  });
});

/** A draft draws no Save button anywhere (the builder sends it at Create). */
const lastNoSave = (island: Strip) => island.tree().every((e) => !(e.type === "button" && /Save/.test(textOf(e))));

describe("switching Online play off a PAID package: asked first, and the refund said after (T11 fix round 1, the review's gap)", () => {
  const paid = (size: 16 | 32 | 64 | 128 | 256, camerasPaid = false, frozen = false) => unpaid({ stored: { size, paid: { size, camerasPaid }, frozen } });
  const save = (island: Strip) => (propsOf(saveButton(island)!).onClick as () => void)();
  const confirmOpts = () => confirmMock.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string; cancelLabel: string; tone: string };

  it("asks once, before any request, with what was paid, what comes back and what may not - and a yes saves the switch-off", async () => {
    const island = mount(ON, paid(64));
    pickOnlinePlay(island, "off");
    save(island);
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalledTimes(1));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.invocationCallOrder[0], "asked BEFORE the request").toBeLessThan(apiV1Mock.mock.invocationCallOrder[0]!);
    const price = packagePrice(64, false); // 4 credits, from the leaf
    expect(price, "premise: a plural price, so the sentence is the .other one").toBeGreaterThan(1);
    expect(confirmOpts()).toMatchObject({
      title: UI["onlineChess.switchOff.title"],
      body: fill(UI["onlineChess.switchOff.body.other"]!, { count: price, size: 64 }),
      confirmLabel: UI["onlineChess.switchOff.confirm"],
      cancelLabel: UI["confirm.cancel"],
      tone: "danger",
    });
    expect(confirmOpts().body, "what may not come back is said").toMatch(/earlier month may not come back/);
    expect(confirmOpts().body, "the amount and the size are in the sentence").toContain("4 credits for up to 64 players");
    expect((lastPatch().config as Record<string, unknown>).onlinePlay, "the switch-off is what was saved").toBeUndefined();
  });

  it("the Fair-play camera's price is part of what was paid: 64 with cameras says 8, and a single credit says 'credit'", async () => {
    const island = mount(ON, paid(64, true));
    pickOnlinePlay(island, "off");
    save(island);
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(packagePrice(64, true)).not.toBe(packagePrice(64, false));
    expect(confirmOpts().body).toContain(`${packagePrice(64, true)} credits for up to 64 players`);
    confirmMock.mockClear();
    const one = mount(ON, paid(16));
    pickOnlinePlay(one, "off");
    save(one);
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(packagePrice(16, false), "premise").toBe(1);
    expect(confirmOpts().body).toContain("1 credit for up to 16 players");
  });

  it("a no sends nothing and says nothing; asking again later asks again (the sequence)", async () => {
    confirmMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    const island = mount(ON, paid(32));
    pickOnlinePlay(island, "off");
    save(island);
    await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(apiV1Mock, "refused: no request").not.toHaveBeenCalled();
    expect(byTestId(island, "division-rules-feedback")).toBeUndefined();
    save(island);
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalledTimes(1));
    expect(confirmMock, "the second Save asked again").toHaveBeenCalledTimes(2);
  });

  it("asks nothing when nothing is refunded: an unpaid package, a frozen one, a division that stays online, and one that was never online", async () => {
    const cases: [string, Record<string, unknown>, OnlinePackageStrip, "off" | "lichess"][] = [
      ["unpaid", ON, unpaid(), "off"],
      ["frozen: the server leaves it alone", ON, paid(32, false, true), "off"],
      ["paid but staying online (the ordinary rules save)", ON, paid(32), "lichess"],
      ["paid row of a division that was not online", OFF, paid(32), "off"],
    ];
    for (const [label, config, pkg, play] of cases) {
      apiV1Mock.mockClear();
      const island = mount(config, pkg);
      pickOnlinePlay(island, play);
      save(island);
      await vi.waitFor(() => expect(apiV1Mock, label).toHaveBeenCalledTimes(1));
    }
    expect(confirmMock, "none of them asked").not.toHaveBeenCalled();
    expect(cases.length).toBe(4);
  });

  it("with no dialog mounted a paid switch-off is NOT saved: the organiser is told, in the product's words, and no request leaves", async () => {
    confirmState.mounted = false;
    const island = mount(ON, paid(32));
    pickOnlinePlay(island, "off");
    save(island);
    await vi.waitFor(() => expect(byTestId(island, "division-settings-error")).toBeDefined());
    expect(textOf(byTestId(island, "division-settings-error")!)).toBe(UI["divset.failed"]);
    expect(apiV1Mock).not.toHaveBeenCalled();
    // ... and an unpaid switch-off needs no dialog, so it still saves.
    const unpaidIsland = mount(ON, unpaid());
    pickOnlinePlay(unpaidIsland, "off");
    save(unpaidIsland);
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalledTimes(1));
  });

  it("the save's refund is one line: switched off, what came back, what did not (singular and plural)", async () => {
    apiV1Mock.mockResolvedValue({ id: "d1", online: { capacityLoweredTo: null, refunded: { pack: 3, monthly: 1, forfeited: 2 } } });
    const island = mount(ON, paid(64));
    pickOnlinePlay(island, "off");
    save(island);
    await vi.waitFor(() => expect(byTestId(island, "division-online-refunded")).toBeDefined());
    expect(textOf(byTestId(island, "division-online-refunded")!)).toBe(
      "Online Chess switched off. 4 credits returned to your balance. 2 included credits from an earlier month were not returned.",
    );
    expect(byTestId(island, "division-capacity-lowered"), "no capacity line beside it").toBeUndefined();

    apiV1Mock.mockResolvedValue({ online: { refunded: { pack: 1, monthly: 0, forfeited: 1 } } });
    const one = mount(ON, paid(16));
    pickOnlinePlay(one, "off");
    save(one);
    await vi.waitFor(() => expect(byTestId(one, "division-online-refunded")).toBeDefined());
    expect(textOf(byTestId(one, "division-online-refunded")!)).toBe(
      "Online Chess switched off. 1 credit returned to your balance. 1 included credit from an earlier month was not returned.",
    );
  });

  it("nothing forfeited says nothing about it; nothing returned says nothing about that; nothing moved (unpaid, frozen) draws no line", async () => {
    apiV1Mock.mockResolvedValue({ online: { refunded: { pack: 0, monthly: 2, forfeited: 0 } } });
    const island = mount(ON, paid(32));
    pickOnlinePlay(island, "off");
    save(island);
    await vi.waitFor(() => expect(byTestId(island, "division-online-refunded")).toBeDefined());
    expect(textOf(byTestId(island, "division-online-refunded")!)).toBe("Online Chess switched off. 2 credits returned to your balance.");

    apiV1Mock.mockResolvedValue({ online: { refunded: { pack: 0, monthly: 0, forfeited: 3 } } });
    const lost = mount(ON, paid(32));
    pickOnlinePlay(lost, "off");
    save(lost);
    await vi.waitFor(() => expect(byTestId(lost, "division-online-refunded")).toBeDefined());
    expect(textOf(byTestId(lost, "division-online-refunded")!)).toBe("Online Chess switched off. 3 included credits from an earlier month were not returned.");

    for (const refunded of [null, { pack: 0, monthly: 0, forfeited: 0 }]) {
      apiV1Mock.mockClear().mockResolvedValue({ online: { refunded } });
      const quiet = mount(ON, unpaid());
      pickOnlinePlay(quiet, "off");
      save(quiet);
      await vi.waitFor(() => expect(byTestId(quiet, "division-rules-saved")).toBeDefined());
      expect(byTestId(quiet, "division-online-refunded"), JSON.stringify(refunded)).toBeUndefined();
    }
  });

  it("the refund line goes with the next save that refunds nothing (the sequence)", async () => {
    apiV1Mock.mockResolvedValueOnce({ online: { refunded: { pack: 2, monthly: 0, forfeited: 0 } } }).mockResolvedValue({ online: { refunded: null } });
    const island = mount(ON, paid(32));
    pickOnlinePlay(island, "off");
    save(island);
    await vi.waitFor(() => expect(byTestId(island, "division-online-refunded")).toBeDefined());
    save(island);
    await vi.waitFor(() => expect(apiV1Mock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(byTestId(island, "division-online-refunded")).toBeUndefined());
  });
});

describe("a size write that races a payment or a round opening (T11 fix round 1, review M3)", () => {
  const SERVER_WORDING = "server wording - English only";
  const raced = async (code: string, status = 409) => {
    apiV1Mock.mockRejectedValueOnce(new RealApiV1Error(SERVER_WORDING, status, code, {}));
    const island = mount(ON, unpaid());
    (propsOf(saveButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(byTestId(island, "division-settings-error")).toBeDefined());
    return textOf(byTestId(island, "division-settings-error")!);
  };

  it("online_size_paid and online_size_frozen: a one-line sentence of their own, and the page re-reads what is stored", async () => {
    expect(await raced("online_size_paid")).toBe(UI["onlineChess.err.sizePaid"]);
    expect(refreshMock, "re-read after the paid race").toHaveBeenCalledTimes(1);
    expect(await raced("online_size_frozen")).toBe(UI["onlineChess.err.sizeFrozen"]);
    expect(refreshMock, "re-read after the frozen race").toHaveBeenCalledTimes(2);
  });

  it("any other refusal keeps the server's words or its own mapping and does not refresh (the pair)", async () => {
    expect(await raced("SOMETHING_ELSE", 409)).not.toBe(UI["onlineChess.err.sizePaid"]);
    expect(await raced("online_size_unknown", 409)).not.toBe(UI["onlineChess.err.sizeFrozen"]);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
