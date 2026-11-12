// JoinCodeEntry (polish wave P6) - the public register page's "Have a join code?" field. No jsdom in this workspace: driven through the
// shared node-env hook harness, with `next/navigation`'s router replaced by a recorder (the router is the one thing the field touches).
//
// What the harness can see is the join between a typed value and the URL the router is sent to, which is the whole point of the field.
// Whether the JOIN PAGE then answers the same for any code is the seam test next door (register/join/__tests__/join-code-field-seam).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import { normalizeRefCode } from "@/lib/ref-code";
import { JoinCodeEntry } from "../join-code-entry";

const nav = vi.hoisted(() => ({ push: vi.fn<(href: string) => void>() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

beforeEach(() => nav.push.mockReset());

const mount = () => renderIsland(JoinCodeEntry, { orgSlug: "riverside", competitionSlug: "summer-smash" });
type Island = ReturnType<typeof mount>;

const el = (island: Island, type: string) => island.tree().find((e) => e.type === type)!;
const type = (island: Island, value: string) => (propsOf(el(island, "input")).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const submit = (island: Island) => {
  const prevented = vi.fn();
  (propsOf(el(island, "form")).onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: prevented });
  return prevented;
};
/** Whether an element of `type` sits anywhere under `root` (the harness renders one level deep; these are host elements). */
const walkHas = (root: ReturnType<Island["tree"]>[number], type: string): boolean => {
  const kids = ([] as unknown[]).concat((propsOf(root).children as unknown) ?? []).flat(Infinity);
  return kids.some((k) => typeof k === "object" && k !== null && "type" in k && ((k as { type: unknown }).type === type || walkHas(k as never, type)));
};
const joinPage = (code: string) => `/live/riverside/summer-smash/register/join?join_code=${code}`;

describe("JoinCodeEntry - what is on screen", () => {
  it("names itself, says who it is for, and labels its one input", () => {
    const island = mount();
    const text = textOf(island.tree());
    expect(text).toContain(t(uiEn, "register.joinCode.heading"));
    expect(text).toContain(t(uiEn, "register.joinCode.hint"));
    expect(text).toContain(t(uiEn, "register.joinCode.submit"));
    const input = propsOf(el(island, "input"));
    const label = propsOf(el(island, "label"));
    expect(label.htmlFor, "the label points at the input").toBe(input.id);
    expect(textOf(el(island, "label"))).toBe(t(uiEn, "register.joinCode.label"));
    expect(input.placeholder).toBe(t(uiEn, "register.joinCode.placeholder"));
  });

  it("a typed join code is a capability, so the input is `ph-no-capture` (the recorder drops what is typed)", () => {
    const cls = String(propsOf(el(mount(), "input")).className);
    expect(cls).toMatch(/(^|\s)ph-no-capture(\s|$)/);
  });
});

describe("JoinCodeEntry - collapsed to one line (polish wave H)", () => {
  it("is a native disclosure, closed by default: one summary line naming the door, the form behind it", () => {
    const tree = mount().tree();
    const details = tree.filter((e) => e.type === "details");
    expect(details, "one disclosure").toHaveLength(1);
    expect(propsOf(details[0]!).open, "closed until the person asks for it").toBeFalsy();
    const summaries = tree.filter((e) => e.type === "summary");
    expect(summaries).toHaveLength(1);
    expect(textOf(summaries[0]!), "the collapsed line is the question and nothing else").toBe(t(uiEn, "register.joinCode.heading"));
    // The form and its input live INSIDE the disclosure, so a closed one shows only the summary line.
    const inner = textOf(details[0]!);
    expect(inner).toContain(t(uiEn, "register.joinCode.hint"));
    expect(walkHas(details[0]!, "form"), "the form is inside the disclosure").toBe(true);
    expect(walkHas(details[0]!, "input"), "the input is inside the disclosure").toBe(true);
    expect(propsOf(details[0]!)["data-testid"]).toBe("register-join-code");
  });

  it("the placeholder does not look like a registrant reference in any locale (join codes and refs share the SZ-XXXX-XXXX shape)", () => {
    const refShape = /^SZ-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
    const dicts = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl };
    let checked = 0;
    for (const [locale, dict] of Object.entries(dicts)) {
      const placeholder = t(dict, "register.joinCode.placeholder");
      expect(placeholder, `${locale}: a real string`).not.toBe("register.joinCode.placeholder");
      expect(refShape.test(normalizeRefCode(placeholder)), `${locale}: "${placeholder}" reads as a reference`).toBe(false);
      expect(placeholder, locale).not.toMatch(/XXXX/);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every locale").toBe(4);
  });
});

describe("JoinCodeEntry - submit", () => {
  it("sends a typed code to the join page, read the way a person writes one down (case, dashes and the SZ do not matter)", () => {
    const typed = ["SZ-ABCD-EF23", "sz-abcd-ef23", "  sz abcd ef23  ", "abcdef23", "AB-CD-EF-23"];
    let checked = 0;
    for (const value of typed) {
      nav.push.mockReset();
      const island = mount();
      type(island, value);
      const prevented = submit(island);
      expect(prevented, `${value}: the native form submit is cancelled`).toHaveBeenCalledTimes(1);
      expect(nav.push, value).toHaveBeenCalledTimes(1);
      expect(nav.push, value).toHaveBeenCalledWith(joinPage("SZ-ABCD-EF23"));
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(typed.length);
  });

  it("a value that is not a code goes to the join page as typed (upper-cased, encoded) - the page, not this field, says it is not valid", () => {
    const island = mount();
    type(island, "hello world&x=1");
    submit(island);
    expect(nav.push).toHaveBeenCalledWith(joinPage("HELLO%20WORLD%26X%3D1"));
  });

  it("a blank or whitespace-only entry goes nowhere", () => {
    for (const blank of ["", "   ", "\t\n"]) {
      nav.push.mockReset();
      const island = mount();
      type(island, blank);
      const prevented = submit(island);
      expect(prevented, "still cancels the native submit").toHaveBeenCalledTimes(1);
      expect(nav.push, JSON.stringify(blank)).not.toHaveBeenCalled();
    }
  });

  it("sequence: a second code after the first goes where the SECOND points (the field does not keep the first)", () => {
    const island = mount();
    type(island, "sz-aaaa-bbbb");
    submit(island);
    type(island, "sz-cccc-dddd");
    submit(island);
    expect(nav.push.mock.calls.map((c) => c[0])).toEqual([joinPage("SZ-AAAA-BBBB"), joinPage("SZ-CCCC-DDDD")]);
  });

  it("the competition decides the page: the same code on two competitions goes to two join pages", () => {
    const hrefs = [
      ["riverside", "summer-smash"],
      ["harbour", "winter-cup"],
    ].map(([orgSlug, competitionSlug]) => {
      nav.push.mockReset();
      const island = renderIsland(JoinCodeEntry, { orgSlug: orgSlug!, competitionSlug: competitionSlug! });
      type(island, "SZ-ABCD-EF23");
      submit(island);
      return nav.push.mock.calls[0]![0];
    });
    expect(hrefs).toEqual([
      "/live/riverside/summer-smash/register/join?join_code=SZ-ABCD-EF23",
      "/live/harbour/winter-cup/register/join?join_code=SZ-ABCD-EF23",
    ]);
  });
});
