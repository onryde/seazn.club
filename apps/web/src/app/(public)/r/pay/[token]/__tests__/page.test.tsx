// Player payment page, Task 4 (plan 2026-11-11-player-payment-page) - /r/pay/[token]. renderToStaticMarkup (apps/web vitest is
// `environment: "node"`, no DOM), modelled on the sponsor invoice page's suite.
//
// The VIEW cases build `PayPageDoc` fixtures directly (the document's own rules are tested against the real database in
// registration-pay-page-doc.test.ts; the hashed-token rule governs DB tests). The PAGE cases drive the real page function with the
// usecases stubbed, to prove the flow: throttle first, one opaque 404, reconcile only on a success return, the doc's own language.
//
// What the page must do (brief, Step 1):
//   - one case per PayPageState plus `confirming`: the state's copy is PRESENT (read from en/ui.json) and the Pay form
//     (`form[action$="/pay"][method="post"]`) exists ONLY in `pay`; states rendered = PAY_PAGE_STATES.length + 1;
//   - `offline` shows the instructions and the reference and no form; `confirming` shows its title and no form;
//   - every element that carries the token is `ph-no-capture`;
//   - an `nl` document renders `nl` copy;
//   - `isPayConfirming`: a return whose session_id is not the entry's current pay session is NOT confirming (Review Focus 4).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ctx = vi.hoisted(() => ({
  locale: "en" as "en" | "es" | "fr" | "nl",
  overLimit: false,
  docReads: [] as string[],
  docs: [] as unknown[],
  reconciled: [] as [string, string][],
  reconcileResult: false as boolean | Error,
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => ctx.locale }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
  cookies: async () => ({ get: () => undefined }),
}));
const refresh = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: () => {}, refresh: undefined as unknown as () => void }));
router.refresh = refresh; // one stable router object, as next/navigation's is
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => router,
}));
vi.mock("@/server/usecases/public", async () => {
  const { HttpError } = await import("@/lib/errors");
  return {
    publicRateLimit: async () => {
      if (ctx.overLimit) throw new HttpError(429, "Too many requests");
    },
  };
});
vi.mock("@/server/usecases/registrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/registrations")>();
  return {
    ...actual,
    payPageDocByToken: async (token: string) => {
      ctx.docReads.push(token);
      return ctx.docs.length > 1 ? ctx.docs.shift() : (ctx.docs[0] ?? null);
    },
    reconcileRegistrationByPaySession: async (registrationId: string, sessionId: string) => {
      ctx.reconciled.push([registrationId, sessionId]);
      if (ctx.reconcileResult instanceof Error) throw ctx.reconcileResult;
      return ctx.reconcileResult;
    },
  };
});

