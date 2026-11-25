// The Streaming page's Seazn Hosted card (Phase 4 Task 33b, mock "Option B", owner-approved 2026-11-23) and its org switch (T33,
// `PUT /api/v1/orgs/{id}/seazn-hosted`).
//
// `apps/web` vitest is `environment: "node"` — NO DOM. Two layers, each where it can be proven:
//   * the card as MARKUP (`renderToStaticMarkup` in the page's DictProvider): what an editor and a viewer each see, on and off, in
//     every locale;
//   * the switch DRIVEN (`renderIsland`, the repo's hook harness) with only the transport doubled: the PUT it sends, the state it
//     shows while the PUT is in flight, the rollback on a refusal, the in-flight guard, and the refusal's sentence. Each refusal is
//     the server's OWN error through the real v1 envelope (`v1()`) and the real client transport (`apiV1`), as the page receives it.
// What none of this can see — layout, real tap area, the real route, the match's picker following the switch — is the walkthrough
// `e2e/walkthrough/streaming-destinations.spec.ts` (case 12, the e2e-seazn job).
//
// Sport-agnostic: the switch is org-wide and reads no sport.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { ApiV1Error } from "@/lib/client-v1";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import { messages, type MessageKey } from "@/lib/messages";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { v1 } from "@/server/api-v1/http";
import { SeaznDestinationCard } from "../seazn-destination-card";

// ─── doubles: the transport only ───────────────────────────────────────────────────────────────────────────────────────
const transport = vi.hoisted(() => ({ impl: null as null | ((url: string, opts?: { method?: string; json?: unknown }) => Promise<unknown>) }));
const calls: { url: string; method: string; json: unknown }[] = [];
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, opts?: { method?: string; json?: unknown }) =>
      transport.impl ? transport.impl(url, opts) : actual.apiV1(url, opts as RequestInit & { json?: unknown }),
  };
});

const ORG = "o-1";
const PUT_PATH = `/api/v1/orgs/${ORG}/seazn-hosted`;

/** The answer the route gives a PUT that saved (its body is the switch's new value). */
const answer = (offered: boolean) => ({ offered });
/** A PUT the test resolves or rejects by hand, so the in-flight render can be read. */
function deferred(): { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void } {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  calls.length = 0;
  transport.impl = async (url, opts) => {
    calls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
    return answer((opts?.json as { offered: boolean }).offered);
  };
});
afterEach(() => vi.restoreAllMocks());

// ─── copy, from the dictionaries themselves ───────────────────────────────────────────────────────────────────────────────
const m = (k: MessageKey, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), messages[k] as string);
// The owner's brand (2026-11-23), a literal here so the test does not read it from the code under test. T33c review m3: it has ONE
// authority, `STREAM_KIND_BRAND.seazn`; no dictionary carries it (the 4 locales test below pins the key's absence).
const NAME = "Seazn Hosted";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const LOCALES = ["en", "es", "fr", "nl"] as const;
const dictOf = (locale: (typeof LOCALES)[number]): Dict =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", locale, "ui.json"), "utf8")) as Dict;
/** The state word's opening tag alone (its attributes, nothing after it); throws when the word is missing, so a probe on it is never vacuous. */
const stateTag = (h: string): string => {
  const tag = /<span[^>]*data-testid="seazn-card-state"[^>]*>/.exec(h)?.[0];
  if (tag === undefined) throw new Error("the state word is not on the card");
  return tag;
};

type Props = Parameters<typeof SeaznDestinationCard>[0];
const props = (over: Partial<Props> = {}): Props => ({ orgId: ORG, offered: true, canEdit: true, ...over });
function cardHtml(over: Partial<Props> = {}, dict: Dict = messages as unknown as Dict, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <SeaznDestinationCard {...props(over)} />
    </DictProvider>,
  );
}

