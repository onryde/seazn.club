import { expect, type Locator, type Page, type Request } from "@playwright/test";
import { uiEn } from "./match-room-kit";
import { withDb } from "./helpers";

/**
 * The description editor's two prompts — Link, and the Sponsor / call-to-action Button — driven the way an organiser
 * drives them, for the two screens that mount the editor INSIDE their own `<form>`: the New competition form
 * (walkthrough/new-competition-form.spec.ts) and competition settings (walkthrough/settings-competition-drive.spec.ts).
 *
 * Task PEF (owner, stg, 2026-11-03): the prompts' own `<form>` sat inside the host's. Chromium stops a `submit` at
 * the nearest ancestor `<form>`, so React never saw it: Apply (or Enter) sent the prompt's fields as a GET of the page
 * (`/o/{org}/c/new?label=Register+now&url=…`) and the typed form was gone. Each step below therefore reads, in this
 * order: the prompt's effect in the editor (which is what a broken prompt never produces), then that the page is the
 * same page — same URL, same document, no navigation — then, at the end, that the host did not act either (no
 * competition created, no settings saved).
 */

/** A link put on the last words of a typed sentence, through the Link prompt and Enter. */
export const LINK = { text: "Club website", url: "https://example.org/club" } as const;
/** The sponsor button, through its prompt and the Apply button. Not the prompt's default label ("Register now"), so
 *  a label that never left the prompt cannot pass for one that was typed. */
export const CTA = { label: "Book your place", url: "https://example.com/register" } as const;

/** The link in the description's Markdown once the Link prompt applied. */
export const LINK_MD = `[${LINK.text}](${LINK.url})`;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/**
 * The sponsor button in the description's Markdown: its label, bold, linked to its URL. EITHER nesting is accepted
 * here, deliberately, and this is not the place that decides between them: the public renderer turns only
 * `**[label](url)**` (strong>a, lib/prose.ts `ctaButtons`) into the branded button, while the editor's Button tool
 * writes `[**label**](url)` (TipTap ranks the link mark outside bold), which renders as a plain bold link. That gap
 * predates task PEF and is routed to the controller in the PEF report. What THIS kit proves is that the prompt's
 * work reaches the editor's value at all — which a prompt that reloaded the page never did.
 */
export const CTA_IN_VALUE = new RegExp(
  `\\*\\*\\[${esc(CTA.label)}\\]\\(${esc(CTA.url)}\\)\\*\\*|\\[\\*\\*${esc(CTA.label)}\\*\\*\\]\\(${esc(CTA.url)}\\)`,
);

export interface PageWitness {
  /** Main-frame document requests: a form submitted natively is one; a client `router.refresh()` is not. */
  navigations: string[];
  /** Every non-GET call to the competitions API: a host form that acted on a prompt's submit is one. */
  writes: string[];
  stop(): void;
}

const SENTINEL = "__proseDialogPageKept";

/** Start watching the page, and mark this document so a reload (which a GET submission is) can be told apart. */
export async function watchPage(page: Page): Promise<PageWitness> {
  const navigations: string[] = [];
  const writes: string[] = [];
  const onRequest = (r: Request) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) navigations.push(`${r.method()} ${r.url()}`);
    const path = new URL(r.url()).pathname;
    if (/^\/api\/v1\/competitions(\/|$)/.test(path) && r.method() !== "GET") writes.push(`${r.method()} ${path}`);
  };
  page.on("request", onRequest);
  await page.evaluate((key) => {
    (window as unknown as Record<string, boolean>)[key] = true;
  }, SENTINEL);
  return { navigations, writes, stop: () => page.off("request", onRequest) };
}

/** The page is the one the organiser was typing into: the same URL (no `?label=` / `?url=`), the same document, and
 *  no navigation since {@link watchPage}. */