import { getDictionary, t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { PAY_NOTICE_PARAM, PAY_RECORDING_NOTICE, isPayConfirming, registrationPayPath } from "@/lib/registration-pay";
import { PAY_PAGE_STATES, type PayPageDoc, type PayPageState } from "@/server/usecases/registrations/pay-page";
import { PayPageView } from "@/components/registrations/pay-page-view";
import { CONFIRM_INTERVAL_MS, CONFIRM_MAX_REFRESHES, PayPageConfirming } from "@/components/registrations/pay-page-confirming";
import { renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import PayPage from "../page";
import PayNotFound from "../not-found";

const en = await getDictionary("en", "ui");
const nl = await getDictionary("nl", "ui");
const TOKEN = "k3Yp9QwErTyUiOpAsDfGhJkLzXcVbNm1k3Yp9QwErT-"; // 43 chars, base64url-shaped
const SESSION = "cs_test_pay_1";

/** What React writes into markup for a text node / attribute. */
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const has = (markup: string, dict: Dict, key: string, vars?: Record<string, string | number>) =>
  markup.includes(html(t(dict, key as never, vars)));

function doc(over: Partial<PayPageDoc> = {}): PayPageDoc {
  return {
    registrationId: "00000000-0000-4000-8000-0000000000a1",
    groupId: "00000000-0000-4000-8000-0000000000b1",
    orgId: "00000000-0000-4000-8000-0000000000c1",
    locale: "en",
    state: "pay",
    competitionName: "Harbourside Autumn Open",
    divisionName: "Mixed Doubles B",
    startsOn: "2026-12-05",
    endsOn: "2026-12-06",
    entrantName: "Okafor / Lindqvist",
    members: ["Ada Okafor", "Nils Lindqvist"],
    currency: "eur",
    lines: [{ label: "Harbourside Autumn Open - Mixed Doubles B", amountCents: 2500 }],
    totalCents: 2500,
    refundedCents: 0,
    deadline: new Date("2026-12-01T18:30:00Z"),
    refCode: "K7Q2M4",
    orgName: "Harbourside Badminton Club",
    paymentInstructions: null,
    paidAt: null,
    paySessionId: null,
    ...over,
  };
}
const payAction = `${registrationPayPath(TOKEN)}/pay`;
const render = (d: PayPageDoc, dict: Dict = en, confirming = false) =>
  renderToStaticMarkup(<PayPageView doc={d} ui={dict} payAction={payAction} confirming={confirming} />);
const hasForm = (markup: string) => /<form[^>]*\baction="[^"]*\/pay"[^>]*>/.test(markup) && /<form[^>]*\bmethod="post"/.test(markup);

const STATE_CASES: Record<PayPageState, { doc: Partial<PayPageDoc>; copy: [string, Record<string, string | number>?][]; form: boolean }> = {
  pay: { doc: {}, copy: [["regPay.pay", { amount: "€25.00" }], ["regPay.payHint"]], form: true },
  offline: {
    doc: { state: "offline", paymentInstructions: "Transfer to NL00BANK0123 quoting K7Q2M4" },
    copy: [["regPay.offline.title"]],
    form: false,
  },
  paid: { doc: { state: "paid" }, copy: [["regPay.state.paid"]], form: false },
  refunded: { doc: { state: "refunded", refundedCents: 1000 }, copy: [["regPay.state.refunded", { amount: "€10.00" }]], form: false },
  deadline_passed: { doc: { state: "deadline_passed" }, copy: [["regPay.state.deadlinePassed"]], form: false },
  waitlisted: { doc: { state: "waitlisted" }, copy: [["regPay.state.waitlisted"]], form: false },
};

describe("every state renders its copy; the Pay form exists only in `pay` (counted)", () => {
  it("one case per PayPageState plus confirming", () => {
    expect(Object.keys(STATE_CASES).sort()).toEqual([...PAY_PAGE_STATES].sort());
    let rendered = 0;
    for (const state of PAY_PAGE_STATES) {
      const c = STATE_CASES[state];
      const markup = render(doc(c.doc));
      for (const [key, vars] of c.copy) expect(has(markup, en, key, vars), `${state}: ${key}`).toBe(true);
      expect(hasForm(markup), `${state}: form`).toBe(c.form);
      // The details every state shows (details-first): who and what the page is about.
      expect(markup, `${state}: competition`).toContain("Harbourside Autumn Open");
      expect(markup, `${state}: entrant`).toContain(html("Okafor / Lindqvist"));
      rendered++;
    }
    const confirming = render(doc({ paySessionId: SESSION }), en, true);
    expect(has(confirming, en, "regPay.confirming.title")).toBe(true);
    expect(hasForm(confirming), "confirming: no form").toBe(false);
    expect(confirming).not.toContain(html(t(en, "regPay.payHint")));
    rendered++;
    expect(rendered).toBe(PAY_PAGE_STATES.length + 1);
  });

  it("the details: dates, players, fee, total, deadline and reference are all there on `pay`", () => {
    const markup = render(doc());
    for (const key of ["regPay.competition", "regPay.division", "regPay.dates", "regPay.entrant", "regPay.members", "regPay.total", "regPay.deadline", "regPay.reference"]) {
      expect(has(markup, en, key), key).toBe(true);
    }
    for (const text of ["Mixed Doubles B", "Ada Okafor", "Nils Lindqvist", "K7Q2M4", "Harbourside Badminton Club", "€25.00"]) expect(markup).toContain(text);
    expect(markup).toContain("Dec 5");
    expect(markup).toContain("Dec 1, 2026");
  });

  it("an individual entry (no roster) shows no players row; a free-text name with markup is escaped", () => {
    const markup = render(doc({ members: [], entrantName: "<b>Zed</b>" }));
    expect(has(markup, en, "regPay.members")).toBe(false);
    expect(markup).not.toContain("<b>Zed</b>");
    expect(markup).toContain("&lt;b&gt;Zed&lt;/b&gt;");
  });

  it("offline: the instructions and the reference are shown, with no form and no Pay", () => {
    const markup = render(doc(STATE_CASES.offline.doc));
    expect(markup).toContain("Transfer to NL00BANK0123 quoting K7Q2M4");
    expect(markup).toContain("K7Q2M4");
    expect(hasForm(markup)).toBe(false);
    expect(markup).not.toContain(html(t(en, "regPay.pay", { amount: "€25.00" })));
  });

  it("paid with a date reads 'Paid on <date>'; paid without a date reads 'Paid'", () => {
    const dated = render(doc({ state: "paid", paidAt: new Date("2026-11-20T09:00:00Z") }));
    expect(has(dated, en, "regPay.state.paidOn", { date: "Nov 20, 2026" })).toBe(true);
    const undated = render(doc({ state: "paid", paidAt: null }));
    expect(has(undated, en, "regPay.state.paid")).toBe(true);
    expect(undated).not.toContain("Nov 20");
  });

  it("an nl document renders nl copy (and lang=nl); the same doc in en does not", () => {
    const d = doc({ locale: "nl" });
    const markup = render(d, nl);
    expect(has(markup, nl, "regPay.heading")).toBe(true);
    expect(has(markup, nl, "regPay.pay", { amount: new Intl.NumberFormat("nl", { style: "currency", currency: "EUR" }).format(25) })).toBe(true);
    expect(markup).toContain('lang="nl"');
    expect(t(nl, "regPay.heading")).not.toBe(t(en, "regPay.heading")); // anti-vacuity: the dictionaries differ
    expect(has(render(d, en), nl, "regPay.heading")).toBe(false);
  });
});

describe("the token is a bearer credential: every element that carries it is ph-no-capture", () => {
  it("the Pay form is the only element carrying the token, and it is blocked from replay", () => {
    let tagsWithToken = 0;
    for (const state of PAY_PAGE_STATES) {
      const markup = render(doc(STATE_CASES[state].doc));
      for (const tag of markup.match(/<[a-z][^>]*>/g) ?? []) {
        if (!tag.includes(TOKEN)) continue;
        tagsWithToken++;
        expect(tag, `${state}: ${tag}`).toMatch(/class="[^"]*\bph-no-capture\b/);
      }
      // Nothing outside an opening tag paints it either (a text child).
      expect(markup.replace(/<[a-z][^>]*>/g, "")).not.toContain(TOKEN);
    }
    expect(tagsWithToken, "the Pay form (the only painter) was found, once").toBe(1);
  });
});

