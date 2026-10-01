// Creating a competition as an organiser does (Task 5). Product facts, read
// at Step 0:
//  - /o/<org>/c/new (routes.ts:26; the brief's "/competitions/new" is not a
//    route) renders the template gallery; `template-start-blank`
//    (template-gallery.tsx:564-565) switches it to the blank CompetitionWizard.
//  - competition-wizard.tsx: the name input's placeholder is
//    comp.wizard.name.placeholder (:184); Ends on is a date field labelled
//    `${msg("comp.wizard.endsOn")} *` (:244), required (:74); the visibility
//    picker (:203; ui/visibility-picker.tsx) is a radio per option inside its
//    <label>, "unlisted" labelled visibility.unlisted.label; submit is the
//    comp.wizard.create button (:265-266), disabled until a name is typed.
//  - Submit POSTs /api/v1/competitions with no slug (:84-98): the PRODUCT picks
//    the slug, so the caller reads it from the answer. On success it
//    router.push(routes.competition(org, created.slug)) (:117).
import type { FromTemplateAnswer } from "../../driver/types.ts";
import { actAndAwait } from "../respond.ts";
import { DATA, NAME, TESTID, templateCardTestid } from "../selectors.ts";
import { actBudget, awaitScreen, navBudget, shoot, visit, type PageCtx } from "./ctx.ts";
import { paths } from "./paths.ts";

/** The day HttpDriver's own create sends (http-driver.ts:96; pinned). */
export const COMPETITION_ENDS_ON = "2030-12-31";

/** The product's Competition row (api-v1 schemas.ts Competition). */
export interface CompetitionOut { id: string; org_id: string; name: string; slug: string; visibility: string; status: string }

/** Creates the competition through the wizard, Unlisted as HttpDriver creates
 *  it (public reads work, and the public-dashboard cap cannot degrade it). The
 *  answer is the product's own row — the DRIVER checks its org and its
 *  applied visibility (OrgMismatch, VisibilityDegraded), as HttpDriver does. */
export async function createCompetitionUi(c: PageCtx, input: { name: string }): Promise<CompetitionOut> {
  const { page } = c;
  const t = actBudget(c, 1);
  const startBlank = page.getByTestId(TESTID.templateStartBlank.id);
  await visit(c, paths.competitionNew(c.orgSlug), { control: startBlank, what: "the competition wizard's Start blank" });
  await startBlank.click({ timeout: t });
  await page.getByPlaceholder(NAME.competitionNamePlaceholder.text, { exact: true }).fill(input.name, { timeout: t });
  await page.getByLabel(NAME.endsOn.text, { exact: true }).fill(COMPETITION_ENDS_ON, { timeout: t });
  // check() on the option's <label> checks its radio and throws unless it ends checked.
  await page.locator("label").filter({ has: page.getByText(NAME.visibilityUnlisted.text, { exact: true }) }).check({ timeout: t });
  const before = await shoot(c, "01-competition-created-before");
  const { data } = await actAndAwait<CompetitionOut>(page, { method: "POST", path: /^\/api\/v1\/competitions$/ },
    () => page.getByRole("button", { name: NAME.createCompetition.text, exact: true }).click({ timeout: t }), t);
  const landing = paths.competition(c.orgSlug, data.slug);
  const nav = navBudget(c);
  await awaitScreen(() => page.waitForURL((u) => u.pathname === landing, { timeout: nav }), `the new competition's page ${landing}`, nav);
  await shoot(c, "01-competition-created", before);
  return data;
}

/** W1-driving Task 13 (ruling 47): a catalog template's competition, division
 *  and stages, through its gallery card — ONE organiser act. Product facts,
 *  read at Step 0 (template-gallery.tsx):
 *  - /o/<org>/c/new renders the gallery; each card is a button with
 *    `template-card-<key>` (:242) that opens the template's detail sheet;
 *  - the sheet's form (`template-detail-form`, :429) holds the name
 *    (comp.wizard.name.label, pre-filled from the template) and the required
 *    Ends on (the decorated `${msg("comp.wizard.endsOn")} *`, :458); "Use this
 *    template" (`template-detail-submit`, :421) sits in the modal footer and
 *    submits that form;
 *  - the submit POSTs /api/v1/competitions/from-template with no visibility
 *    (:305-321). On success it router.push()es to the competition; on a
 *    public-dashboard degrade it opens the degrade modal and STAYS on /c/new
 *    (:323-330) — so there is no landing to wait for, and the driver's
 *    read-back refuses the visibility (HttpDriver.readBackTemplate).
 *  The answer is the product's own (FromTemplateResult). */
export async function createFromTemplateUi(c: PageCtx, key: string, input: { name: string; endsOn: string }): Promise<FromTemplateAnswer> {
  // Refuses an unknown or unsafe key by name before any navigation.
  const cardId = templateCardTestid(key);
  const { page } = c;
  const t = actBudget(c, 1);
  const card = page.getByTestId(cardId);
  await visit(c, paths.competitionNew(c.orgSlug), { control: card, what: `the template gallery's ${key} card` });
  await card.click({ timeout: t });
  const form = page.locator(DATA.templateDetailForm.selector);
  await form.getByLabel(NAME.templateName.text, { exact: true }).fill(input.name, { timeout: t });
  await form.getByLabel(NAME.templateEndsOn.text, { exact: true }).fill(input.endsOn, { timeout: t });
  const before = await shoot(c, "01-competition-from-template-before");
  const { data } = await actAndAwait<FromTemplateAnswer>(page, { method: "POST", path: /^\/api\/v1\/competitions\/from-template$/ },
    () => page.getByTestId(TESTID.templateDetailSubmit.id).click({ timeout: t }), t);
  if (data.public_quota_degraded !== undefined) {
    await shoot(c, "01-competition-from-template-degraded", before);
    return data;
  }
  const landing = paths.competition(c.orgSlug, data.slug);
  const nav = navBudget(c);
  await awaitScreen(() => page.waitForURL((u) => u.pathname === landing, { timeout: nav }), `the new competition's page ${landing}`, nav);
  await shoot(c, "01-competition-from-template", before);
  return data;
}