// ─── the island's tree ────────────────────────────────────────────────────────────────────────────────────────────────────
const byTestId = (tree: ReactElement[], id: string): ReactElement | undefined => tree.find((el) => propsOf(el)["data-testid"] === id);
const sw = (tree: ReactElement[]): ReactElement => {
  const el = byTestId(tree, "seazn-card-switch");
  if (!el) throw new Error("no switch in the tree — every probe on it would pass vacuously");
  return el;
};
const checked = (tree: ReactElement[]) => propsOf(sw(tree))["aria-checked"];
const stateOf = (tree: ReactElement[]) => propsOf(byTestId(tree, "seazn-card")!)["data-state"];
const errorText = (tree: ReactElement[]): string | null => {
  const el = byTestId(tree, "seazn-card-error");
  return el ? textOf(el).trim() : null;
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
/** A tap, the browser's way: the handler from THIS render, then its awaited PUT and the state it sets. */
async function tap(island: { tree: () => ReactElement[] }): Promise<void> {
  (propsOf(sw(island.tree())).onClick as () => void)();
  await settle();
}

/** A refusal exactly as the page receives it: the server's own error, through the real v1 envelope and the real `apiV1`. */
async function wire(err: unknown): Promise<ApiV1Error> {
  const res = await v1(async () => { throw err; });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(res);
  const saved = transport.impl;
  transport.impl = null;
  try {
    const { apiV1 } = await import("@/lib/client-v1");
    await apiV1(PUT_PATH, { method: "PUT", json: { offered: false } });
  } catch (caught) {
    expect(caught).toBeInstanceOf(ApiV1Error);
    return caught as ApiV1Error;
  } finally {
    transport.impl = saved;
    fetchSpy.mockRestore();
  }
  throw new Error("apiV1 resolved on an error response");
}

// ═══ markup ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("what an editor sees", () => {
  it("ON: the name, the Recommended tag, the line, three chips, the credit line and a switch that reads on — and no off line", () => {
    const html = cardHtml({ offered: true });
    expect(html).toContain('data-testid="seazn-card"');
    expect(html).toContain('data-state="on"');
    expect(html).toContain(`>${esc(NAME)}<`);
    expect(html).toContain(`>${esc(m("streaming.seazn.recommended"))}<`);
    expect(html).toContain(esc(m("streaming.seazn.why")));
    const chips = [...html.matchAll(/data-testid="seazn-card-chip"[^>]*>([\s\S]*?)<\/li>/g)].map((x) => x[1]!.replace(/<[^>]+>/g, ""));
    expect(chips, "the three chips, in the mock's order").toEqual(
      (["streaming.seazn.chip.noAccount", "streaming.seazn.chip.matchPage", "streaming.seazn.chip.replay"] as const).map((k) => esc(m(k))),
    );
    expect(html).toContain(`data-testid="seazn-card-cost"`);
    expect(html).toContain(esc(m("streaming.seazn.cost")));
    expect(html, "the off line replaces the cost line: absent when on").not.toContain('data-testid="seazn-card-off"');
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(html).toContain(`aria-label="${esc(m("streaming.seazn.switch", { name: NAME }))}"`);
    expect(html).toMatch(/data-testid="seazn-card-state"[^>]*>On</);
    expect(stateTag(html), "beside the switch the word repeats aria-checked, so assistive tech skips it").toContain('aria-hidden="true"');
  });

  it("OFF: a switch that reads off and the off line in place of the credit line — the line says new streams only, and that replays already made stay up (owner Q2)", () => {
    const html = cardHtml({ offered: false });
    expect(html).toContain('data-state="off"');
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(html).toMatch(/data-testid="seazn-card-state"[^>]*>Off</);
    expect(html).not.toContain('data-testid="seazn-card-cost"');
    const off = /data-testid="seazn-card-off"[^>]*>([^<]*)</.exec(html);
    expect(off, "the off line is on the card").not.toBeNull();
    expect(off![1]).toBe(esc(m("streaming.seazn.off", { name: NAME })));
    // The rulings themselves (owner 2026-11-23, Q2), typed here on purpose: the sentence must keep saying both.
    expect(m("streaming.seazn.off", { name: NAME })).toMatch(/replays already made stay up on their match pages/i);
    expect(m("streaming.seazn.off", { name: NAME })).toMatch(/new streams/i);
    // A match that had SAVED Seazn has no destination while it is off (T33, openapi.ts): the line says so (review m9, owner rec).
    expect(off![1]).toMatch(new RegExp(`Matches that picked ${NAME} will ask for another destination\\.$`));
    // Muted, not hidden: the explanation and the chips stay, so an organiser can see what they turned off.
    expect(html).toContain(esc(m("streaming.seazn.why")));
    expect([...html.matchAll(/data-testid="seazn-card-chip"/g)].length).toBe(3);
  });

  it("the switch is a 44 px target (min-h-11 min-w-11) and a real button, not a div", () => {
    const tag = /<button[^>]*role="switch"[^>]*>/.exec(cardHtml());
    expect(tag, "the switch is a <button>").not.toBeNull();
    const cls = /class="([^"]*)"/.exec(tag![0])![1]!.split(" ");
    expect(cls).toContain("min-h-11");
    expect(cls).toContain("min-w-11");
    expect(tag![0]).toContain('type="button"');
  });
});

