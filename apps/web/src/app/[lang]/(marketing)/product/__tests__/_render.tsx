// Shared by the product and sport page tests: render a page's server output with the real dictionaries and parts,
// and only the shell (fonts, nav, footer) stubbed. Not a test file.
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

export async function renderPage<P extends Record<string, string>>(page: (p: { params: Promise<P> }) => Promise<ReactElement>, params: P): Promise<string> {
  return renderToStaticMarkup(await page({ params: Promise.resolve(params) }));
}

/** Visible text: tags out, entities back to characters. */
export const textOf = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

export const sectionOrder = (html: string) => [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]!);

/** The page's one h1 as a reader sees it: inline markup (the accent) removed without adding spaces. */
export const h1Of = (html: string) => textOf(html.slice(html.indexOf("<h1"), html.indexOf("</h1>")).replace(/<[^>]+>/g, "")).trim();