describe("isPayConfirming (Review Focus 4)", () => {
  const pay = doc({ paySessionId: SESSION });
  it.each([
    ["the return's session_id is this entry's current pay session", pay, { checkout: "success", session_id: SESSION }, true],
    ["session_id is NOT the entry's current pay session (an old tab, a forged query)", pay, { checkout: "success", session_id: "cs_test_other" }, false],
    ["checkout=success with no session_id", pay, { checkout: "success" }, false],
    ["the entry has no pay session at all and a session_id arrives", doc({ paySessionId: null }), { checkout: "success", session_id: SESSION }, false],
    ["an empty session_id never matches an empty pointer", doc({ paySessionId: null }), { checkout: "success", session_id: "" }, false],
    ["checkout=cancel", pay, { checkout: "cancel", session_id: SESSION }, false],
    ["the recording notice", pay, { notice: PAY_RECORDING_NOTICE }, true],
    ["any other notice", pay, { notice: "other" }, false],
    ["no query at all", pay, {}, false],
    ["a matching return on a paid entry", doc({ state: "paid", paySessionId: SESSION }), { checkout: "success", session_id: SESSION }, false],
    ["the recording notice on a paid entry", doc({ state: "paid" }), { notice: PAY_RECORDING_NOTICE }, false],
    ["the recording notice on an offline entry", doc({ state: "offline" }), { notice: PAY_RECORDING_NOTICE }, false],
  ] as const)("%s → %s", (_name, d, q, want) => {
    expect(isPayConfirming(d, q)).toBe(want);
  });
  it("the notice param is the one the Pay route sends", () => {
    expect(PAY_NOTICE_PARAM).toBe("notice");
  });
});