describe("what a member who cannot edit sees: the card, read-only", () => {
  it("on and off: no switch and no button at all, the state in words, and the off line when off", () => {
    let checkedStates = 0;
    for (const offered of [true, false]) {
      const html = cardHtml({ offered, canEdit: false });
      expect(html, `${offered}: the card is there`).toContain('data-testid="seazn-card"');
      expect(html, `${offered}: no switch`).not.toContain('role="switch"');
      expect(html, `${offered}: nothing to press`).not.toContain("<button");
      expect(html, `${offered}: the state in words`).toMatch(new RegExp(`data-testid="seazn-card-state"[^>]*>${offered ? "On" : "Off"}<`));
      expect(stateTag(html), `${offered}: the word is the viewer's ONLY statement of the state — read by assistive tech`).not.toContain("aria-hidden");
      expect(html.includes('data-testid="seazn-card-off"'), `${offered}: the off line only when off`).toBe(!offered);
      checkedStates++;
    }
    expect(checkedStates).toBe(2);
  });
});

describe("every locale", () => {
  it("renders its own copy for every new key (4 locales), the brand is the same proper noun in all of them, and nothing falls back to a raw key", () => {
    const KEYS = [
      "streaming.seazn.recommended", "streaming.seazn.why", "streaming.seazn.chip.noAccount", "streaming.seazn.chip.matchPage",
      "streaming.seazn.chip.replay", "streaming.seazn.cost", "streaming.seazn.state.on",
    ] as const;
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = dictOf(locale);
      expect(dict["streaming.seazn.name"], `${locale}: m3, the brand is not copy, so no dictionary spells it a second time`).toBeUndefined();
      const on = cardHtml({ offered: true }, dict, locale);
      expect(on, `${locale}: the heading is the brand, the same proper noun in every locale`).toContain(`>${NAME}<`);
      const off = cardHtml({ offered: false }, dict, locale);
      for (const k of KEYS) {
        expect(typeof dict[k] === "string" && dict[k] !== "", `${locale}: ${k}`).toBe(true);
        expect(on, `${locale}: ${k}`).toContain(esc(dict[k] as string));
      }
      expect(((dict["streaming.seazn.off"] as string).match(/\{name\}/g) ?? []).length, `${locale}: the brand in both sentences of the off line`).toBe(2);
      expect(off, `${locale}: the off line`).toContain(esc((dict["streaming.seazn.off"] as string).replaceAll("{name}", "Seazn Hosted")));
      expect(on + off, `${locale}: no raw key leaked`).not.toMatch(/streaming\.seazn\./);
      expect(on + off, `${locale}: no unfilled var`).not.toContain("{name}");
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});

// ═══ driven ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("the switch, driven", () => {
  it("on → off: shows OFF at once (while the PUT is in flight), sends { offered: false } to the org's switch, and stays off once saved", async () => {
    const put = deferred();
    transport.impl = (url, opts) => {
      calls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
      return put.promise;
    };
    const island = renderIsland(SeaznDestinationCard, props({ offered: true }));
    expect(checked(island.tree())).toBe(true);
    await tap(island);
    expect(calls).toEqual([{ url: PUT_PATH, method: "PUT", json: { offered: false } }]);
    expect(checked(island.tree()), "optimistic: off before the server answers").toBe(false);
    expect(stateOf(island.tree())).toBe("off");
    expect(propsOf(sw(island.tree()))["aria-busy"], "in flight").toBe(true);
    put.resolve(answer(false));
    await settle();
    expect(checked(island.tree())).toBe(false);
    expect(propsOf(sw(island.tree()))["aria-busy"]).toBe(false);
    expect(byTestId(island.tree(), "seazn-card-off"), "the off line is up").toBeTruthy();
    expect(errorText(island.tree())).toBeNull();
  });

  it("off → on: sends { offered: true } and the credit line comes back", async () => {
    const island = renderIsland(SeaznDestinationCard, props({ offered: false }));
    await tap(island);
    expect(calls).toEqual([{ url: PUT_PATH, method: "PUT", json: { offered: true } }]);
    expect(checked(island.tree())).toBe(true);
    expect(byTestId(island.tree(), "seazn-card-cost")).toBeTruthy();
    expect(byTestId(island.tree(), "seazn-card-off")).toBeUndefined();
  });

  it("a refused PUT (a viewer's stale tab, 403) rolls the switch back and shows the refusal in the card, as an alert", async () => {
    const refusal = await wire(new HttpError(403, "Insufficient permissions"));
    transport.impl = async (url, opts) => {
      calls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
      throw refusal;
    };
    const island = renderIsland(SeaznDestinationCard, props({ offered: true }));
    await tap(island);
    expect(calls.length, "premise: the PUT was sent").toBe(1);
    expect(checked(island.tree()), "rolled back to on").toBe(true);
    expect(stateOf(island.tree())).toBe("on");
    expect(errorText(island.tree())).toBe(m("streamDest.error.forbidden"));
    expect(propsOf(byTestId(island.tree(), "seazn-card-error")!).role).toBe("alert");
    expect(propsOf(sw(island.tree())).disabled, "usable again").toBe(false);
  });

  it("a second tap while the PUT is in flight sends nothing (the same render's handler, twice); once it lands, a tap sends again", async () => {
    const put = deferred();
    transport.impl = (url, opts) => {
      calls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
      return calls.length === 1 ? put.promise : Promise.resolve(answer((opts?.json as { offered: boolean }).offered));
    };
    const island = renderIsland(SeaznDestinationCard, props({ offered: true }));
    const onClick = propsOf(sw(island.tree())).onClick as () => void;
    onClick();
    onClick(); // a double tap: both from the SAME render, before any state could disable the button
    await settle();
    (propsOf(sw(island.tree())).onClick as () => void)(); // and a third, from the in-flight render
    await settle();
    expect(calls.length, "one PUT for three taps in flight").toBe(1);
    expect(propsOf(sw(island.tree())).disabled, "disabled while in flight").toBe(true);
    put.resolve(answer(false));
    await settle();
    expect(checked(island.tree())).toBe(false);
    await tap(island);
    expect(calls.map((c) => c.json), "the guard let go: the next tap sends").toEqual([{ offered: false }, { offered: true }]);
    expect(checked(island.tree())).toBe(true);
  });

  it("SEQUENCE: off is saved, then turning it back on is refused — it rolls back to OFF (the last saved state), not to the page's stale 'on'", async () => {
    let n = 0;
    const refusal = await wire(new PaymentRequiredError("members.max"));
    transport.impl = async (url, opts) => {
      calls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
      n++;
      if (n === 2) throw refusal;
      return answer((opts?.json as { offered: boolean }).offered);
    };
    const island = renderIsland(SeaznDestinationCard, props({ offered: true }));
    await tap(island); // off, saved
    expect(checked(island.tree())).toBe(false);
    await tap(island); // on, refused
    expect(calls.map((c) => c.json)).toEqual([{ offered: false }, { offered: true }]);
    expect(checked(island.tree()), "back to the saved OFF").toBe(false);
    expect(byTestId(island.tree(), "seazn-card-off")).toBeTruthy();
    expect(errorText(island.tree())).toBe(m("streamDest.error.seatFrozen"));
    // The next tap clears the refusal before it sends.
    transport.impl = async (url, opts) => {
      calls.push({ url, method: opts?.method ?? "GET", json: opts?.json });
      return answer(true);
    };
    await tap(island);
    expect(checked(island.tree())).toBe(true);
    expect(errorText(island.tree()), "a new attempt clears the old refusal").toBeNull();
  });

  it("follows the server once it has answered: the page's next read wins over the organiser's old choice", async () => {
    const p = props({ offered: true });
    const island = renderIsland(SeaznDestinationCard, p);
    await tap(island); // off, saved
    island.rerender({ ...p, offered: false }); // the page read it back: agrees
    expect(checked(island.tree())).toBe(false);
    island.rerender({ ...p, offered: true }); // another admin turned it on in another tab
    expect(checked(island.tree()), "the server's value, not the old choice").toBe(true);
  });
});

