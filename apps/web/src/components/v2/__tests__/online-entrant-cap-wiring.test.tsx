// The online chess entrant cap (owner ruling 2026-11-21) as the ORGANISER reads it: the server's two refusals - ONLINE_DIVISION_FULL (add,
// promote, approve, a capacity above the cap) and ONLINE_PLAY_TOO_MANY_ENTRANTS (turning online play on) - are said in the organiser's
// language off the code, with the numbers the server read, and never as an upgrade: a CAPACITY limit, so no UpgradeGate, no "raise your
// plan". The refusals under test are the REAL ones (`onlineDivisionFullError`, `assertOnlinePlayFits`), fed through the mounted screens
// by the handlers a click would call (hook harness, no jsdom here). The pure mapping is the same module every screen shares
// (online-entrant-cap-refusal.ts); a green mapping suite is blind to a screen that never calls it, so each screen is mounted.
// The config panel's capacity field has its own case in components/__tests__/registration-hub-config-panel.test.tsx.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import { LOCALES, type Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

type Refusal = { message: string; status: number; code: string; extra: Record<string, unknown> };
const net = vi.hoisted(() => ({
  /** What the next call to a route (its last path segment, or the full division patch) answers: an error to throw. */
  refuse: new Map<string, { message: string; status: number; code: string; extra: Record<string, unknown> }>(),
  calls: [] as string[],
  personsLoaded: 0,
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async (url: string, options?: { method?: string }) => {
      net.calls.push(`${options?.method ?? "GET"} ${url}`);
      if (url.startsWith("/api/v1/persons?")) {
        net.personsLoaded++;
        return { items: [{ id: "p-ada", full_name: "Ada Okonkwo", dob: null, gender: null }], nextCursor: null };
      }
      const key = url.endsWith("/entrants") ? "entrants" : url === "/api/v1/divisions/d1" ? "division" : url.split("/").pop()!;
      const failure = net.refuse.get(key);
      if (failure && (options?.method === "POST" || options?.method === "PATCH")) {
        net.refuse.delete(key);
        throw new actual.ApiV1Error(failure.message, failure.status, failure.code, failure.extra);
      }
      if (url === "/api/v1/clubs" || url === "/api/v1/teams" || url.includes("/roster")) return [];
      return {};
    }),
  };
});

const EN_UI: Dict = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8")) as Dict;
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
    usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(EN_UI, key, count, "en", vars),
    useLocale: () => "en",
  };
});

