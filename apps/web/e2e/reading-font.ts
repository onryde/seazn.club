// What the browser specs of the reading style share (blog posts and help articles): the serif's name, an element's
// computed type, the serif's own files, the fonts a page asked for, and the faces Chromium really drew text with.
import type { Page } from "@playwright/test";

/** The face the body asks for, as the browser names it (next/font's own family name carries it). */
export const SERIF = /Source.?Serif.?4/i;

/** The first match's computed type and hairlines. */
export const style = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { size: s.fontSize, line: parseFloat(s.lineHeight), transform: s.textTransform, family: s.fontFamily, color: s.color, weight: s.fontWeight, tracking: s.letterSpacing, top: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`, bottom: `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}` };
  });

/** The font files of the serif's faces, as this page's stylesheets declare them (the local fallback face has none). */
export const serifFiles = (page: Page) =>
  page.evaluate((serif) => {
    const files: string[] = [];
    const walk = (rules: CSSRuleList, base: string) => {
      for (const rule of rules) {
        if (rule instanceof CSSFontFaceRule && new RegExp(serif, "i").test(rule.style.getPropertyValue("font-family"))) {
          for (const m of rule.style.getPropertyValue("src").matchAll(/url\("?([^")]+)"?\)/g)) files.push(new URL(m[1]!, base).href);
        } else if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules, base);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules, sheet.href ?? location.href);
    return files;
  }, SERIF.source);

/** Every font the page asked the network for. */
export function watchFonts(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "font" || /\.(woff2?|ttf|otf)(\?|$)/.test(r.url()) || /fonts\.(googleapis|gstatic)\.com/.test(r.url())) asked.push(r.url());
  });
  return asked;
}

/**
 * The faces Chromium actually drew each of these elements' own text with (CDP `CSS.getPlatformFontsForNode`). A glyph the
 * web font lacks is drawn with a second, system face, which computed style cannot show.
 */
export async function drawnWith(page: Page, selector: string): Promise<{ nodes: number; glyphs: number; faces: Map<string, number> }> {
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector });
  const faces = new Map<string, number>();
  let nodes = 0;
  let glyphs = 0;
  for (const nodeId of nodeIds) {
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    if (fonts.length > 0) nodes++;
    for (const f of fonts) {
      const face = `${f.isCustomFont ? "web" : "system"}:${f.familyName}`;
      faces.set(face, (faces.get(face) ?? 0) + f.glyphCount);
      glyphs += f.glyphCount;
    }
  }
  await cdp.detach();
  return { nodes, glyphs, faces };
}

export const notTheSerif = (faces: Map<string, number>) => [...faces].filter(([face]) => !(face.startsWith("web:") && SERIF.test(face))).map(([face, n]) => `${face} x${n}`);
