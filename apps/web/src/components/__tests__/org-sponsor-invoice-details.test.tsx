// Sponsor deals, Task 21 - the "Sponsor invoices" card on Settings -> Payments (components/org-sponsor-invoice-details.tsx).
//
// What a person meets, pinned from the side they meet it on:
//   1. It OPENS AT what is stored (an address, bank details, or nothing), with the brief's two labels and hint; Save waits for an edit.
//   2. Save sends ONLY what changed, as the org PATCH's single-key arms allow (F30): one PATCH for one field; two PATCHES, address
//      then bank details, strictly in sequence for two. Success is reported only when EVERY PATCH answered 200.
//   3. A refusal reads the DICTIONARY's words (keyed on status), never the server's sentence; a half-saved pair keeps what saved and
//      offers only what did not on the retry.
//   4. A member who cannot edit sees the values and no Save.
//
// vitest is `environment: "node"`: the island runs under components/__tests__/_hook-harness.tsx (the element TREE back; a
// handler is the element's own prop, called); first-paint markup is read with renderToStaticMarkup. What neither can see
// (CSS, widths, tap area) is the e2e's and the capture's.
//
// Every sweep reports how many it checked (TEST-STRATEGY: zero is a failure).
//
// Killers (one at a time, restore from a cp backup):
//   K1  dirty filter  send both fields on every save                      -> "saving sends only the changed field"
//   K2  sequence      Promise.all the two PATCHes                          -> "two changes are two PATCHes in sequence"
//   K3  success       report Saved after the FIRST of two answers          -> "Saved only after both answered 200"
//   K4  order         bank details before the address                      -> "address first, then bank details"
//   K5  null          send "" instead of null for a cleared field          -> "a cleared field is sent as null"
//   K6  trim          send the untrimmed text                              -> "text is trimmed"
//   K7  in-flight     drop the in-flight guard                             -> "a second tap while saving sends nothing"
//   K8  partial       do not record what saved before the failure          -> "a half-saved pair retries only what failed"
//   K9  stop          keep going after a failed first PATCH                -> "a failed first PATCH stops the second"
//   K10 canEdit       render Save and editable fields for a viewer         -> "a member who cannot edit"
// Fix round 1 killers:
//   F1  partial       say the generic failure after a half-saved pair      -> "a half-saved pair says what saved"
//   F2  required      give canEdit a default of true again                 -> "canEdit is required: left out, the card is read-only"
//   F3  a11y          drop role="status" / aria-live from the status line  -> "the status line is a polite live region"
//   F4  clear         keep the old error up when a new save starts         -> "a new save clears the previous error at once"
//   F5  refresh       drop router.refresh() after a successful save        -> "a successful save refreshes the route"
//   F6  refresh-early refresh after EACH PATCH, or after a failed one      -> "the route refreshes once, only when everything saved"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { OrgSponsorInvoiceDetails } from "@/components/org-sponsor-invoice-details";
import { DictProvider } from "@/components/i18n/dict-provider";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

// The island refreshes the route after a save (like org-payment-instructions.tsx): the router is the spy.
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const en = uiEn as unknown as Dict;
const msg = (key: MessageKey) => t(en, key);
const DICTS: Record<Locale, Dict> = { en, es: uiEs as unknown as Dict, fr: uiFr as unknown as Dict, nl: uiNl as unknown as Dict };

const ORG = "org-9";
const URL = `/api/orgs/${ORG}`;
const ADDRESS = "sponsor_invoice_address";
const BANK = "sponsor_invoice_bank_details";

type Call = { url: string; method: string; body: Record<string, unknown> };
const calls: Call[] = [];
/** Answers per call, in order; a function may return a Promise to hold a call open. The default is 200. */
let answer: (call: Call, n: number) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown };
const fetchMock = vi.fn();

