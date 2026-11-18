// The home page's competition flow (competition-flow.tsx): eight steps in the organiser's order, complete without
// script, in every locale. The scroll state's two pure functions are tested here too; the wiring (what a reader sees
// while scrolling) is e2e's job (marketing-home.spec.ts), since this suite has no DOM.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompetitionFlow, FLOW_ID, FLOW_STEPS } from "../competition-flow";
import { currentStep, lineFill, markAt } from "../competition-flow-progress";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/marketing.json";
import fr from "@/dictionaries/fr/marketing.json";
import es from "@/dictionaries/es/marketing.json";
import nl from "@/dictionaries/nl/marketing.json";

const DICTS: Record<Locale, Record<string, string>> = { en, fr, es, nl };
const render = (lang: Locale) =>
  renderToStaticMarkup(<CompetitionFlow dict={DICTS[lang] as unknown as Dict} lang={lang} currency="usd" />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ");

describe("CompetitionFlow", () => {
  it("premise: eight steps, and every locale is rendered", () => {
    expect(FLOW_STEPS).toHaveLength(8);
    expect(LOCALES.length).toBe(4);
  });

  it.each(LOCALES.map((l) => [l]))("%s: the eight steps appear once each, in order, with their title, stage and anchor", (lang) => {
    const html = render(lang);
    const d = DICTS[lang];
    expect(html).toContain(`id="${FLOW_ID}"`);
    let from = 0;
    FLOW_STEPS.forEach((s, i) => {
      const at = html.indexOf(`id="flow-${s.key}"`, from);
      expect(at, `${s.key} comes after the step before it`).toBeGreaterThan(from - 1);
      expect(html.split(`id="flow-${s.key}"`), `${s.key} once`).toHaveLength(2);
      const end = i + 1 < FLOW_STEPS.length ? html.indexOf(`id="flow-${FLOW_STEPS[i + 1]!.key}"`) : html.length;
      const body = html.slice(at, end);
      expect(body).toContain(`<h3 class="mk-cond">${d[`home.flow.${s.key}.title`]}</h3>`);
      expect(body).toContain(d[`home.flow.stage.${s.stage}`]!.replace(/'/g, "&#x27;"));
      expect(body).toContain(`data-flow-step="${i}"`);
      // The contents list links to it.
      expect(html).toContain(`href="#flow-${s.key}"`);
      from = at + 1;
    });
  });

  it.each(LOCALES.map((l) => [l]))("%s: the heading sets two words on lime, and no marker character leaks", (lang) => {
    const h2 = render(lang).match(/<h2[^>]*>(.*?)<\/h2>/s)![1]!;
    expect(h2.match(/<span class="mkf-hl">[^<]+<\/span>/g)).toHaveLength(2);
    expect(h2).not.toContain("*");
    expect(text(h2).replace(/\s+/g, " ").trim()).toBe(DICTS[lang]["home.flow.title"]!.replace(/\*/g, ""));
  });

  it.each(LOCALES.map((l) => [l]))("%s: no placeholder or raw key reaches the page", (lang) => {
    const body = text(render(lang));
    expect(body).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(body).not.toMatch(/home\.flow\./);
  });

  it.each(LOCALES.filter((l) => l !== "en").map((l) => [l]))("%s: the copy is translated, not English", (lang) => {
    const body = render(lang);
    for (const s of FLOW_STEPS) {
      expect(DICTS[lang][`home.flow.${s.key}.title`], s.key).not.toBe(en[`home.flow.${s.key}.title` as keyof typeof en]);
      expect(body, s.key).not.toContain(`>${en[`home.flow.${s.key}.title` as keyof typeof en]}<`);
    }
  });

  // Owner 2026-11-18: "Score it live" was one step holding the pad, the public page AND the stream — so tall that the
  // progress marker sat on 6 for most of the scroll and looked stuck. Scoring and streaming are a step each.
  it("scoring and streaming are separate steps, in that order, both on the day", () => {
    const keys = FLOW_STEPS.map((s) => s.key);
    expect(keys.indexOf("stream")).toBe(keys.indexOf("live") + 1);
    expect(FLOW_STEPS.filter((s) => s.key === "live" || s.key === "stream").map((s) => s.stage)).toEqual(["day", "day"]);
    const html = render("en");
    const live = html.slice(html.indexOf('id="flow-live"'), html.indexOf('id="flow-stream"'));
    const stream = html.slice(html.indexOf('id="flow-stream"'), html.indexOf('id="flow-winner"'));
    // The pad and the public page stay with scoring; the video and its price go with streaming.
    expect(live).toContain("mkf-pad");
    expect(live).toContain("mkf-pub");
    expect(live).not.toContain("mkf-vid");
    expect(stream).toContain("mkf-vid");
    expect(stream).not.toContain("mkf-pad");
  });

  it("the streaming price line is shown in the stream step, and quotes no figure", () => {
    const html = render("en");
    const live = html.slice(html.indexOf('id="flow-live"'), html.indexOf('id="flow-stream"'));
    const stream = html.slice(html.indexOf('id="flow-stream"'), html.indexOf('id="flow-winner"'));
    expect(stream).toContain('data-testid="flow-stream-offer"');
    expect(stream).toContain(en["home.flow.stream.offer"]);
    expect(live).not.toContain('data-testid="flow-stream-offer"');
    for (const l of LOCALES) {
      // Pack prices are not final (lib/stream-credit-packs.ts): the line may say "a coffee", never an amount.
      expect(DICTS[l]["home.flow.stream.offer"], l).toBeTruthy();
      expect(DICTS[l]["home.flow.stream.offer"], l).not.toMatch(/[$£€₹]|\d/);
    }
  });

  it("entry amounts follow the visitor's currency", () => {
    const usd = text(render("en"));
    const gbp = text(renderToStaticMarkup(<CompetitionFlow dict={en as unknown as Dict} lang="en" currency="gbp" />));
    expect(usd).toContain("$1,160");
    expect(gbp).toContain("£1,160");
    expect(gbp).not.toContain("$");
  });
});

describe("scroll state", () => {
  const tops = [-900, -500, -100, 300, 700];
  it("the current step is the last one whose top has crossed the mark", () => {
    expect(currentStep(tops, 360)).toBe(3);
    expect(currentStep(tops, 299)).toBe(2);
    expect(currentStep(tops, 300)).toBe(3);
  });
  it("before the first step and past the last, it clamps to the ends", () => {
    expect(currentStep([500, 900], 360)).toBe(0);
    expect(currentStep([-900, -500], 360)).toBe(1);
  });
  it("the mark sits a quarter down a tall viewport and never above its floor on a short one", () => {
    expect(markAt(1000)).toBe(250);
    expect(markAt(400)).toBe(150);
  });
  it("the line fills from 0 to 1 as the mark travels down a step, and never leaves that range", () => {
    expect(lineFill(400, 440, 360)).toBe(0);
    expect(lineFill(120, 440, 360)).toBeCloseTo(0.5);
    expect(lineFill(-500, 440, 360)).toBe(1);
    expect(lineFill(100, 30, 360)).toBe(1);
    expect(lineFill(400, 30, 360)).toBe(0);
  });
});
