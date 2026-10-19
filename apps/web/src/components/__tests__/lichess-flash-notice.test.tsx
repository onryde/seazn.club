// The outcome of a Lichess linking flow (`?lichess=<code>`), said on the page the player lands on. One component for the
// match room's link/re-link card and the registration stepper's Lichess card, so the two cannot drift: the outcome
// sentence, in an error tone, and - for the one failure the player can only fix elsewhere (already_linked: that Lichess
// account belongs to ANOTHER Seazn account) - the next step. It says only what FAILED (PR #990 review, I1): a `linked`
// landing is no sentence a held page may keep above a later revoke card, so it draws nothing.
//
// Painted with the REAL dictionaries in every locale; the codes come from the module's own declaration. Never derives an
// expected sentence from the component: it is read from the dictionary by key.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict } from "@/lib/i18n-constants";
import { LICHESS_FLASH_CODES } from "@/lib/lichess-link";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { LichessFlashNotice } from "../lichess-flash-notice";

const LOCALES = { en, es, fr, nl } as const;
type Locale = keyof typeof LOCALES;
const dictOf = (l: Locale) => LOCALES[l] as Record<string, string>;
const EN = dictOf("en");

function paint(code: string | null | undefined, locale: Locale = "en", testId?: string): string {
  return renderToStaticMarkup(
    <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
      <LichessFlashNotice code={code} testId={testId} />
    </DictProvider>,
  );
}
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const unescapeText = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const FAILURES = LICHESS_FLASH_CODES.filter((c) => c !== "linked");