describe("the confirming island: refresh every 4 s, at most 15 times, then a 'taking longer' line", () => {
  beforeEach(() => {
    refresh.mockReset();
    vi.useFakeTimers();
  });
  it("the constants are the brief's", () => {
    expect([CONFIRM_INTERVAL_MS, CONFIRM_MAX_REFRESHES]).toEqual([4000, 15]);
  });
  it("refreshes on every tick up to the cap, shows the slow line only after it, and refreshes no more", () => {
    const island = renderIsland(PayPageConfirming, { slowText: "SLOW-LINE-MARK" });
    expect(textOf(island.tree()[0]!)).not.toContain("SLOW-LINE-MARK");
    for (let i = 1; i <= CONFIRM_MAX_REFRESHES; i++) {
      vi.advanceTimersByTime(CONFIRM_INTERVAL_MS);
      expect(refresh, `after tick ${i}`).toHaveBeenCalledTimes(i);
    }
    expect(island.tree().map((el) => textOf(el)).join(" ")).toContain("SLOW-LINE-MARK");
    vi.advanceTimersByTime(CONFIRM_INTERVAL_MS * 5);
    expect(refresh, "no refresh past the cap").toHaveBeenCalledTimes(CONFIRM_MAX_REFRESHES);
    vi.useRealTimers();
  });
});