export async function expectPageKept(page: Page, witness: PageWitness, startUrl: string, why: string) {
  expect(page.url(), `${why}: the URL is unchanged`).toBe(startUrl);
  const search = new URL(page.url()).searchParams;
  expect([search.has("label"), search.has("url")], `${why}: no prompt field in the query`).toEqual([false, false]);
  expect(
    await page.evaluate((key) => (window as unknown as Record<string, boolean>)[key] === true, SENTINEL),
    `${why}: the same document, not a reload`,
  ).toBe(true);
  expect(witness.navigations, `${why}: no page navigation`).toEqual([]);
}

/** Select the last words typed ({@link LINK}.text), tap Link, type the URL, and press Enter in the field. */
export async function linkByEnter(page: Page, scope: Locator, editor: Locator) {
  for (let i = 0; i < LINK.text.length; i++) await page.keyboard.press("Shift+ArrowLeft");
  await scope.getByRole("button", { name: uiEn["editor.link"]!, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: uiEn["editor.link"]!, exact: true });
  await expect(dialog).toBeVisible();
  const url = dialog.getByRole("textbox", { name: uiEn["editor.linkUrl"]!, exact: true });
  await expect(url, "Link: focus opens in the prompt's field").toBeFocused();
  await url.pressSequentially(LINK.url);
  await url.press("Enter");
  await expect(dialog, "Link: Enter applies and closes the prompt").toHaveCount(0);
  await expect(editor.locator(`a[href="${LINK.url}"]`), "Link: the selected words are now the link").toHaveText(LINK.text);
  // Focus goes back to the editor (TipTap's focus() lands a frame later), so the next key is the editor's.
  await expect(editor, "Link: focus returns to the editor").toBeFocused();
}

/** Put the caret after the link, tap the Button tool, type its label and link, and tap Apply. */
export async function ctaByApply(page: Page, scope: Locator, editor: Locator) {
  // Collapse the link's selection to its end, so the button is inserted after the sentence rather than over it.
  await page.keyboard.press("ArrowRight");
  await scope.getByRole("button", { name: uiEn["editor.cta"]!, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: uiEn["editor.cta"]!, exact: true });
  await expect(dialog).toBeVisible();
  const label = dialog.getByRole("textbox", { name: uiEn["editor.buttonLabel"]!, exact: true });
  await expect(label, "Button: focus opens in the label field").toBeFocused();
  await expect(label, "Button: the prompt opens on its default label").toHaveValue(uiEn["editor.registerNow"]!);
  await label.fill("");
  await label.pressSequentially(CTA.label);
  const link = dialog.getByRole("textbox", { name: uiEn["editor.buttonLink"]!, exact: true });
  await link.fill("");
  await link.pressSequentially(CTA.url);
  await dialog.getByRole("button", { name: uiEn["editor.apply"]!, exact: true }).click();
  await expect(dialog, "Button: Apply closes the prompt").toHaveCount(0);
  const button = editor.locator(`a[href="${CTA.url}"]`);
  await expect(button, "Button: the editor holds the sponsor button").toHaveText(CTA.label);
  await expect(editor, "Button: focus returns to the editor").toBeFocused();
  // Inserted after the link, not over it.
  await expect(editor.locator(`a[href="${LINK.url}"]`), "Button: the link is still there").toHaveText(LINK.text);
}

/** Open Link and press Escape: the prompt closes and nothing in the editor changes. */
export async function escapeCloses(page: Page, scope: Locator, editor: Locator) {
  const links = await editor.locator("a[href]").count();
  await scope.getByRole("button", { name: uiEn["editor.link"]!, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: uiEn["editor.link"]!, exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog, "Escape closes the prompt").toHaveCount(0);
  expect(await editor.locator("a[href]").count(), "Escape changed nothing in the editor").toBe(links);
}

/** Competitions with this exact name in this org, read from the database — not the form, not an API echo. */
export async function competitionsNamed(orgId: string, name: string): Promise<number> {
  return withDb(async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from competitions where org_id = ${orgId} and name = ${name}`;
    return rows[0]!.n;
  });
}