describe("LichessFlashNotice", () => {
  it("already_linked: the sentence AND the next step, as an alert (the owner's staging loop: it used to say nothing)", () => {
    const html = paint("already_linked");
    expect(html).toContain(esc(EN["settings.account.lichess.flash.already_linked"]!));
    expect(html).toContain(esc(EN["settings.account.lichess.flashNext.already_linked"]!));
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain('data-tone="error"');
    expect(html).toContain('data-code="already_linked"');
    expect(html).toContain('data-testid="lichess-flash-next"');
    // The English next step is the owner's instruction: unlink it in Settings under the other account, or link another.
    const next = EN["settings.account.lichess.flashNext.already_linked"]!;
    expect(next).toMatch(/sign in to the Seazn account that has this Lichess account/i);
    expect(next).toMatch(/unlink it in Settings/i);
    expect(next).toMatch(/different/i);
  });

  it("linked: NOTHING - a held 'linked' must never stand over a later revoke or re-consent card", () => {
    expect(paint("linked")).toBe("");
    expect(paint("linked", "es")).toBe("");
    expect(paint("linked", "en", "register-lichess-flash")).toBe("");
  });

  it("every other failure is an alert carrying its own sentence and NO next step - the next step is already_linked's alone", () => {
    let checked = 0;
    for (const code of FAILURES) {
      const html = paint(code);
      expect(html, code).toContain(esc(EN[`settings.account.lichess.flash.${code}`]!));
      expect(html, code).toMatch(/role="alert"/);
      expect(html, code).toContain('data-tone="error"');
      if (code !== "already_linked") expect(html, `${code}: no next step`).not.toContain("lichess-flash-next");
      checked++;
    }
    expect(checked, "anti-vacuity: every failure code").toBe(LICHESS_FLASH_CODES.length - 1);
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it("the empty case: an unknown, hand-typed, empty or absent code renders NOTHING (not an empty box)", () => {
    let checked = 0;
    // The last two are an identity smuggled behind a real code: not our code, so nothing - the notice cannot be made to say it.
    for (const v of [undefined, null, "", "Linked", "already_linked ", "<script>alert(1)</script>", "totally-made-up", "already_linked:ada_plays", "already_linked&username=ada_plays"]) {
      expect(paint(v), JSON.stringify(v)).toBe("");
      checked++;
    }
    expect(checked).toBe(9);
  });

  it("every locale: its own words for the sentence and the next step, no raw key, no placeholder left", () => {
    let checked = 0;
    const sentences = new Set<string>();
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const html = paint("already_linked", locale);
      const d = dictOf(locale);
      expect(html, `${locale}: sentence`).toContain(esc(d["settings.account.lichess.flash.already_linked"]!));
      expect(html, `${locale}: next step`).toContain(esc(d["settings.account.lichess.flashNext.already_linked"]!));
      expect(html, `${locale}: raw key`).not.toMatch(/settings\.account\.lichess\./);
      expect(html, `${locale}: placeholder`).not.toMatch(/\{\w+\}/);
      sentences.add(d["settings.account.lichess.flashNext.already_linked"]!);
      checked++;
    }
    expect(checked).toBe(4);
    expect(sentences.size, "four languages, four next steps").toBe(4);
  });

  it("never names or addresses the other account: the next step carries no placeholder and no address in any locale", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const next = dictOf(locale)["settings.account.lichess.flashNext.already_linked"]!;
      expect(next, `${locale}: no interpolation slot`).not.toMatch(/\{\w+\}/);
      expect(next, `${locale}: no address`).not.toMatch(/@/);
      checked++;
    }
    expect(checked).toBe(4);
  });

  // Owner requirement (2026-10-19): the already_linked message must NOT show the Lichess username, nor anything about the
  // other Seazn account (name, email, id). The notice's only input is the code, so what it can say is exactly the
  // dictionary's two sentences - asserted as EQUALITY of the whole rendered text, not as "does not contain".
  it("already_linked says exactly the sentence and the next step - nothing else, in every locale (no username, no identity of the other account)", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const d = dictOf(locale);
      const text = unescapeText(paint("already_linked", locale).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      const want = `${d["settings.account.lichess.flash.already_linked"]} ${d["settings.account.lichess.flashNext.already_linked"]}`.replace(/\s+/g, " ");
      expect(text, locale).toBe(want);
      expect(text, `${locale}: no address`).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      expect(text, `${locale}: no slot`).not.toMatch(/\{\w+\}/);
      checked++;
    }
    expect(checked).toBe(4);
  });

  // PR #990 review, M3: where the board is on ONE specific Lichess account the host says so, and the generic step's
  // "switch to a different account" would contradict it.
  it("gameAccount: already_linked's next step is the game-account one (keeps the account), in every locale; the sentence is unchanged", () => {
    let checked = 0;
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const d = dictOf(locale);
      const html = renderToStaticMarkup(
        <DictProvider dict={LOCALES[locale] as unknown as Dict} locale={locale}>
          <LichessFlashNotice code="already_linked" gameAccount />
        </DictProvider>,
      );
      expect(html, `${locale}: sentence`).toContain(esc(d["settings.account.lichess.flash.already_linked"]!));
      expect(html, `${locale}: game-account step`).toContain(esc(d["settings.account.lichess.flashNext.already_linked_game"]!));
      expect(html, `${locale}: not the generic step`).not.toContain(esc(d["settings.account.lichess.flashNext.already_linked"]!));
      const text = unescapeText(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      expect(text, `${locale}: exactly the two sentences`).toBe(`${d["settings.account.lichess.flash.already_linked"]} ${d["settings.account.lichess.flashNext.already_linked_game"]}`.replace(/\s+/g, " "));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("gameAccount changes nothing for a failure with no next step, and nothing for an absent code", () => {
    const withFlag = (code: string | null) =>
      renderToStaticMarkup(
        <DictProvider dict={en as unknown as Dict} locale="en">
          <LichessFlashNotice code={code} gameAccount />
        </DictProvider>,
      );
    expect(withFlag("token")).toBe(paint("token"));
    expect(withFlag(null)).toBe("");
    expect(withFlag("linked")).toBe("");
  });

  it("takes the host's test id (the register card keeps its own), and derives the next step's from it", () => {
    const html = paint("already_linked", "en", "register-lichess-flash");
    expect(html).toContain('data-testid="register-lichess-flash"');
    expect(html).toContain('data-testid="register-lichess-flash-next"');
    expect(html).not.toContain('data-testid="lichess-flash"');
  });

  it("a long unbroken sentence wraps rather than widening the card (break-anywhere on the text, min-w-0 on the chain)", () => {
    const html = paint("already_linked");
    expect(html).toMatch(/class="[^"]*\[overflow-wrap:anywhere\][^"]*"/);
    expect(html).toMatch(/class="[^"]*\bmin-w-0\b[^"]*"/);
  });
});