import { UpgradeGate } from "@/components/upgrade-gate";
import { RegistrationHubRegistrantActions } from "@/components/registration-hub-registrant-actions";
import { EntrantsPanel, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import { DivisionRulesStrip, expandRules, stripPropsOf } from "./_rules-strip";
import { ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION, ONLINE_DIVISION_FULL, ONLINE_PLAY_TOO_MANY_ENTRANTS } from "@/lib/online-chess";
import { assertOnlinePlayFits, onlineDivisionFullError, onlineSizeFullError } from "@/server/external-play/online-entrant-cap";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { v1 } from "@/server/api-v1/http";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

beforeEach(() => {
  net.refuse.clear();
  net.calls.length = 0;
  net.personsLoaded = 0;
});

const MAX = ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION;
const FULL_WORDS = () => tRuntime(EN_UI, "onlineChess.entrantCap", { limit: MAX });
/** The server's refusal, with only its WORDING replaced: the English dictionary sentence is deliberately the server's own, so a screen that
 *  showed `err.message` would pass a text comparison. A message that cannot be mistaken for the dictionary's proves the words come from
 *  the code. The code, status and numbers are the real ones. */
const SERVER_WORDING = "server wording - English only, not for the screen";
const asRefusal = (e: { message: string; status: number; code?: string; extra?: unknown }): Refusal => ({
  message: SERVER_WORDING,
  status: e.status,
  code: String(e.code),
  extra: (e.extra ?? {}) as Record<string, unknown>,
});

/** The REAL refusal of the entrant door, as the API v1 envelope delivers it to the client. */
const FULL = (): Refusal => asRefusal(onlineDivisionFullError());
/** The REAL refusal of a door that would put the division past the SIZE its organiser bought (Online Chess credits, spec §7.6): 16 here. */
const SIZE_FULL = (): Refusal => asRefusal(onlineSizeFullError(16));
const SIZE_WORDS = () => tRuntime(EN_UI, "onlineChess.sizeFull", { size: 16, nextSize: 32 });
/** The REAL refusal of the online switch for a division holding `n` entrants. */
function tooMany(n: number): Refusal {
  try {
    assertOnlinePlayFits(n, null); // an unlimited plan: the switch's own refusal, never the plan's
  } catch (e) {
    return asRefusal(e as { message: string; status: number; code?: string; extra?: unknown });
  }
  throw new Error("anti-vacuity: the switch must refuse " + n);
}

// ─── the entrants panel: adding an entrant ───────────────────────────────────────────────────────────────────

const NO_ELIGIBILITY: EntrantsPanelEligibility = { category: null, age_min: null, age_max: null, eligibility_note: null };
const MODEL = { kinds: ["individual"], defaultKind: "individual", squadNumbers: false, captain: false, maxTeamMembers: null } as unknown as EffectiveEntrantModel;
const panelProps = () => ({
  divisionId: "div-1",
  entrants: [],
  canEdit: true,
  positionGroups: [],
  roles: [],
  eligibility: NO_ELIGIBILITY,
  entrantModel: MODEL,
  viewerPlan: "pro" as const,
  divisionStatus: "setup",
});
type Tree = ReturnType<ReturnType<typeof renderIsland>["tree"]>;
function findOnImport(tree: Tree) {
  const formEl = tree.find((e) => propsOf(e).importControls !== undefined);
  if (!formEl) throw new Error("AddEntrantForm element (importControls prop) not found in tree");
  return propsOf(propsOf(formEl).importControls as ReactElement).onImport as (rows: { name: string }[]) => Promise<unknown>;
}
const banner = (tree: Tree) => tree.find((e) => e.type === "p" && String(propsOf(e).className ?? "").includes("bg-red-50"));

async function addRefusedWith(failure: Refusal) {
  const island = renderIsland(EntrantsPanel, panelProps());
  await vi.waitFor(() => expect(net.personsLoaded, "premise: the persons directory was read").toBeGreaterThan(0));
  await new Promise((r) => setTimeout(r, 0));
  net.refuse.set("entrants", failure);
  await findOnImport(island.tree())([{ name: "Ada Okonkwo" }]);
  expect(net.calls.filter((c) => c === "POST /api/v1/divisions/div-1/entrants"), "premise: the add really went to the server").toHaveLength(1);
  return island;
}

describe("EntrantsPanel: an online chess division that is full says so in the organiser's language, and never offers an upgrade", () => {
  it("ONLINE_DIVISION_FULL: the dictionary's sentence with the limit, not the server's English, and no UpgradeGate", async () => {
    const refusal = FULL();
    const island = await addRefusedWith(refusal);
    const shown = textOf(banner(island.tree())!);
    expect(shown).toBe(FULL_WORDS());
    expect(shown).toContain(String(MAX));
    expect(shown, "a capacity limit: no upsell").not.toMatch(/upgrade|plan|raise|pro\b/i);
    expect(island.tree().some((e) => e.type === UpgradeGate), "no paywall: an upgrade does not lift this").toBe(false);
  });

  it("ONLINE_SIZE_FULL (the size the organiser bought): the dictionary's sentence with the size and the next one up, not the server's English, and no UpgradeGate", async () => {
    const refusal = SIZE_FULL();
    expect(refusal.code, "premise: the real refusal carries the size's own code").toBe(ONLINE_PACKAGE_CODES.sizeFull);
    expect(refusal.extra, "premise: and the numbers the sentence names").toEqual({ size: 16, nextSize: 32 });
    const island = await addRefusedWith(refusal);
    const shown = textOf(banner(island.tree())!);
    expect(shown).toBe(SIZE_WORDS());
    expect(shown).toContain("16");
    expect(shown).toContain("32");
    expect(shown, "no plan upsell: the way out is a bigger size").not.toMatch(/upgrade|plan\b|raise|pro\b/i);
    expect(island.tree().some((e) => e.type === UpgradeGate), "no paywall").toBe(false);
  });

  // Online Chess credits (plan Task 12): the size sentence names the way out - a bigger size - and the panel offers it: a "Change size" link to the
  // Fixtures tab, where the size select and the pay line are. The other full refusal (256, the most any size holds) is not lifted by a size, so it
  // offers none.
  const CHANGE_SIZE = "/o/riverside/c/summer-league/d/chess?tab=fixtures";
  const changeSize = (tree: Tree) => tree.find((e) => propsOf(e)["data-testid"] === "entrants-change-size");
  const addRefusedWithLink = async (failure: Refusal, changeSizeHref: string | null = CHANGE_SIZE) => {
    const island = renderIsland(EntrantsPanel, { ...panelProps(), changeSizeHref });
    await vi.waitFor(() => expect(net.personsLoaded, "premise: the persons directory was read").toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    net.refuse.set("entrants", failure);
    await findOnImport(island.tree())([{ name: "Ada Okonkwo" }]);
    expect(net.calls.filter((c) => c === "POST /api/v1/divisions/div-1/entrants"), "premise: the add really went to the server").toHaveLength(1);
    return island;
  };

  it("ONLINE_SIZE_FULL offers 'Change size', a link to the Fixtures tab, beside the sentence", async () => {
    const island = await addRefusedWithLink(SIZE_FULL());
    expect(textOf(banner(island.tree())!), "premise: the size sentence is up").toBe(SIZE_WORDS());
    const link = changeSize(island.tree());
    expect(link, "the link is offered").toBeDefined();
    expect(propsOf(link!).href).toBe(CHANGE_SIZE);
    expect(textOf(link!).trim()).toBe(tRuntime(EN_UI, "onlineChess.sizeFull.change"));
  });

  it("ONLINE_DIVISION_FULL (256) offers none: no size lifts it", async () => {
    const island = await addRefusedWithLink(FULL());
    expect(textOf(banner(island.tree())!), "premise: the 256 sentence is up").toBe(FULL_WORDS());
    expect(changeSize(island.tree())).toBeUndefined();
  });

  it("no address to send the organiser to (a reader who may not pay, or no package page): the sentence stands alone", async () => {
    const asked = [
      async () => addRefusedWithLink(SIZE_FULL(), null),
      async () => addRefusedWith(SIZE_FULL()), // the prop absent altogether
    ];
    for (const [i, ask] of asked.entries()) {
      net.calls.length = 0;
      const island = await ask();
      expect(textOf(banner(island.tree())!), `premise (${i}): the size sentence is up`).toBe(SIZE_WORDS());
      expect(changeSize(island.tree()), `case ${i}`).toBeUndefined();
    }
  });

  it("a later, different refusal takes the link away; the next successful attempt clears the sentence and the link with it", async () => {
    const island = await addRefusedWithLink(SIZE_FULL());
    expect(changeSize(island.tree()), "premise: the link is up").toBeDefined();
    net.refuse.set("entrants", FULL());
    await findOnImport(island.tree())([{ name: "Ada Okonkwo" }]);
    expect(textOf(banner(island.tree())!), "premise: the 256 sentence replaced it").toBe(FULL_WORDS());
    expect(changeSize(island.tree())).toBeUndefined();
    net.refuse.set("entrants", SIZE_FULL());
    await findOnImport(island.tree())([{ name: "Ada Okonkwo" }]);
    expect(changeSize(island.tree()), "the size refusal brings it back").toBeDefined();
    await findOnImport(island.tree())([{ name: "Ada Okonkwo" }]); // answered: nothing refused this time
    expect(banner(island.tree()), "premise: the sentence is gone").toBeUndefined();
    expect(changeSize(island.tree())).toBeUndefined();
  });

  it("the other direction: the plan's own refusal (402 PAYMENT_REQUIRED) still opens the upgrade gate, and a later full refusal replaces it", async () => {
    const island = await addRefusedWith({
      message: "Upgrade required",
      status: 402,
      code: "PAYMENT_REQUIRED",
      extra: { feature_key: "entrants.per_division.max" },
    });
    expect(island.tree().some((e) => e.type === UpgradeGate), "the plan binds: the gate is offered").toBe(true);
    expect(banner(island.tree()), "no red banner for a paywall").toBeUndefined();
    net.refuse.set("entrants", FULL());
    await findOnImport(island.tree())([{ name: "Ada Okonkwo" }]);
    expect(textOf(banner(island.tree())!)).toBe(FULL_WORDS());
  });
});

// ─── the registrant hub: promote / approve ───────────────────────────────────────────────────────────────────

type ActionProps = Parameters<typeof RegistrationHubRegistrantActions>[0];
const ACTION_PROPS: ActionProps = {
  registrationId: "reg-1",
  status: "pending",
  approval: "manual",
  amountCents: 0,
  divisionFeeCents: 0,
  paymentIntentId: null,
  entryPaymentIntentId: null,
  refundedCents: 0,
  lastRemindedAt: null,
  remindersInWindow: 0,
  approvedAt: null,
  paymentLostToDispute: false,
};
const mountActions = (o: Partial<ActionProps> = {}) => renderIsland(RegistrationHubRegistrantActions, { ...ACTION_PROPS, ...o });
const action = (island: ReturnType<typeof mountActions>, name: string) =>
  island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-action"] === name);
const click = (island: ReturnType<typeof mountActions>, name: string) => (propsOf(action(island, name)!).onClick as () => Promise<void>)();
const feedback = (island: ReturnType<typeof mountActions>) => {
  const el = island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-actions-feedback"] !== undefined);
  return el ? { tone: propsOf(el)["data-tone"], text: textOf(el) } : null;
};

describe("the registrant hub: Promote and Approve of an entry the full online division cannot seat", () => {
  const doors = [
    { action: "approve", route: "approve", props: { status: "pending", approval: "manual" } },
    { action: "promote", route: "promote", props: { status: "waitlisted", approval: "auto" } },
  ] as const;

  it("each door says the cap in the dictionary's words, as an error, and the organiser can try again", async () => {
    let checked = 0;
    for (const door of doors) {
      const refusal = FULL();
      net.refuse.set(door.route, refusal);
      const island = mountActions({ ...door.props });
      await click(island, door.action);
      expect(net.calls.some((c) => c.endsWith(`/${door.route}`)), `premise: ${door.action} was sent`).toBe(true);
      const shown = feedback(island);
      expect(shown?.tone, `${door.action}: an error`).toBe("error");
      expect(shown?.text, `${door.action}: said from the dictionary`).toBe(FULL_WORDS());
      expect(shown?.text, `${door.action}: never the server's English`).not.toBe(refusal.message);
      expect(action(island, door.action), `${door.action}: the button comes back`).toBeTruthy();
      checked++;
    }
    expect(checked, "anti-vacuity: both doors").toBe(doors.length);
  });

  it("the other direction: the plan's own promote refusal still says the plan (PROMOTE_PLAN_LIMIT), not the cap", async () => {
    net.refuse.set("promote", { message: "Your plan allows 64 entrants per division", status: 422, code: "PROMOTE_PLAN_LIMIT", extra: { limit: 64, taken: 64 } });
    const island = mountActions({ status: "waitlisted", approval: "auto" });
    await click(island, "promote");
    expect(feedback(island)?.text).toBe(pluralRuntime(EN_UI, "reg.promote.planLimit", 64, "en", { limit: 64 }));
    expect(feedback(island)?.text).not.toBe(FULL_WORDS());
  });
});

// ─── the Division rules strip: turning online play on ────────────────────────────────────────────────────────

/** The REAL refusal of the online switch where a LOWER plan binds (cap-256 re-review I-F1), through the REAL v1 envelope: the switch throws
 *  the plan's PaymentRequiredError and `v1()` serialises it as the 402 PAYMENT_REQUIRED the client reads (`feature_key`, `reason`). Its
 *  wording is replaced as every refusal's here; the server's own sentence is kept aside to prove the screen never shows it. */
async function planRefusalOf(held: number, planCap: number): Promise<Refusal & { serverMessage: string }> {
  const res = await v1(async () => {
    assertOnlinePlayFits(held, planCap);
    throw new Error(`anti-vacuity: the switch must refuse ${held} held on a plan of ${planCap}`);
  });
  const body = (await res.json()) as { error: { code: string; message: string } & Record<string, unknown> };
  const { code, message, ...extra } = body.error;
  return { message: SERVER_WORDING, status: res.status, code, extra, serverMessage: message };
}

describe("the Division rules strip: Save match rules that turn online play on for a division holding too many entrants", () => {
  const stripOf = (viewerPlan: "community" | "pro") => {
    const division = {
      id: "d1",
      name: "Open",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } },
      logo_url: null,
      logo_storage_path: null,
      camera_policy: null,
      inherited_camera_policy: "off",
    };
    const props = {
      division,
      orgId: "org1",
      variants: [{ key: "classical", name: "Standard" }],
      lockedFields: [],
      canEdit: true,
      divisionPathPrefix: "/o/org/c/comp/d/",
      fixturesHref: "/o/org/c/comp/d/div/fixtures",
      embed: null,
      danger: null,
      autoPosts: false,
      canAutoPost: true,
      showSeeds: true,
      viewerPlan,
      onlineChessOffered: true,
    };
    return renderIsland(DivisionRulesStrip, stripPropsOf(props as unknown as Parameters<typeof stripPropsOf>[0]), expandRules);
  };
  type Strip = ReturnType<typeof stripOf>;
  const clickSave = (island: Strip) => {
    const save = island.tree().find((n) => n.type === "button" && textOf(n).trim() === "Save match rules");
    expect(save, "premise: the save is there").toBeDefined();
    (propsOf(save!).onClick as () => void)();
  };
  const gateOf = (island: Strip) => island.tree().find((e) => e.type === UpgradeGate);
  const errorLine = (island: Strip) => island.tree().find((e) => propsOf(e)["data-testid"] === "division-settings-error");

  it("says the entrants it holds and the limit, in the dictionary's words - never the server's English, never an upgrade", async () => {
    const refusal = tooMany(MAX + 1);
    net.refuse.set("division", refusal);
    const island = stripOf("pro");
    clickSave(island);
    const want = tRuntime(EN_UI, "onlineChess.turnOnTooMany", { entrants: MAX + 1, limit: MAX });
    await vi.waitFor(() => expect(island.text()).toContain(want));
    expect(want).toContain(String(MAX + 1));
    expect(island.text(), "the server's sentence is never shown").not.toContain(refusal.message);
    expect(net.calls.some((c) => c === "PATCH /api/v1/divisions/d1"), "premise: the save went to the server").toBe(true);
    expect(gateOf(island), "a capacity limit: no upgrade gate").toBeUndefined();
  });

  it("the plan's own refusal (a plan limit below the online cap: Community's 64, 65 held - cap-256 re-review I-F1) opens the upgrade gate on the viewer's plan, with no red line and never the server's English; a later cap refusal replaces it", async () => {
    const refusal = await planRefusalOf(65, 64);
    expect(refusal.status, "premise: the real envelope is the plan's 402").toBe(402);
    expect(refusal.code).toBe("PAYMENT_REQUIRED");
    expect(refusal.extra.feature_key, "premise: the feature the gate is opened for").toBe("entrants.per_division.max");
    expect(refusal.serverMessage, "premise: the server's sentence is English with a feature key in it").toContain("entrants.per_division.max");
    net.refuse.set("division", refusal);
    const island = stripOf("community");
    clickSave(island);
    await vi.waitFor(() => expect(gateOf(island), "the gate opens").toBeDefined());
    expect(propsOf(gateOf(island)!).feature).toBe("entrants.per_division.max");
    expect(propsOf(gateOf(island)!).viewerPlan, "the viewer's own plan, from the page").toBe("community");
    expect(errorLine(island), "a paywall is not a red sentence").toBeUndefined();
    expect(island.text(), "neither the replaced wording").not.toContain(SERVER_WORDING);
    expect(island.text(), "nor the server's own sentence").not.toContain(refusal.serverMessage);
    expect(net.calls.filter((c) => c === "PATCH /api/v1/divisions/d1"), "premise: the save went to the server").toHaveLength(1);
    // The sequence: the next save is refused by the switch's own 422 (the plan raised, the cap now binds): its sentence replaces the gate.
    net.refuse.set("division", tooMany(MAX + 1));
    clickSave(island);
    const want = tRuntime(EN_UI, "onlineChess.turnOnTooMany", { entrants: MAX + 1, limit: MAX });
    await vi.waitFor(() => expect(island.text()).toContain(want));
    expect(gateOf(island), "the stale gate is gone").toBeUndefined();
  });
});