describe("the page function", () => {
  const params = Promise.resolve({ token: TOKEN });
  const run = async (query: Record<string, string | string[] | undefined> = {}) =>
    renderToStaticMarkup(await PayPage({ params, searchParams: Promise.resolve(query) }));
  beforeEach(() => {
    ctx.locale = "en";
    ctx.overLimit = false;
    ctx.docReads = [];
    ctx.docs = [];
    ctx.reconciled = [];
    ctx.reconcileResult = false;
    refresh.mockReset();
  });

  it("unknown / malformed / withdrawn token (the doc is null) → notFound(): the one opaque 404", async () => {
    ctx.docs = [null];
    await expect(run()).rejects.toThrow("NOT_FOUND");
    expect(ctx.docReads).toEqual([TOKEN]);
    expect(ctx.reconciled).toEqual([]);
  });

  it("throttled → its own screen in the reader's language, and no document is read", async () => {
    ctx.overLimit = true;
    ctx.locale = "es";
    ctx.docs = [doc()];
    const markup = await run();
    const es = await getDictionary("es", "ui");
    expect(has(markup, es, "regPay.throttled.title")).toBe(true);
    expect(ctx.docReads).toEqual([]);
    expect(hasForm(markup)).toBe(false);
  });

  it("the page renders in the DOCUMENT's language, not the reader's", async () => {
    ctx.locale = "en";
    ctx.docs = [doc({ locale: "nl" })];
    const markup = await run();
    expect(has(markup, nl, "regPay.heading")).toBe(true);
    expect(has(markup, en, "regPay.heading")).toBe(false);
  });

  it("a success return with this entry's session: reconciles once, re-reads, and shows what the re-read says (paid)", async () => {
    ctx.docs = [doc({ paySessionId: SESSION }), doc({ state: "paid", paySessionId: SESSION })];
    ctx.reconcileResult = true;
    const markup = await run({ checkout: "success", session_id: SESSION });
    expect(ctx.reconciled).toEqual([["00000000-0000-4000-8000-0000000000a1", SESSION]]);
    expect(ctx.docReads).toHaveLength(2);
    expect(has(markup, en, "regPay.state.paid")).toBe(true);
    expect(has(markup, en, "regPay.confirming.title")).toBe(false);
  });

  it("a success return the webhook has not landed for: the confirming screen, no Pay form", async () => {
    ctx.docs = [doc({ paySessionId: SESSION })];
    ctx.reconcileResult = false;
    const markup = await run({ checkout: "success", session_id: SESSION });
    expect(has(markup, en, "regPay.confirming.title")).toBe(true);
    expect(hasForm(markup)).toBe(false);
    expect(ctx.docReads).toHaveLength(1); // nothing changed, so no second read
  });

  it("Review Focus 4: a session_id that is not the entry's pay session shows the normal page - no confirming, the Pay form still there", async () => {
    ctx.docs = [doc({ paySessionId: SESSION })];
    const markup = await run({ checkout: "success", session_id: "cs_test_forged" });
    expect(has(markup, en, "regPay.confirming.title")).toBe(false);
    expect(hasForm(markup)).toBe(true);
  });

  it("no reconcile without checkout=success and a session_id (a cancel return, a bare visit, an array value)", async () => {
    let checked = 0;
    for (const q of [{}, { checkout: "cancel", session_id: SESSION }, { checkout: "success" }, { checkout: "success", session_id: [SESSION, "x"] }]) {
      ctx.docs = [doc({ paySessionId: SESSION })];
      await run(q);
      checked++;
    }
    expect(ctx.reconciled).toEqual([]);
    expect(checked).toBe(4);
  });

  it("a reconcile that throws does not take the page down", async () => {
    ctx.docs = [doc({ paySessionId: SESSION })];
    ctx.reconcileResult = new Error("stripe down");
    const markup = await run({ checkout: "success", session_id: SESSION });
    expect(has(markup, en, "regPay.confirming.title")).toBe(true);
  });

  it("?notice=recording on a pay entry shows the confirming screen", async () => {
    ctx.docs = [doc()];
    const markup = await run({ [PAY_NOTICE_PARAM]: PAY_RECORDING_NOTICE });
    expect(has(markup, en, "regPay.confirming.title")).toBe(true);
    expect(hasForm(markup)).toBe(false);
  });

  it("the 404 page is the one answer, from the reader's dictionary, with no token and no props", async () => {
    ctx.locale = "fr";
    const fr = await getDictionary("fr", "ui");
    const markup = renderToStaticMarkup(await PayNotFound());
    expect(has(markup, fr, "regPay.notFound.title")).toBe(true);
    expect(has(markup, fr, "regPay.notFound.body")).toBe(true);
  });
});

describe("the copy is in the dictionaries the page reads", () => {
  it("every regPay key the brief names exists in all four locales, non-empty (counted)", () => {
    const keys = JSON.parse(readFileSync(resolve(__dirname, "../../../../../../dictionaries/en/ui.json"), "utf8")) as Record<string, string>;
    const regPay = Object.keys(keys).filter((k) => k.startsWith("regPay."));
    expect(regPay.length).toBe(30);
    let checked = 0;
    for (const loc of ["en", "es", "fr", "nl"] as const) {
      const d = JSON.parse(readFileSync(resolve(__dirname, `../../../../../../dictionaries/${loc}/ui.json`), "utf8")) as Record<string, string>;
      for (const k of regPay) {
        expect(typeof d[k], `${loc}: ${k}`).toBe("string");
        expect(d[k]!.length, `${loc}: ${k}`).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe(regPay.length * 4);
  });
});
