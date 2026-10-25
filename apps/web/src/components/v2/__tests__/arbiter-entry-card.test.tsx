// The Fixtures tab's one card for the Arbiter Panel (spec 2026-10-24-arbiter-round-column-design.md §8, controller ruling 1,
// option C): the existing "Arbiter panel" link plus ONE status line instead of a fixed body. This suite is the card's half
// (what each line SAYS, in four locales); the page's half - which line it picks, from which reads - is
// `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/__tests__/arbiter-entry-link.test.tsx`, and the picker's own ladder is
// `lib/__tests__/round-column.test.ts`.
//
// Every expected sentence is the DICTIONARY's own template, read from the dictionary file and filled by hand here
// (never produced by the card's helpers, which would only prove the card agrees with itself).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ArbiterEntryCard } from "@/components/v2/arbiter-entry-card";
import type { EntryLine } from "@/lib/round-column";
import type { Dict, Locale } from "@/lib/i18n-constants";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const HREF = "/o/org/c/comp/d/div/arbiter";
const DICTS: Record<Locale, Record<string, string>> = {
  en: enUi as Record<string, string>,
  es: esUi as Record<string, string>,
  fr: frUi as Record<string, string>,
  nl: nlUi as Record<string, string>,
} as Record<Locale, Record<string, string>>;
const EN = DICTS.en;

const render = (line: EntryLine, locale: Locale = "en") =>
  renderToStaticMarkup(<ArbiterEntryCard href={HREF} line={line} dict={DICTS[locale] as unknown as Dict} locale={locale} />);

/** The text of the status line, markup stripped, entities decoded for the apostrophe the dictionaries use. */
const statusOf = (html: string) => {
  const m = html.match(/<span[^>]*data-testid="arbiter-entry-status"[^>]*>([\s\S]*?)<\/span>/);
  expect(m, "the card has a status line").not.toBeNull();
  return m![1]!.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'");
};
const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));

const LINES: { line: EntryLine; key: string; vars: Record<string, string | number> }[] = [
  { line: { kind: "default" }, key: "arbiter.entry.body", vars: {} },
  { line: { kind: "attention", count: 1 }, key: "arbiter.column.queue.one", vars: { count: 1 } },
  { line: { kind: "attention", count: 3 }, key: "arbiter.column.queue.other", vars: { count: 3 } },
  { line: { kind: "checkin", roundNo: 4 }, key: "arbiter.entry.status.checkin", vars: { round: 4 } },
  { line: { kind: "ready", roundNo: 2 }, key: "arbiter.entry.status.ready", vars: { round: 2 } },
];

describe("ArbiterEntryCard", () => {
  it("is one card: the link into the panel (its own copy and href) and one status line", () => {
    const html = render({ kind: "default" });
    expect(html.split('data-testid="arbiter-entry"').length - 1, "one card").toBe(1);
    expect(html.split('data-testid="arbiter-entry-status"').length - 1, "one status line").toBe(1);
    expect(html).toContain(`href="${HREF}"`);
    expect(html).toContain(`>${EN["arbiter.entry.link"]}</a>`);
  });

  it("every line, in English: the status line reads the dictionary's sentence, counted ones through plural, and carries its kind", () => {
    let checked = 0;
    for (const c of LINES) {
      const html = render(c.line);
      expect(statusOf(html), c.key).toBe(fill(EN[c.key]!, c.vars));
      expect(html, c.key).toMatch(new RegExp(`data-testid="arbiter-entry-status"[^>]*data-kind="${c.line.kind}"|data-kind="${c.line.kind}"[^>]*data-testid="arbiter-entry-status"`));
      checked++;
    }
    expect(checked, "anti-vacuity: every kind swept, attention in both plural forms").toBe(5);
    expect(new Set(LINES.map((c) => c.line.kind)).size, "the four kinds").toBe(4);
  });

  it("the plural pair is a real pair: one and other differ", () => {
    expect(statusOf(render({ kind: "attention", count: 1 }))).not.toBe(statusOf(render({ kind: "attention", count: 2 })));
  });

  it("only a board needing a decision is red; the other three lines are quiet", () => {
    const RED = "text-[#b42318]";
    let checked = 0;
    for (const c of LINES) {
      const html = render(c.line);
      const status = html.match(/<span[^>]*data-testid="arbiter-entry-status"[^>]*>/)![0];
      if (c.line.kind === "attention") expect(status, "attention is red").toContain(RED);
      else expect(status, `${c.line.kind} is not red`).not.toContain(RED);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it.each(["es", "fr", "nl"] as Locale[])("%s: every line is translated, interpolated, and free of the dashes the column avoids", (locale) => {
    const dash = [0x2014, 0x2013, 0x2192].map((c) => String.fromCharCode(c));
    let checked = 0;
    for (const c of LINES) {
      const html = render(c.line, locale);
      const text = statusOf(html);
      expect(text, `${locale} ${c.key}`).toBe(fill(DICTS[locale]![c.key]!, c.vars));
      expect(text, `${locale} ${c.key}: not the English copied`).not.toBe(fill(EN[c.key]!, c.vars));
      expect(text, `${locale} ${c.key}: nothing left to fill`).not.toMatch(/\{\w+\}/);
      for (const d of dash) expect(text, `${locale} ${c.key}: no ${d}`).not.toContain(d);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("the two new keys exist in all four locales, each different from the English", () => {
    let checked = 0;
    for (const key of ["arbiter.entry.status.ready", "arbiter.entry.status.checkin"]) {
      for (const locale of ["es", "fr", "nl"] as Locale[]) {
        expect(DICTS[locale]![key], `${locale} ${key}`).toBeTypeOf("string");
        expect(DICTS[locale]![key], `${locale} ${key} is translated`).not.toBe(EN[key]);
        expect(DICTS[locale]![key], `${locale} ${key} keeps its placeholder`).toContain("{round}");
        checked++;
      }
      expect(EN[key], `en ${key}`).toContain("{round}");
    }
    expect(checked).toBe(6);
  });
});