describe("a refusal reads as the page's own sentence — never the server's English", () => {
  it("each refusal the route can give, and the network failing (6 checked)", async () => {
    const cases: [string, () => Promise<unknown>, string][] = [
      ["403 FORBIDDEN (a viewer)", () => wire(new HttpError(403, "Insufficient permissions")), m("streamDest.error.forbidden")],
      ["401 UNAUTHENTICATED (signed out in another tab)", () => wire(new AuthError("Not signed in")), m("streamDest.error.signedOut")],
      ["402 a frozen admin seat (members.max)", () => wire(new PaymentRequiredError("members.max")), m("streamDest.error.seatFrozen")],
      ["402 any other feature", () => wire(new PaymentRequiredError("formats.double_elim")), m("streamDest.error.generic")],
      ["404 (no Seazn row)", () => wire(new HttpError(404, "the Seazn destination was not found")), m("streamDest.error.generic")],
      ["the network (fetch threw)", async () => new TypeError("Failed to fetch"), m("streamDest.error.generic")],
    ];
    let checkedCases = 0;
    for (const [what, make, sentence] of cases) {
      const err = await make();
      transport.impl = async () => { throw err; };
      const island = renderIsland(SeaznDestinationCard, props({ offered: true }));
      await tap(island);
      expect(errorText(island.tree()), what).toBe(sentence);
      expect(errorText(island.tree()), `${what}: not the server's English`).not.toMatch(/Insufficient|Not signed in|Plan upgrade|not found/);
      expect(checked(island.tree()), `${what}: rolled back`).toBe(true);
      checkedCases++;
    }
    expect(checkedCases).toBe(cases.length);
    expect(checkedCases, "the title's count").toBe(6);
  });
});

describe("read-only, driven", () => {
  it("a viewer's card has nothing to tap — no element in it carries an onClick", () => {
    const island = renderIsland(SeaznDestinationCard, props({ canEdit: false }));
    const tree = island.tree();
    expect(byTestId(tree, "seazn-card"), "premise: the card rendered").toBeTruthy();
    const handlers = tree.filter((el) => typeof propsOf(el).onClick === "function");
    expect(handlers).toEqual([]);
    expect(calls).toEqual([]);
  });
});