// ─── the dictionaries ────────────────────────────────────────────────────────────────────────────────────────

describe("the two sentences exist in all four locales, each in its own words, with their numbers", () => {
  const DICTS = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
  ) as Record<(typeof LOCALES)[number], Dict>;
  const KEYS = {
    [ONLINE_DIVISION_FULL]: ["{limit}"],
    [ONLINE_PLAY_TOO_MANY_ENTRANTS]: ["{limit}", "{entrants}"],
    [ONLINE_PACKAGE_CODES.sizeFull]: ["{size}", "{nextSize}"],
  } as const;

  it("every locale carries every key with its placeholders, and es/fr/nl are not the English text", async () => {
    const { ONLINE_ENTRANT_CAP_KEYS } = await import("../online-entrant-cap-refusal");
    let checked = 0;
    for (const loc of LOCALES) {
      for (const [code, placeholders] of Object.entries(KEYS)) {
        const key = ONLINE_ENTRANT_CAP_KEYS[code as keyof typeof ONLINE_ENTRANT_CAP_KEYS];
        const text = DICTS[loc][key];
        expect(typeof text === "string" && text.trim().length > 0, `${loc} ${key}`).toBe(true);
        for (const p of placeholders) expect(text as string, `${loc} ${key} carries ${p}`).toContain(p);
        if (loc !== "en") expect(text, `${loc} ${key} is translated`).not.toBe(DICTS.en[key]);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 3 keys").toBe(LOCALES.length * 3);
  });

  it("English says capacity and nothing about plans, upgrading or Pro (a capacity limit is not an upsell)", () => {
    for (const key of ["onlineChess.entrantCap", "onlineChess.turnOnTooMany", "onlineChess.sizeFull"]) {
      expect(DICTS.en[key] as string, key).not.toMatch(/upgrade|plan\b|raise|pro\b/i);
    }
  });
});

describe("onlineEntrantCapText: only the two codes, and only with the numbers it names", () => {
  it("any other code is null (the screen keeps its own handling); the full sentence falls back to the shared limit; the turn-on sentence needs the count", async () => {
    const { onlineEntrantCapText } = await import("../online-entrant-cap-refusal");
    const say = (key: string, vars: Record<string, string | number>) => tRuntime(EN_UI, key, vars);
    expect(onlineEntrantCapText({ code: "PROMOTE_PLAN_LIMIT", extra: { limit: 64 } }, say), "another refusal").toBeNull();
    expect(onlineEntrantCapText({}, say), "no code").toBeNull();
    expect(onlineEntrantCapText({ code: ONLINE_DIVISION_FULL }, say), "no extra: the shared constant").toBe(FULL_WORDS());
    expect(onlineEntrantCapText({ code: ONLINE_DIVISION_FULL, extra: { limit: 7 } }, say), "the limit the server read wins").toBe(
      tRuntime(EN_UI, "onlineChess.entrantCap", { limit: 7 }),
    );
    expect(onlineEntrantCapText({ code: ONLINE_PLAY_TOO_MANY_ENTRANTS, extra: { limit: MAX } }, say), "no count to name: the server's own words stay").toBeNull();
    expect(onlineEntrantCapText({ code: ONLINE_PACKAGE_CODES.sizeFull, extra: { size: 16, nextSize: 32 } }, say), "the size's sentence").toBe(SIZE_WORDS());
    expect(onlineEntrantCapText({ code: ONLINE_PACKAGE_CODES.sizeFull, extra: { size: 16, nextSize: null } }, say), "no next size to name: the server's own words stay").toBeNull();
    expect(onlineEntrantCapText({ code: ONLINE_PACKAGE_CODES.sizeFull }, say), "no numbers at all").toBeNull();
    expect(onlineEntrantCapText({ code: ONLINE_PLAY_TOO_MANY_ENTRANTS, extra: { limit: MAX, entrants: 130 } }, say)).toBe(
      tRuntime(EN_UI, "onlineChess.turnOnTooMany", { entrants: 130, limit: MAX }),
    );
  });
});