beforeEach(() => {
  refresh.mockClear();
  calls.length = 0;
  answer = () => ({ status: 200, body: { ok: true, data: {} } });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: unknown }) => {
    const call: Call = { url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    const a = await answer(call, calls.length);
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  });
  vi.stubGlobal("fetch", fetchMock);
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function mount(over: Partial<Parameters<typeof OrgSponsorInvoiceDetails>[0]> = {}) {
  const props: Parameters<typeof OrgSponsorInvoiceDetails>[0] = {
    orgId: ORG,
    initialAddress: null,
    initialBankDetails: null,
    canEdit: true,
    ...over,
  };
  const island = renderIsland(OrgSponsorInvoiceDetails, props);
  const find = (testId: string): ReactElement => {
    const el = island.tree().find((e) => propsOf(e)["data-testid"] === testId);
    if (!el) throw new Error(`no element with data-testid="${testId}"`);
    return el;
  };
  const has = (testId: string) => island.tree().some((e) => propsOf(e)["data-testid"] === testId);
  const type = (testId: string, value: string) =>
    (propsOf(find(testId)).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  return {
    island,
    find,
    has,
    value: (testId: string) => propsOf(find(testId)).value as string,
    type,
    typeAddress: (v: string) => type("sponsor-invoice-address", v),
    typeBank: (v: string) => type("sponsor-invoice-bank-details", v),
    saveDisabled: () => propsOf(find("sponsor-invoices-save")).disabled === true,
    save: () => (propsOf(find("sponsor-invoices-save")).onClick as () => unknown)(),
    status: () => textOf(find("sponsor-invoices-status")).trim(),
  };
}

describe("it opens at what is stored", () => {
  it("shows the stored address and bank details, and Save waits for an edit", () => {
    const m = mount({ initialAddress: "Riverside CC\n12 Mill Lane", initialBankDetails: "Sort 12-34-56\nAcc 12345678" });
    expect(m.value("sponsor-invoice-address")).toBe("Riverside CC\n12 Mill Lane");
    expect(m.value("sponsor-invoice-bank-details")).toBe("Sort 12-34-56\nAcc 12345678");
    expect(m.saveDisabled()).toBe(true);
  });

  it("the empty case: nothing stored opens both fields empty (never the word null), Save still waits", () => {
    const m = mount();
    expect(m.value("sponsor-invoice-address")).toBe("");
    expect(m.value("sponsor-invoice-bank-details")).toBe("");
    expect(m.saveDisabled()).toBe(true);
    expect(m.status()).toBe("");
  });

  it("carries the brief's labels and hint, read from the dictionary, and the caps the server enforces", () => {
    const html = renderToStaticMarkup(
      <OrgSponsorInvoiceDetails orgId={ORG} initialAddress={null} initialBankDetails={null} canEdit />,
    );
    expect(html).toContain("Sponsor invoices");
    expect(html).toContain("Address on invoices");
    expect(html).toContain("Bank details for offline invoices");
    expect(html).toContain("Printed on every sponsor invoice. Online invoices also carry a pay link.");
    // The textareas stop typing at the route's caps (1000 and 2000), so a long entry is stopped on screen, not refused after Save.
    const address = html.match(/<textarea[^>]*data-testid="sponsor-invoice-address"[^>]*>/)?.[0] ?? "";
    const bank = html.match(/<textarea[^>]*data-testid="sponsor-invoice-bank-details"[^>]*>/)?.[0] ?? "";
    expect(address).toContain('maxLength="1000"');
    expect(bank).toContain('maxLength="2000"');
  });

  it("first paint holds the stored values in the markup (not just in state)", () => {
    const html = renderToStaticMarkup(
      <OrgSponsorInvoiceDetails orgId={ORG} initialAddress="Riverside CC, 12 Mill Lane" initialBankDetails="Sort 12-34-56" canEdit />,
    );
    expect(html).toMatch(/<textarea[^>]*data-testid="sponsor-invoice-address"[^>]*>Riverside CC, 12 Mill Lane<\/textarea>/);
    expect(html).toMatch(/<textarea[^>]*data-testid="sponsor-invoice-bank-details"[^>]*>Sort 12-34-56<\/textarea>/);
  });

  it("every textarea is labelled by its visible label and described by the hint", () => {
    const html = renderToStaticMarkup(
      <OrgSponsorInvoiceDetails orgId={ORG} initialAddress={null} initialBankDetails={null} canEdit />,
    );
    let checked = 0;
    for (const [testId, label] of [
      ["sponsor-invoice-address", "Address on invoices"],
      ["sponsor-invoice-bank-details", "Bank details for offline invoices"],
    ] as const) {
      const area = html.match(new RegExp(`<textarea[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
      const id = area.match(/\sid="([^"]+)"/)?.[1] ?? "";
      expect(id, `${testId} has an id`).not.toBe("");
      expect(html, `${testId}: a <label for=id> carries the visible label`).toMatch(
        new RegExp(`<label[^>]*for="${id.replace(/[«»:]/g, (c) => `\\${c}`)}"[^>]*>${label}</label>`),
      );
      const described = area.match(/aria-describedby="([^"]+)"/)?.[1] ?? "";
      expect(described, `${testId} names the hint`).not.toBe("");
      expect(html).toContain(`id="${described}"`);
      checked++;
    }
    expect(checked, "anti-vacuity: both fields").toBe(2);
  });
});

describe("the chrome is the dictionary's, in every locale", () => {
  it("each of the four locales draws its own title, hint, labels, placeholders and Save (none left in English)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = DICTS[locale];
      const html = renderToStaticMarkup(
        <DictProvider dict={dict} locale={locale}>
          <OrgSponsorInvoiceDetails orgId={ORG} initialAddress={null} initialBankDetails={null} canEdit />
        </DictProvider>,
      );
      for (const key of [
        "title", "hint", "addressLabel", "bankLabel", "addressPlaceholder", "bankPlaceholder", "save",
      ] as const) {
        const words = t(dict, `settings.sponsorInvoices.${key}` as MessageKey);
        const escaped = words.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
        expect(html, `${locale}: ${key}`).toContain(escaped);
        if (locale !== "en") {
          expect(words, `${locale}: ${key} is translated, not the English`).not.toBe(msg(`settings.sponsorInvoices.${key}` as MessageKey));
        }
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 7 strings").toBe(28);
  });
});

describe("saving sends only what changed, one single-key PATCH per field (F30)", () => {
  it("changing the address sends ONE PATCH carrying the address alone, then says Saved", async () => {
    const m = mount({ initialBankDetails: "Sort 12-34-56" });
    m.typeAddress("Riverside CC, 12 Mill Lane");
    expect(m.saveDisabled()).toBe(false);
    await m.save();
    await flush();
    expect(calls).toEqual([{ url: URL, method: "PATCH", body: { [ADDRESS]: "Riverside CC, 12 Mill Lane" } }]);
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
    expect(m.saveDisabled()).toBe(true);
  });

  it("changing the bank details sends ONE PATCH carrying the bank details alone", async () => {
    const m = mount({ initialAddress: "12 Mill Lane" });
    m.typeBank("Sort 12-34-56\nAcc 12345678");
    await m.save();
    await flush();
    expect(calls).toEqual([{ url: URL, method: "PATCH", body: { [BANK]: "Sort 12-34-56\nAcc 12345678" } }]);
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
  });

  it("changing both is TWO PATCHes, address then bank details, the second only after the first answered", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    answer = async (_call, n) => {
      if (n === 1) await held;
      return { status: 200, body: { ok: true, data: {} } };
    };
    const m = mount();
    m.typeAddress("12 Mill Lane");
    m.typeBank("Sort 12-34-56");
    const saving = m.save();
    await flush();
    expect(calls.map((c) => Object.keys(c.body)), "while the first is unanswered only the first has been sent").toEqual([[ADDRESS]]);
    expect(m.status(), "and nothing says Saved yet").not.toBe(msg("settings.sponsorInvoices.saved"));
    release();
    await saving;
    await flush();
    expect(calls).toEqual([
      { url: URL, method: "PATCH", body: { [ADDRESS]: "12 Mill Lane" } },
      { url: URL, method: "PATCH", body: { [BANK]: "Sort 12-34-56" } },
    ]);
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
  });

  it("Saved appears only when the LAST of two PATCHes has answered 200", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    answer = async (_call, n) => {
      if (n === 2) await held;
      return { status: 200, body: { ok: true, data: {} } };
    };
    const m = mount();
    m.typeAddress("12 Mill Lane");
    m.typeBank("Sort 12-34-56");
    const saving = m.save();
    await flush();
    expect(calls.length, "both sent, the second still open").toBe(2);
    expect(m.status(), "the first answered 200 but the pair is not done").not.toBe(msg("settings.sponsorInvoices.saved"));
    expect(m.saveDisabled(), "Save stays disabled while a PATCH is open").toBe(true);
    expect(textOf(m.find("sponsor-invoices-save")).trim(), "and says it is saving").toBe(msg("settings.sponsorInvoices.saving"));
    release();
    await saving;
    await flush();
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
  });

  it("text is trimmed before it is sent, and a cleared field (empty or only spaces) is sent as null (both fields, count reported)", async () => {
    const cases: { typed: string; sent: string | null }[] = [
      { typed: "  12 Mill Lane \n", sent: "12 Mill Lane" },
      { typed: "", sent: null },
      { typed: "   \n  ", sent: null },
    ];
    let checked = 0;
    for (const [type, column] of [
      [(m: ReturnType<typeof mount>, v: string) => m.typeAddress(v), ADDRESS],
      [(m: ReturnType<typeof mount>, v: string) => m.typeBank(v), BANK],
    ] as const) {
      for (const c of cases) {
        calls.length = 0;
        const m = mount({ initialAddress: "was here", initialBankDetails: "was here too" });
        type(m, c.typed);
        await m.save();
        await flush();
        expect(calls, `${column} ${JSON.stringify(c.typed)}`).toEqual([{ url: URL, method: "PATCH", body: { [column]: c.sent } }]);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 fields x 3 cases").toBe(6);
  });

  it("whitespace around an unchanged stored value is not a change (no PATCH, Save stays off)", async () => {
    const m = mount({ initialAddress: "12 Mill Lane" });
    m.typeAddress("12 Mill Lane  \n");
    expect(m.saveDisabled()).toBe(true);
    await m.save();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("a pristine island's Save handler sends nothing even when called directly", async () => {
    const m = mount({ initialAddress: "12 Mill Lane", initialBankDetails: "Sort 12-34-56" });
    await m.save();
    await flush();
    expect(calls).toHaveLength(0);
    expect(m.status(), "and it does not claim a save that never happened").toBe("");
  });

  it("clearing a stored value sends null, and after the save the field is pristine again", async () => {
    const m = mount({ initialBankDetails: "Sort 12-34-56" });
    m.typeBank("");
    await m.save();
    await flush();
    expect(calls).toEqual([{ url: URL, method: "PATCH", body: { [BANK]: null } }]);
    expect(m.saveDisabled()).toBe(true);
    // Typing the old text back is a change again (the saved baseline moved to "nothing").
    m.typeBank("Sort 12-34-56");
    expect(m.saveDisabled()).toBe(false);
  });

  it("a second save after a first sends only the field edited since (the baseline moves)", async () => {
    const m = mount();
    m.typeAddress("12 Mill Lane");
    await m.save();
    await flush();
    m.typeBank("Sort 12-34-56");
    await m.save();
    await flush();
    expect(calls.map((c) => c.body)).toEqual([{ [ADDRESS]: "12 Mill Lane" }, { [BANK]: "Sort 12-34-56" }]);
  });

  it("editing after Saved clears the word Saved", async () => {
    const m = mount();
    m.typeAddress("12 Mill Lane");
    await m.save();
    await flush();
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
    m.typeAddress("14 Mill Lane");
    expect(m.status(), "typing in the address").toBe("");
    m.typeBank("Sort 12-34-56");
    await m.save();
    await flush();
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
    m.typeBank("Sort 65-43-21");
    expect(m.status(), "typing in the bank details").toBe("");
  });

  it("a second tap while a save is in flight sends nothing more", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    answer = async () => {
      await held;
      return { status: 200, body: { ok: true, data: {} } };
    };
    const m = mount();
    m.typeAddress("12 Mill Lane");
    const first = m.save();
    await flush();
    const second = m.save();
    await flush();
    expect(calls, "one PATCH, however many taps").toHaveLength(1);
    release();
    await first;
    await second;
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("the textareas are read-only while a save is in flight, so a keystroke cannot be lost to the answer", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    answer = async () => {
      await held;
      return { status: 200, body: { ok: true, data: {} } };
    };
    const m = mount();
    m.typeAddress("12 Mill Lane");
    const saving = m.save();
    await flush();
    expect(propsOf(m.find("sponsor-invoice-address")).readOnly).toBe(true);
    expect(propsOf(m.find("sponsor-invoice-bank-details")).readOnly).toBe(true);
    release();
    await saving;
    await flush();
    expect(propsOf(m.find("sponsor-invoice-address")).readOnly).toBe(false);
  });

  it("the PATCH goes to the org the page named", async () => {
    const m = mount({ orgId: "org-other" });
    m.typeAddress("x");
    await m.save();
    await flush();
    expect(calls[0]?.url).toBe("/api/orgs/org-other");
  });
});

describe("a refusal reads the dictionary's words, and a half-saved pair keeps what saved", () => {
  it("a refused first PATCH says so in the dictionary's words (never the server's), sends no second, and leaves both fields to retry", async () => {
    answer = () => ({ status: 500, body: { ok: false, error: "relation \"organizations\" exploded" } });
    const m = mount();
    m.typeAddress("12 Mill Lane");
    m.typeBank("Sort 12-34-56");
    await m.save();
    await flush();
    expect(calls.map((c) => Object.keys(c.body)), "the second PATCH is not sent after the first is refused").toEqual([[ADDRESS]]);
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saveFailed"));
    expect(textOf(m.island.tree()[0]!)).not.toContain("exploded");
    expect(m.saveDisabled(), "both still unsaved: Save is on again").toBe(false);
    expect(m.value("sponsor-invoice-address")).toBe("12 Mill Lane");
    expect(m.value("sponsor-invoice-bank-details")).toBe("Sort 12-34-56");
  });

  it("a refused SECOND PATCH keeps the first as saved: the retry sends the bank details alone, then says Saved", async () => {
    answer = (_call, n) =>
      n === 2 ? { status: 500, body: { ok: false, error: "boom" } } : { status: 200, body: { ok: true, data: {} } };
    const m = mount();
    m.typeAddress("12 Mill Lane");
    m.typeBank("Sort 12-34-56");
    await m.save();
    await flush();
    expect(calls.map((c) => Object.keys(c.body))).toEqual([[ADDRESS], [BANK]]);
    expect(m.status(), "it says what saved and what did not, not the generic failure").toBe(msg("settings.sponsorInvoices.partialSaved"));
    expect(m.saveDisabled(), "the bank details are still unsaved").toBe(false);

    answer = () => ({ status: 200, body: { ok: true, data: {} } });
    await m.save();
    await flush();
    expect(calls.map((c) => Object.keys(c.body)), "the retry is the bank details alone").toEqual([[ADDRESS], [BANK], [BANK]]);
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
    expect(m.saveDisabled()).toBe(true);
  });

  it("each refusal status reads its own words (count reported): 401 is who-can-change, the rest the generic", async () => {
    const rows: [number, MessageKey][] = [
      [401, "settings.sponsorInvoices.notAllowed"],
      [400, "settings.sponsorInvoices.saveFailed"],
      [404, "settings.sponsorInvoices.saveFailed"],
      [500, "settings.sponsorInvoices.saveFailed"],
    ];
    let checked = 0;
    for (const [status, key] of rows) {
      answer = () => ({ status, body: { ok: false, error: `server sentence ${status}` } });
      const m = mount();
      m.typeAddress("x");
      await m.save();
      await flush();
      expect(m.status(), `status ${status}`).toBe(msg(key));
      expect(m.status()).not.toContain("server sentence");
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(4);
  });

  it("a refusal's words and Saved never show together: a retry that works clears the error", async () => {
    answer = () => ({ status: 500, body: { ok: false } });
    const m = mount();
    m.typeAddress("x");
    await m.save();
    await flush();
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saveFailed"));
    answer = () => ({ status: 200, body: { ok: true, data: {} } });
    await m.save();
    await flush();
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
  });
});

describe("a half-saved pair says what saved (fix round 1, M1)", () => {
  it("the first PATCH answered 200 and the second failed: the words name the address as saved and the bank details as not, in red, and NOT the generic failure", async () => {
    answer = (_call, n) =>
      n === 2 ? { status: 500, body: { ok: false, error: "boom" } } : { status: 200, body: { ok: true, data: {} } };
    const m = mount();
    m.typeAddress("12 Mill Lane");
    m.typeBank("Sort 12-34-56");
    await m.save();
    await flush();
    expect(m.status()).toBe(msg("settings.sponsorInvoices.partialSaved"));
    expect(m.status()).not.toBe(msg("settings.sponsorInvoices.saveFailed"));
    expect(m.status()).not.toBe(msg("settings.sponsorInvoices.saved"));
    // The English the owner approved: the address is the one that saved, the bank details the one to try again.
    expect(msg("settings.sponsorInvoices.partialSaved")).toBe("Address saved. The bank details couldn't be saved. Try again.");
    expect(propsOf(m.find("sponsor-invoices-status")).className as string, "an error, not a success").toContain("text-red-600");
  });

  it("positive pair: when the FIRST PATCH is the one refused nothing saved, so it is still the generic failure (500) or who-can-change (401)", async () => {
    let checked = 0;
    for (const [status, key] of [
      [500, "settings.sponsorInvoices.saveFailed"],
      [401, "settings.sponsorInvoices.notAllowed"],
    ] as const) {
      answer = () => ({ status, body: { ok: false } });
      const m = mount();
      m.typeAddress("12 Mill Lane");
      m.typeBank("Sort 12-34-56");
      await m.save();
      await flush();
      expect(m.status(), `first PATCH ${status}`).toBe(msg(key));
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(2);
  });

  it("a single changed field that fails is the generic failure: there is no earlier field to have saved (both fields, count reported)", async () => {
    let checked = 0;
    for (const typeInto of ["typeAddress", "typeBank"] as const) {
      answer = () => ({ status: 500, body: { ok: false } });
      const m = mount();
      m[typeInto]("x");
      await m.save();
      await flush();
      expect(m.status(), typeInto).toBe(msg("settings.sponsorInvoices.saveFailed"));
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(2);
  });

  it("the retry after a half-save clears the partial words, sends the bank details alone, and says Saved", async () => {
    answer = (_call, n) =>
      n === 2 ? { status: 500, body: { ok: false } } : { status: 200, body: { ok: true, data: {} } };
    const m = mount();
    m.typeAddress("12 Mill Lane");
    m.typeBank("Sort 12-34-56");
    await m.save();
    await flush();
    answer = () => ({ status: 200, body: { ok: true, data: {} } });
    await m.save();
    await flush();
    expect(calls.map((c) => Object.keys(c.body))).toEqual([[ADDRESS], [BANK], [BANK]]);
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
  });

  it("the partial words exist in all four locales, each translated (none left in English), and are their own words, not the generic failure's", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const words = t(DICTS[locale], "settings.sponsorInvoices.partialSaved" as MessageKey);
      expect(words, `${locale}: present`).not.toBe("");
      expect(words, `${locale}: not the raw key`).not.toContain("settings.sponsorInvoices");
      expect(words, `${locale}: not the generic failure`).not.toBe(t(DICTS[locale], "settings.sponsorInvoices.saveFailed" as MessageKey));
      if (locale !== "en") expect(words, `${locale}: translated`).not.toBe(msg("settings.sponsorInvoices.partialSaved" as MessageKey));
      checked++;
    }
    expect(checked, "anti-vacuity: 4 locales").toBe(4);
  });
});

describe("the status line (fix round 1, M4)", () => {
  it("is a polite live region, mounted from first paint so a screen reader hears the change (markup AND tree)", () => {
    const html = renderToStaticMarkup(
      <OrgSponsorInvoiceDetails orgId={ORG} initialAddress={null} initialBankDetails={null} canEdit />,
    );
    const tag = html.match(/<p[^>]*data-testid="sponsor-invoices-status"[^>]*>/)?.[0] ?? "";
    expect(tag, "the status paragraph is in the first-paint markup, empty").not.toBe("");
    expect(tag).toMatch(/\srole="status"/);
    expect(tag).toMatch(/\saria-live="polite"/);
    const m = mount();
    const props = propsOf(m.find("sponsor-invoices-status"));
    expect(props.role).toBe("status");
    expect(props["aria-live"]).toBe("polite");
    expect(m.status(), "and it is empty until there is something to say").toBe("");
  });

  it("a new save clears the previous error at once, before the new answer arrives", async () => {
    answer = () => ({ status: 500, body: { ok: false } });
    const m = mount();
    m.typeAddress("x");
    await m.save();
    await flush();
    expect(m.status(), "the error is up").toBe(msg("settings.sponsorInvoices.saveFailed"));

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    answer = async () => {
      await held;
      return { status: 200, body: { ok: true, data: {} } };
    };
    const retry = m.save();
    await flush();
    expect(calls.length, "the retry is in flight").toBe(2);
    expect(m.status(), "the old error is gone while the retry is open").toBe("");
    release();
    await retry;
    await flush();
    expect(m.status()).toBe(msg("settings.sponsorInvoices.saved"));
  });
});

describe("a successful save refreshes the route (fix round 1, M6)", () => {
  it("one PATCH saved: the route is refreshed once", async () => {
    const m = mount();
    m.typeAddress("12 Mill Lane");
    await m.save();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("two PATCHes saved: refreshed ONCE, after the last answer (not once per PATCH, and not before the second has answered)", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    answer = async (_call, n) => {
      if (n === 2) await held;
      return { status: 200, body: { ok: true, data: {} } };
    };
    const m = mount();
    m.typeAddress("12 Mill Lane");
    m.typeBank("Sort 12-34-56");
    const saving = m.save();
    await flush();
    expect(calls.length, "the second PATCH is open").toBe(2);
    expect(refresh, "the first answered 200 but the pair is not done").not.toHaveBeenCalled();
    release();
    await saving;
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("nothing saved, or the pair only half saved: no refresh (first PATCH refused, second refused, nothing changed)", async () => {
    // first PATCH refused
    answer = () => ({ status: 500, body: { ok: false } });
    const a = mount();
    a.typeAddress("x");
    a.typeBank("y");
    await a.save();
    await flush();
    expect(refresh, "first refused").not.toHaveBeenCalled();
    // second PATCH refused after the first saved
    answer = (_call, n) => (n === 2 ? { status: 500, body: { ok: false } } : { status: 200, body: { ok: true, data: {} } });
    calls.length = 0;
    const b = mount();
    b.typeAddress("x");
    b.typeBank("y");
    await b.save();
    await flush();
    expect(calls.length, "both were sent").toBe(2);
    expect(refresh, "half saved").not.toHaveBeenCalled();
    // nothing changed: Save sends and refreshes nothing
    const c = mount({ initialAddress: "x" });
    await c.save();
    await flush();
    expect(refresh, "pristine").not.toHaveBeenCalled();
  });
});

describe("a member who cannot edit", () => {
  it("sees the stored values read-only, with the reason and no Save", () => {
    const m = mount({ canEdit: false, initialAddress: "12 Mill Lane", initialBankDetails: "Sort 12-34-56" });
    expect(m.value("sponsor-invoice-address")).toBe("12 Mill Lane");
    expect(propsOf(m.find("sponsor-invoice-address")).readOnly).toBe(true);
    expect(propsOf(m.find("sponsor-invoice-bank-details")).readOnly).toBe(true);
    expect(m.has("sponsor-invoices-save")).toBe(false);
    expect(textOf(m.island.tree()[0]!)).toContain(msg("settings.sponsorInvoices.notAllowed"));
  });

  it("canEdit is required: a mount that leaves it out is read-only, never an editor by default", () => {
    // The prop is required by the type (the page always passes it); this pins the fail-safe if a caller ever slips it through.
    const m = mount({ canEdit: undefined as unknown as boolean });
    expect(m.has("sponsor-invoices-save")).toBe(false);
    expect(propsOf(m.find("sponsor-invoice-address")).readOnly).toBe(true);
    expect(propsOf(m.find("sponsor-invoice-bank-details")).readOnly).toBe(true);
  });

  it("positive pair: an editor has Save, editable fields and no reason line", () => {
    const m = mount({ canEdit: true });
    expect(m.has("sponsor-invoices-save")).toBe(true);
    expect(propsOf(m.find("sponsor-invoice-address")).readOnly).toBe(false);
    expect(textOf(m.island.tree()[0]!)).not.toContain(msg("settings.sponsorInvoices.notAllowed"));
  });
});
