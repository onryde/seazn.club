import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { PROD_TARGET, TAG, apiJson, withDb } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import { waitForHydration } from "./directory-kit";

/** A dictionary file, read from the source the page and the server render from: copy and subjects are never retyped
 *  here (the `readFileSync` shape of walkthrough/scheduling-officials-handoff.spec.ts: Playwright's loader supplies no
 *  JSON import attribute). */
function dictionary(locale: string, ns: string): Record<string, string> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/${ns}.json`, import.meta.url)), "utf8"),
  ) as Record<string, string>;
}
const EMAILS_EN = dictionary("en", "emails");
const EMAILS_FR = dictionary("fr", "emails");
const MARKETING = { en: dictionary("en", "marketing"), fr: dictionary("fr", "marketing") } as const;
const UI_EN = dictionary("en", "ui");

/** A dictionary value, or a red that names the missing key (a locator or a comparison built from `undefined` fails
 *  somewhere unhelpful). Called inside a test body, never at module scope, so a missing key is a red test rather than
 *  zero collected ones. */
function need(dict: Record<string, string>, key: string, file: string): string {
  const v = dict[key];
  if (v === undefined) throw new Error(`${file} is missing key "${key}" this spec depends on`);
  return v;
}
/** An en `ui` line with its `{name}` slots filled; a missing slot throws rather than reading "{n}". */
function ui(key: string, vars: Record<string, string | number> = {}): string {
  return need(UI_EN, key, "en/ui.json").replace(/\{(\w+)\}/g, (_, slot: string) => {
    if (!Object.hasOwn(vars, slot)) throw new Error(`"${key}" needs {${slot}}`);
    return String(vars[slot]);
  });
}

/**
 * The claim email went through the email outbox: ONE `funnel_claim` row for the newest draft the start stored for
 * `email` (read back by the visitor's address, since the response does not name the draft). Its first attempt was
 * made in the request, so it is no longer waiting and holds no body (no Resend key: `dead`; one that can send:
 * `sent`), and its subject is `subject`.
 */
async function expectOneClaimEmail(email: string, subject: string): Promise<void> {
  const mail = await withDb(async (sql) => {
    const [draft] = await sql<{ id: string }[]>`
      select id from funnel_drafts where email = ${email} order by created_at desc limit 1`;
    expect(draft, `the start stored no draft for ${email}`).toBeTruthy();
    return sql<{ status: string; hasBody: boolean; subject: string }[]>`
      select status, body_sealed is not null as "hasBody", subject
        from email_outbox
       where kind = 'funnel_claim' and ref_type = 'funnel_draft' and ref_id = ${draft!.id}`;
  });
  expect(mail, "one claim email for the draft").toHaveLength(1);
  expect(["queued", "sending"], "the claim email's first attempt was made in the request").not.toContain(
    mail[0]!.status,
  );
  expect(mail[0]!.hasBody, "no body is left on the row after its attempt").toBe(false);
  expect(mail[0]!.subject).toBe(subject);
}

// PROMPT-36 (v3/07 §6), rebuilt by the start wizard redesign (plan 2026-11-13, Task 6): the /start funnel end-to-end. A
// fresh anonymous visitor answers the four questions (B1 Sport, B2 Size and format, B3 Date, B4 Email), gets the Sent
// screen (A4), and the emailed claim link lands them signed in inside the competition it built — the format's stages and,
// when they opened Planning, the courts. No entrant: the field size chosen is the getting-started target, and the organiser
// adds the real names (/start "Sent stepper", owner 2026-11-14). Fresh context per test: the funnel must never depend on a
// session.

// ── the visitor's browser and the wizard ──────────────────────────────────────────────────────────────────────────

/** A page load or a redirect followed; a click, a fill or a read. A test's budget is built from these (AGENTS.md #20). */
const NAV_MS = 20_000;
const ACT_MS = 3_000;

/** No session and the cookie banner already answered (it would sit over the wizard's Next on a short screen). No
 *  `seazn_locale` cookie either: the page's own language is the only one the French case can be in. */
async function visitor(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: await consentedAnonymousState() });
}

type Locale = keyof typeof MARKETING;
type QuestionStep = "sport" | "size" | "date" | "email";

function wizardOf(page: Page, locale: Locale) {
  const mk = (key: string): string => need(MARKETING[locale], key, `${locale}/marketing.json`);
  const root = page.locator("[data-start-wizard]");
  return {
    page,
    root,
    mk,
    next: (): Locator => root.getByRole("button", { name: `${mk("start.wizard.next")} →`, exact: true }),
    send: (): Locator => root.getByRole("button", { name: `${mk("start.wizard.emailMe")} →`, exact: true }),
    field: (labelKey: string): Locator => root.getByRole("textbox", { name: mk(labelKey), exact: true }),
    email: (): Locator => root.getByLabel(mk("start.wizard.email"), { exact: true }),
    card: (slug: string): Locator => root.locator(`[data-format-card="${slug}"]`),
    format: (slug: string): Locator => root.locator(`input[name="format"][value="${slug}"]`),
  };
}
type Wizard = ReturnType<typeof wizardOf>;

/** Next, and the step it lands on: the wizard says which (`data-step`), and focus moves to that step's question, worded by
 *  the dictionary (review-t4 m4: a screen reader hears where it is). */
async function advance(w: Wizard, step: Exclude<QuestionStep, "sport">): Promise<void> {
  await w.next().click();
  await expectAt(w, step);
}
async function expectAt(w: Wizard, step: QuestionStep): Promise<void> {
  await expect(w.root).toHaveAttribute("data-step", step);
  const question = w.root.locator("#start-q");
  await expect(question).toHaveText(w.mk(`start.wizard.q.${step}`));
  await expect(question, `focus moves to the ${step} question`).toBeFocused();
}
/** Send, and the Sent screen: the check-your-email heading takes focus. */
async function sendAndExpectSent(w: Wizard): Promise<void> {
  await w.send().click();
  await expect(w.root).toHaveAttribute("data-step", "sent", { timeout: NAV_MS });
  const heading = w.root.locator("[data-funnel-done] h2");
  await expect(heading).toHaveText(w.mk("start.wizard.checkEmail"));
  await expect(heading, "focus moves to the Sent heading").toBeFocused();
}

/** The Sent screen's reference line: the draft's own SZ- reference (the email prints the same), worded by the dictionary.
 *  Returns it. */
async function sentReference(w: Wizard, email: string): Promise<string> {
  const line = w.root.locator("[data-funnel-reference]");
  await expect(line).toBeVisible();
  const reference = (await line.getAttribute("data-funnel-reference")) ?? "";
  expect(reference, "an SZ- reference: six symbols, no 0/O/1/I").toMatch(/^SZ-[2-9A-HJ-NP-Z]{6}$/);
  await expect(line).toHaveText(w.mk("start.wizard.reference").replace("{reference}", reference));
  const stored = await withDb((sql) => sql<{ reference: string }[]>`
    select reference from funnel_drafts where email = ${email} order by created_at desc limit 1`);
  expect(stored[0]?.reference, "the reference shown is the newest draft's own").toBe(reference);
  return reference;
}

/** The getting-started steps on screen (the Sent screen's or the landing's), as [key, state, aria-current]. */
const stepStates = (steps: Locator): Promise<(string | null)[][]> =>
  steps.evaluateAll((els) =>
    els.map((el) => [el.getAttribute("data-step-key"), el.getAttribute("data-step-state"), el.getAttribute("aria-current")]),
  );
/** A day as the steps word it: the locale's short weekday, day and month (UTC: the event's calendar day). */
const enDay = (iso: string): string =>
  new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

/** The format cards on screen, in the order they are shown. */
const cardOrder = (w: Wizard): Promise<(string | null)[]> =>
  w.root.locator("[data-format-card]").evaluateAll((els) => els.map((el) => el.getAttribute("data-format-card")));

/** The four fixed cards (plan D2: never reordered under the thumb; Double elimination waits behind "More formats"). */
const FIXED_CARDS = ["league", "groups-knockout", "knockout", "swiss"];

/** The UTC calendar day `k` days from now: the test's own calendar, never the wizard's arithmetic. */
const utcDayPlus = (k: number): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + k)).toISOString().slice(0, 10);
};

// ── the claim and what it built ───────────────────────────────────────────────────────────────────────────────────

/** The newest draft's claim path for `email`. The token is the draft's own column (single-use, lib/funnel.ts), so the
 *  claim runs on a production target too, which emails the link instead of showing it; where a dev server shows the link,
 *  it must be this same token. */
async function draftToken(email: string): Promise<string> {
  const token = await withDb(async (sql) => {
    const [d] = await sql<{ token: string }[]>`
      select token from funnel_drafts where email = ${email} order by created_at desc limit 1`;
    return d?.token;
  });
  expect(token, `the start stored a draft for ${email}`).toBeTruthy();
  return token!;
}
async function claimPathFor(page: Page, email: string): Promise<string> {
  const token = await draftToken(email);
  const dev = page.locator("[data-claim-url]");
  if (!PROD_TARGET) await expect(dev, "a dev server shows the claim link on the Sent screen").toBeVisible();
  if ((await dev.count()) > 0) {
    const shown = new URL((await dev.getAttribute("data-claim-url"))!, "http://x").searchParams.get("token");
    expect(shown, "the link the Sent screen shows is the draft's own").toBe(token);
  }
  return `/start/claim?token=${token}`;
}

/** Open the claim link and land where it sends a new organiser: the division's entrants tab. Returns that path. */
async function claimAndLand(page: Page, claimPath: string): Promise<string> {
  await page.goto(claimPath);
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/[^/?]+\?tab=entrants/, { timeout: 30_000 });
  return new URL(page.url()).pathname;
}

interface Built {
  sportKey: string;
  variantKey: string;
  startsOn: string | null;
  endsOn: string | null;
  stages: { id: string; kind: string }[];
  entrants: { seed: number | null; kind: string; display_name: string }[];
  venues: number;
  courts: string[];
  courtHours: number;
}

/** What the claim built, read back from the division the landing path names. */
async function builtAt(divisionPath: string): Promise<Built> {
  const m = /^\/o\/([^/]+)\/c\/([^/]+)\/d\/([^/?]+)/.exec(divisionPath);
  expect(m, `a division path: ${divisionPath}`).not.toBeNull();
  const [, org, comp, div] = m!;
  return withDb(async (sql) => {
    const [d] = await sql<{ id: string; org_id: string; sport_key: string; variant_key: string; starts_on: string | null; ends_on: string | null }[]>`
      select d.id, o.id as org_id, d.sport_key, d.variant_key, c.starts_on::text, c.ends_on::text
        from divisions d
        join competitions c on c.id = d.competition_id
        join organizations o on o.id = c.org_id
       where o.slug = ${org} and c.slug = ${comp} and d.slug = ${div}`;
    expect(d, `the database holds the division ${divisionPath}`).toBeTruthy();
    const stages = await sql<{ id: string; kind: string }[]>`select id, kind from stages where division_id = ${d!.id} order by seq`;
    const entrants = await sql<{ seed: number | null; kind: string; display_name: string }[]>`
      select seed, kind, display_name from entrants where division_id = ${d!.id} order by seed nulls last, id`;
    const [{ venues }] = await sql<{ venues: number }[]>`
      select count(*)::int as venues from venues where org_id = ${d!.org_id} and archived_at is null`;
    const courts = await sql<{ name: string }[]>`
      select c.name from courts c join venues v on v.id = c.venue_id
       where c.org_id = ${d!.org_id} and c.archived_at is null and v.archived_at is null order by c.sort, c.name`;
    const [{ courtHours }] = await sql<{ courtHours: number }[]>`
      select count(*)::int as "courtHours" from court_hours where org_id = ${d!.org_id}`;
    return {
      sportKey: d!.sport_key,
      variantKey: d!.variant_key,
      startsOn: d!.starts_on,
      endsOn: d!.ends_on,
      stages: [...stages],
      entrants: [...entrants],
      venues,
      courts: courts.map((c) => c.name),
      courtHours,
    };
  });
}

/** The field size the claim recorded as the target, read off the draft that built the competition the landing path names
 *  (V518 `funnel_drafts.competition_id`). */
async function targetOf(divisionPath: string): Promise<number | null> {
  const [, org, comp] = /^\/o\/([^/]+)\/c\/([^/]+)/.exec(divisionPath) ?? [];
  return withDb(async (sql) => {
    const [row] = await sql<{ entrants: number | null }[]>`
      select (f.payload->>'entrants')::int as entrants
        from funnel_drafts f
        join competitions c on c.id = f.competition_id
        join organizations o on o.id = c.org_id
       where o.slug = ${org ?? ""} and c.slug = ${comp ?? ""}`;
    return row?.entrants ?? null;
  });
}

// ── the cases ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("wizard → claim: the division holds the chosen format and the courts from Planning, and no entrant", async ({ browser }) => {
  // Six page loads or redirects (the start, the claim and its landing, fixtures, venues, the dead link) and ~40 acts.
  test.setTimeout(6 * NAV_MS + 40 * ACT_MS);
  const ENTRANTS = 12;
  const COURTS = 4;
  const HOURS = 6;
  const ctx = await visitor(browser);
  const page = await ctx.newPage();
  const name = `Funnel E2E ${TAG}`;
  const email = `delivered+e2e-funnel-${TAG}@resend.dev`;
  try {
    // B1, opened the way /play's and the hero's doors open it: the sport by its KEY.
    await page.goto("/en/start?sport=football");
    const w = wizardOf(page, "en");
    await expect(w.root).toHaveAttribute("data-step", "sport");
    await waitForHydration(w.next());
    await expect(w.root.getByRole("radio", { name: ui("sport.football"), exact: true }), "the link's sport is chosen").toBeChecked();
    await expect(w.root.locator('input[name="sport"]:checked'), "and it is the only one").toHaveCount(1);
    await w.root.getByRole("textbox", { name: w.mk("start.wizard.compName") }).fill(name);
    await advance(w, "size");

    // B2: the size, Planning opened with its courts and hours, a format picked.
    const field = w.field("start.wizard.entrants");
    await field.fill(String(ENTRANTS));
    await expect(field).toHaveValue(String(ENTRANTS));
    const fold = w.root.locator('button[aria-controls="start-planning"]');
    await expect(fold, "Planning starts closed").toHaveAttribute("aria-expanded", "false");
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await w.field("start.wizard.courts").fill(String(COURTS));
    await w.field("start.wizard.hours").fill(String(HOURS));
    expect(await cardOrder(w), "the four fixed cards, in their fixed order").toEqual(FIXED_CARDS);
    // A Best fit badge, where there is one, is on a card that fits (D3); never more than one.
    const badges = w.root.locator("[data-best-fit]");
    expect(await badges.count(), "at most one Best fit").toBeLessThanOrEqual(1);
    for (const slug of FIXED_CARDS) {
      if ((await w.card(slug).locator("[data-best-fit]").count()) > 0) {
        await expect(w.card(slug), `the badged ${slug} card fits`).toContainText(w.mk("start.wizard.fits"));
      }
    }
    await w.card("groups-knockout").click();
    await expect(w.format("groups-knockout")).toBeChecked();
    await advance(w, "date");

    // B3: the first chip, which the calendar says is the next Saturday.
    const firstChip = w.root.locator('input[name="date"]').first();
    const saturday = (await firstChip.getAttribute("value"))!;
    expect(new Date(`${saturday}T00:00:00Z`).getUTCDay(), `the first chip (${saturday}) is a Saturday`).toBe(6);
    expect(saturday > utcDayPlus(0) && saturday <= utcDayPlus(7), `${saturday} is in the coming week`).toBe(true);
    // `has` is queried INSIDE each label, so it is a bare selector (a locator chained from the wizard's root never matches).
    const saturdayChip = page.locator(`input[name="date"][value="${saturday}"]`);
    await w.root.locator("label").filter({ has: saturdayChip }).click();
    await expect(firstChip).toBeChecked();
    await advance(w, "email");

    // B4: the summary of what will be built, then the address.
    const summary = w.root.locator("dl");
    await expect(summary).toContainText(ui("sport.football"));
    await expect(summary).toContainText(ui("format.template.groups_ko.label"));
    await expect(summary).toContainText(String(ENTRANTS));
    await w.email().fill(email);
    await sendAndExpectSent(w);

    // Sent (mock sss14a Option A): the draft's reference beside the address, the summary ending on the page's language, and
    // the five steps ahead — the first current, step 3 counting the field chosen, step 5 the courts and the day picked.
    await sentReference(w, email);
    await expect(w.root.locator("dl")).toContainText(w.mk("start.wizard.language"));
    await expect(w.root.locator("dl")).toContainText("English");
    const ahead = w.root.locator("[data-getting-started-steps] > li");
    expect(await stepStates(ahead), "step 1 is current, the rest wait").toEqual([
      ["open", "current", "step"],
      ["rename", "todo", null],
      ["players", "todo", null],
      ["generate", "todo", null],
      ["schedule", "todo", null],
    ]);
    await expect(ahead.nth(2)).toContainText(ui("start.next.players.hint", { target: ENTRANTS }));
    await expect(ahead.nth(4)).toContainText(
      ui("start.next.schedule.courtsDate", { courts: ui("start.next.courts.other", { count: COURTS }), date: enDay(saturday) }),
    );

    // The answers ride the URL (a refresh restores them, T4 (a)) — and never the address or the name: PostHog and Sentry
    // record page URLs. Every key is read, so a new one cannot slip in; the positive half proves the URL is written at all.
    const href = page.url();
    expect(Object.fromEntries(new URL(href).searchParams), "the URL carries the answers, keyed as /start reads them").toEqual({
      sport: "football",
      entrants: String(ENTRANTS),
      format: "groups-knockout",
      date: saturday,
      courts: String(COURTS),
      hours: String(HOURS),
      step: "email",
    });
    for (const secret of [email, encodeURIComponent(email), "delivered", encodeURIComponent(name), TAG]) {
      expect(href, `the URL never carries ${secret}`).not.toContain(secret);
    }

    // The English page's claim email, in English.
    await expectOneClaimEmail(email, need(EMAILS_EN, "funnelClaim.subject", "en/emails.json").replaceAll("{competitionName}", name));

    // The single link signs in AND builds org + competition + division + what was chosen.
    const claimPath = await claimPathFor(page, email);
    const landed = await claimAndLand(page, claimPath);
    await expect(page.locator("body")).toContainText(name);

    const built = await builtAt(landed);
    expect(built.sportKey, "the division is the link's sport").toBe("football");
    // The rulebook's shape of a groups + knockout: a group stage, then its knockout (plan T2 table).
    expect(built.stages.map((s) => s.kind), "the format's stage graph").toEqual(["group", "knockout"]);
    expect(built.entrants, "no placeholder entrant: the organiser adds the real names").toEqual([]);
    expect(await targetOf(landed), "the size chosen is the draft's, stamped with the competition it built").toBe(ENTRANTS);
    expect(built.venues, "Planning's courts make one venue").toBe(1);
    expect(built.courts).toEqual(Array.from({ length: COURTS }, (_, i) => ui("funnel.claim.court", { n: i + 1 })));
    expect(built.courtHours, "the hours shaped only the estimate (D1)").toBe(0);
    expect([built.startsOn, built.endsOn], "a one-day event on the chosen Saturday (D5)").toEqual([saturday, saturday]);

    // …and the organiser sees it. The entrants tab (where the claim lands, its name already shown above): no entrant row.
    await expect(page.getByTestId("entrant-row-disclosure"), "no placeholder row on the entrants tab").toHaveCount(0);
    // The fixtures tab holds the stage cards: one per stage, in the order the database seqs them.
    await page.goto(`${landed}?tab=fixtures`);
    const cards = page.locator("section.card[data-stage-id]");
    await expect(cards).toHaveCount(built.stages.length);
    expect(await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-stage-id")))).toEqual(built.stages.map((s) => s.id));
    // The venues directory: one row per court, each named by the dictionary.
    await page.goto("/directory?tab=venues");
    const courtNames = page.locator(`input[aria-label="${ui("venues.court.editName")}"]`);
    await expect(courtNames).toHaveCount(COURTS);
    expect(await courtNames.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))).toEqual(built.courts);

    // Single-use: revisiting the link fails cleanly with a way forward.
    await page.goto(claimPath);
    await expect(page.locator("[data-funnel-claim]")).toContainText(ui("funnel.claim.card.invalidTitle"), { timeout: NAV_MS });
  } finally {
    await ctx.close();
  }
});

test("Change email keeps every answer and resends under the same reference; the first link says it was replaced; the landing carries the steps on", async ({ browser }) => {
  // Seven page loads or redirects (the start, the dead link, the claim and its landing, settings, two reloads) and ~60 acts.
  test.setTimeout(7 * NAV_MS + 60 * ACT_MS);
  const ENTRANTS = 8;
  const ctx = await visitor(browser);
  const page = await ctx.newPage();
  const first = `delivered+e2e-funnel-change-a-${TAG}@resend.dev`;
  const second = `delivered+e2e-funnel-change-b-${TAG}@resend.dev`;
  // The replace key the route answers: read off the wire, to prove it never reaches the URL.
  const keys: string[] = [];
  page.on("response", async (r) => {
    if (r.request().method() === "POST" && new URL(r.url()).pathname === "/api/funnel/start") {
      const body = (await r.json().catch(() => null)) as { data?: { replaceKey?: string } } | null;
      if (body?.data?.replaceKey) keys.push(body.data.replaceKey);
    }
  });
  try {
    // A link that carries the answers opens on Email (the URL replays to it): 8 players, a League, no first day.
    await page.goto(`/en/start?sport=badminton&entrants=${ENTRANTS}&format=league&step=email`);
    const w = wizardOf(page, "en");
    await expect(w.root).toHaveAttribute("data-step", "email");
    await waitForHydration(w.send());
    await w.email().fill(first);
    await sendAndExpectSent(w);
    const reference = await sentReference(w, first);
    await expect(w.root).toContainText(w.mk("start.wizard.referenceNote"));
    const answers = new URL(page.url()).search;

    // "Change it": Email again, every answer kept, the old address ready to edit, the banner naming the reference that stays.
    await w.root.getByRole("button", { name: w.mk("start.wizard.changeIt"), exact: true }).click();
    await expectAt(w, "email");
    await expect(w.root.locator("[data-change-email]")).toHaveText(w.mk("start.wizard.changeBanner").replace("{reference}", reference));
    await expect(w.root).toContainText(w.mk("start.wizard.answersKept"));
    await expect(w.email(), "the address sent to, ready to edit").toHaveValue(first);
    expect(new URL(page.url()).search, "the answers in the URL are the ones sent").toBe(answers);
    await expect(w.root.locator("dl")).toContainText(ui("format.template.league.label"));
    await expect(w.root.locator("dl")).toContainText(String(ENTRANTS));
    await expect(w.send(), "the first-time label is gone").toHaveCount(0);
    await w.email().fill(second);
    await w.root.getByRole("button", { name: `${w.mk("start.wizard.sendNew")} →`, exact: true }).click();
    await expect(w.root).toHaveAttribute("data-step", "sent", { timeout: NAV_MS });
    await expect(w.root.locator("[data-funnel-done]")).toContainText(second);
    expect(await sentReference(w, second), "the reference in the inbox stays").toBe(reference);
    await expect(w.root).toContainText(w.mk("start.wizard.resentNote"));
    expect(keys, "both starts answered a replace key").toHaveLength(2);
    for (const secret of [first, second, encodeURIComponent(first), encodeURIComponent(second), ...keys]) {
      expect(page.url(), "the URL never carries an address or a replace key").not.toContain(secret);
    }
    const drafts = await withDb((sql) => sql<{ email: string; live: boolean; reference: string }[]>`
      select email, (replaced_at is null) as live, reference from funnel_drafts
       where email in (${first}, ${second}) order by created_at, id`);
    expect(drafts, "the first address's draft is replaced; the new address holds the one live draft").toEqual([
      { email: first, live: false, reference },
      { email: second, live: true, reference },
    ]);

    // The first email's link: replaced, and it names the reference to look for.
    await page.goto(`/start/claim?token=${await draftToken(first)}`);
    const card = page.locator("[data-funnel-claim]");
    await expect(card).toContainText(ui("funnel.claim.card.replacedTitle"), { timeout: NAV_MS });
    await expect(card).toContainText(reference);

    // The newest link lands on the division, the steps carried on: step 1 ticked, rename current with its way on.
    const landed = await claimAndLand(page, `/start/claim?token=${await draftToken(second)}`);
    const panel = page.locator("[data-getting-started]");
    const steps = panel.locator("[data-getting-started-steps] > li");
    await expect(panel).toBeVisible();
    expect(await stepStates(steps)).toEqual([
      ["open", "done", null],
      ["rename", "current", "step"],
      ["players", "todo", null],
      ["generate", "todo", null],
      ["schedule", "todo", null],
    ]);
    await expect(panel).toContainText(ui("start.next.landing.done", { done: 1, total: 5 }));
    await expect(steps.nth(2), "the list starts empty").toContainText(ui("start.next.players.progress", { count: 0, target: ENTRANTS }));
    await expect(panel.locator("[data-step-action]"), "only the current step has a way on").toHaveCount(1);
    const orgSlug = /^\/o\/([^/]+)\//.exec(landed)![1]!;
    const rename = panel.locator('[data-step-action="rename"]');
    await expect(rename).toHaveText(ui("start.next.action.rename"));
    await expect(rename).toHaveAttribute("href", `/o/${orgSlug}/settings`);
    await rename.click();
    await page.waitForURL((u) => u.pathname === `/o/${orgSlug}/settings`, { timeout: NAV_MS });
    await expect(page.getByTestId("org-name-input"), "the way on opens the organisation's name").toBeVisible({ timeout: NAV_MS });

    // Renamed through the card the way on opened: its one Save sends the name, the slug regenerates, and the tab follows.
    const ids = await withDb((sql) => sql<{ org: string; division: string }[]>`
      select o.id as org, d.id as division from divisions d
        join competitions c on c.id = d.competition_id join organizations o on o.id = c.org_id
       where o.slug = ${orgSlug} order by d.created_at limit 1`);
    await page.getByTestId("org-name-input").fill(`Riverside Club ${TAG}`);
    const patch = page.waitForResponse((r) => r.url().includes(`/api/orgs/${ids[0]!.org}`) && r.request().method() === "PATCH");
    await page.getByTestId("org-profile-card").getByRole("button", { name: ui("settings.org.saveChanges"), exact: true }).click();
    expect((await patch).status(), "the rename PATCH").toBe(200);
    const [org] = await withDb((sql) => sql<{ slug: string }[]>`select slug from organizations where id = ${ids[0]!.org}`);
    expect(org!.slug, "the rename moved the slug").not.toBe(orgSlug);
    await page.waitForURL((u) => u.pathname === `/o/${org!.slug}/settings`, { timeout: NAV_MS });

    // The OLD landing URL (the claim email's, a bookmark) keeps its division and its tab under the new slug (review I3):
    // it used to land on the org's dashboard. And the steps there have moved on: renamed, so adding players is current.
    const relanded = landed.replace(`/o/${orgSlug}/`, `/o/${org!.slug}/`);
    await page.goto(`${landed}?tab=entrants`);
    await page.waitForURL((u) => u.pathname === relanded && u.searchParams.get("tab") === "entrants", { timeout: NAV_MS });
    await expect(panel).toBeVisible({ timeout: NAV_MS });
    expect(await stepStates(steps)).toEqual([
      ["open", "done", null],
      ["rename", "done", null],
      ["players", "current", "step"],
      ["generate", "todo", null],
      ["schedule", "todo", null],
    ]);
    await expect(panel).toContainText(ui("start.next.landing.done", { done: 2, total: 5 }));
    const addPlayers = panel.locator('[data-step-action="players"]');
    await expect(addPlayers).toHaveText(ui("start.next.action.players"));
    await expect(addPlayers).toHaveAttribute("href", `${relanded}?tab=entrants#add-entrant`);

    // The field filled to the size chosen: Generate is current.
    const added = await apiJson(
      page.request,
      `/api/v1/divisions/${ids[0]!.division}/entrants`,
      "POST",
      Array.from({ length: ENTRANTS }, (_, i) => ({ kind: "individual", display_name: `Player ${String.fromCharCode(65 + i)} ${TAG}` })),
    );
    expect(added.status, JSON.stringify(added.error)).toBe(201);
    await page.goto(relanded);
    await expect(panel).toBeVisible({ timeout: NAV_MS });
    expect(await stepStates(steps)).toEqual([
      ["open", "done", null],
      ["rename", "done", null],
      ["players", "done", null],
      ["generate", "current", "step"],
      ["schedule", "todo", null],
    ]);
    await expect(panel).toContainText(ui("start.next.landing.done", { done: 3, total: 5 }));
    await expect(steps.nth(2)).toContainText(ui("start.next.players.progress", { count: ENTRANTS, target: ENTRANTS }));
    const generate = panel.locator('[data-step-action="generate"]');
    await expect(generate).toHaveText(ui("start.next.action.generate"));
    await expect(generate).toHaveAttribute("href", /\/o\/[^/]+\/c\/[^/]+\/d\/[^/?]+\?tab=fixtures$/);
    await generate.click();
    await page.waitForURL((u) => u.searchParams.get("tab") === "fixtures", { timeout: NAV_MS });
    await expect(page.locator("section.card[data-stage-id]"), "the fixtures tab, where Generate lives").toHaveCount(1);
  } finally {
    await ctx.close();
  }
});

test("nothing fits: no Best fit and nothing picked, League still offered; a refresh keeps the answers; a size that fits badges only the richest", async ({ browser }) => {
  test.setTimeout(2 * NAV_MS + 30 * ACT_MS);
  const ctx = await visitor(browser);
  const page = await ctx.newPage();
  try {
    await page.goto("/en/start");
    const w = wizardOf(page, "en");
    await waitForHydration(w.next());
    await advance(w, "size");

    // 40 players on the cards' default 2 courts and 4 hours (Planning closed): nothing fits.
    await w.field("start.wizard.entrants").fill("40");
    await expect(w.root.locator('button[aria-controls="start-planning"]')).toHaveAttribute("aria-expanded", "false");
    expect(await cardOrder(w)).toEqual(FIXED_CARDS);
    await expect(w.root.locator("[data-best-fit]"), "nothing fits: no Best fit").toHaveCount(0);
    // What "nothing fits" means on screen: every card that can be built says Runs over, and none says Fits.
    let over = 0;
    for (const slug of FIXED_CARDS) {
      await expect(w.card(slug), `${slug} does not fit`).not.toContainText(w.mk("start.wizard.fits"));
      if (await w.format(slug).isEnabled()) {
        await expect(w.card(slug)).toContainText(w.mk("start.wizard.runsOver"));
        over++;
      }
    }
    expect(over, "anti-vacuity: the cards that can be built were read").toBeGreaterThan(0);
    await expect(w.root.locator('input[name="format"]:checked'), "nothing picked for them").toHaveCount(0);
    await expect(w.next(), "Next waits for a pick").toBeDisabled();
    // League is always offered (D3) and picking it is enough to go on.
    await expect(w.format("league")).toBeEnabled();
    await w.card("league").click();
    await expect(w.format("league")).toBeChecked();
    await expect(w.next()).toBeEnabled();

    // A refresh keeps the answers: the step, the size and the pick come back from the URL.
    await page.reload();
    await expect(w.root).toHaveAttribute("data-step", "size");
    await waitForHydration(w.next());
    await expect(w.field("start.wizard.entrants")).toHaveValue("40");
    await expect(w.format("league"), "the pick survives the refresh").toBeChecked();
    await expect(w.root.locator("[data-best-fit]")).toHaveCount(0);
    await expect(w.next()).toBeEnabled();

    // A size that fits (the mock's A2: 12 players, 4 courts, 6 hours — League runs over; groups + knockout, knockout and
    // Swiss fit; Swiss gives each player the most matches): exactly one badge, on Swiss.
    await w.field("start.wizard.entrants").fill("12");
    await w.root.locator('button[aria-controls="start-planning"]').click();
    await w.field("start.wizard.courts").fill("4");
    await w.field("start.wizard.hours").fill("6");
    await expect(w.root.locator("[data-best-fit]")).toHaveCount(1);
    await expect(w.card("swiss").locator("[data-best-fit]"), "Best fit is the richest card that fits").toHaveCount(1);
    await expect(w.card("swiss")).toContainText(w.mk("start.wizard.fits"));
    await expect(w.card("league")).toContainText(w.mk("start.wizard.runsOver"));
    // The organiser's own pick sticks: the badge moved, the selection did not.
    await expect(w.format("league")).toBeChecked();
  } finally {
    await ctx.close();
  }
});

test("a bad address is refused in place: the line says what is missing and nothing is sent", async ({ browser }) => {
  test.setTimeout(2 * NAV_MS + 15 * ACT_MS);
  const ctx = await visitor(browser);
  const page = await ctx.newPage();
  let starts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/funnel/start") starts++;
  });
  try {
    // A link that carries the answers opens on its step (T4 (a): the URL replays to it).
    await page.goto("/en/start?sport=badminton&entrants=8&format=league&step=email");
    const w = wizardOf(page, "en");
    await expect(w.root).toHaveAttribute("data-step", "email");
    await waitForHydration(w.send());
    const email = w.email();
    const error = w.root.locator("#start-email-error");

    await email.fill("sam@harbourvale");
    await w.send().click();
    await expect(error, "the missing ending is named").toHaveText(w.mk("start.wizard.emailMissingTld"));
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email, "focus goes back to the address").toBeFocused();
    await email.fill("x");
    await w.send().click();
    await expect(error).toHaveText(w.mk("start.wizard.emailInvalid"));
    await expect(w.root).toHaveAttribute("data-step", "email");
    expect(starts, "a refused address sends nothing").toBe(0);

    // The positive half: a real address sends exactly once, so the counter above can count.
    await email.fill(`delivered+e2e-funnel-addr-${TAG}@resend.dev`);
    await expect(error).toHaveCount(0);
    await sendAndExpectSent(w);
    expect(starts, "one start for one good address").toBe(1);
  } finally {
    await ctx.close();
  }
});

test("a claim whose first day has passed says so, builds nothing, and starts again on its sport", async ({ browser }) => {
  test.setTimeout(3 * NAV_MS + 10 * ACT_MS);
  const ctx = await visitor(browser);
  const page = await ctx.newPage();
  const name = `Funnel Late ${TAG}`;
  const email = `delivered+e2e-funnel-late-${TAG}@resend.dev`;
  try {
    // A draft started a month ago (the start takes any day; the claim decides): its sport is Tennis, not /start's own
    // default, so a Start again that dropped the sport would open on the wrong one.
    const started = await page.request.post("/api/funnel/start", {
      data: { email, locale: "en", name, sport: "Tennis", entrants: 6, start_date: utcDayPlus(-30) },
    });
    expect(started.status(), "the start stores the draft").toBe(200);
    // An API start renders no Sent screen, so there is no shown link to compare: the draft's token alone.
    await page.goto(`/start/claim?token=${await draftToken(email)}`);
    const card = page.locator("[data-funnel-claim]");
    await expect(card).toContainText(ui("funnel.claim.card.datePast"), { timeout: NAV_MS });
    const again = card.getByRole("link", { name: ui("funnel.claim.card.startAgain"), exact: true });
    await expect(again).toHaveAttribute("href", "/en/start?sport=tennis");
    const comps = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from competitions where name = ${name}`);
    expect(comps[0]!.n, "nothing was built").toBe(0);

    await again.click();
    await page.waitForURL((u) => u.pathname === "/en/start" && u.searchParams.get("sport") === "tennis", { timeout: NAV_MS });
    const w = wizardOf(page, "en");
    await expect(w.root.getByRole("radio", { name: ui("sport.tennis"), exact: true }), "the fresh start is on the draft's sport").toBeChecked();
  } finally {
    await ctx.close();
  }
});

/**
 * The claim email is in the language the /start page was SHOWN in (D4's explicit pick): the wizard sends the
 * locale it rendered in, and the route uses it before the `seazn_locale` cookie. Driven through the real wizard,
 * because the request field is the seam: the route's own tests post it by hand and cannot see the client drop it.
 *
 * `/fr/start` with NO `seazn_locale` cookie and the browser's English Accept-Language, so the URL's `fr` is the
 * only French source: a wizard that stopped sending its locale, or a route that ignored it, lands on `en`. The
 * premise that the two subjects differ keeps that failure visible.
 *
 * Needs no dev claim link (it stops at the Sent screen), so it runs on production targets and in CI too.
 */
test("a start from the French page queues the claim email in French", async ({ browser }) => {
  test.setTimeout(2 * NAV_MS + 20 * ACT_MS);
  const enSubject = need(EMAILS_EN, "funnelClaim.subject", "en/emails.json");
  const frSubject = need(EMAILS_FR, "funnelClaim.subject", "fr/emails.json");
  expect(frSubject, "premise: the French subject differs from the English one").not.toBe(enSubject);

  const ctx = await visitor(browser);
  const page = await ctx.newPage();
  const name = `Funnel FR ${TAG}`;
  const email = `delivered+e2e-funnel-fr-${TAG}@resend.dev`;
  try {
    // The legacy link shape (the sport by its sports-table NAME, a size): /start still reads it.
    await page.goto("/fr/start?sport=Badminton&entrants=8");
    const w = wizardOf(page, "fr");
    await expect(w.root).toHaveAttribute("data-step", "sport");
    await waitForHydration(w.next());
    await w.root.getByRole("textbox", { name: w.mk("start.wizard.compName") }).fill(name);
    await advance(w, "size");
    await expect(w.field("start.wizard.entrants")).toHaveValue("8");
    await w.card("league").click();
    await advance(w, "date");
    await advance(w, "email");
    await w.email().fill(email);

    expect(
      (await ctx.cookies()).filter((c) => c.name === "seazn_locale"),
      "premise: no seazn_locale cookie, so only the page's own language can make the email French",
    ).toEqual([]);
    await sendAndExpectSent(w);

    await expectOneClaimEmail(email, frSubject.replaceAll("{competitionName}", name));
  } finally {
    await ctx.close();
  }
});

/**
 * The +24 h reminder through the REAL cron route (email outbox phase 3 wave 5): a draft the visitor never claims, aged 25 h
 * in SQL (the route's due filter is `created_at < now() - 24 h`), is claimed by `POST /api/funnel/remind` and gets ONE
 * `funnel_reminder` row about it — left to the worker (`queued`: a cron has no one waiting, so no attempt in the request),
 * transactional, addressed to the visitor's address and to no account (there is none yet). A second run finds the draft
 * stamped and queues nothing more.
 *
 * The start names `fr`, and the draft remembers it (P-W5-17), so the reminder's subject is the French one: the premise that
 * it differs from the English subject keeps a reminder that fell back to `en` visible. API only (no dev claim link), so it
 * runs on production targets and in CI.
 */
test("a day-old draft gets one queued reminder from the cron route, and a second run adds none", async ({ request }) => {
  const enSubject = need(EMAILS_EN, "funnelReminder.subject", "en/emails.json");
  const frSubject = need(EMAILS_FR, "funnelReminder.subject", "fr/emails.json");
  expect(frSubject, "premise: the French reminder subject differs from the English one").not.toBe(enSubject);
  // The route answers 503 without a secret on the server, and the header needs the same value here: the job sets it once.
  const cronSecret = process.env.CRON_SECRET;
  expect(cronSecret, "the e2e job must set CRON_SECRET (one value for the server and this runner)").toBeTruthy();

  const name = `Funnel Remind ${TAG}`;
  const email = `delivered+e2e-funnel-remind-${TAG}@resend.dev`;
  const started = await request.post("/api/funnel/start", {
    data: { email, locale: "fr", name, sport: "Badminton", entrants: 8 },
  });
  expect(started.status(), "the start stores the draft").toBe(200);

  const draftId = await withDb(async (sql) => {
    const [draft] = await sql<{ id: string; locale: string | null }[]>`
      select id, locale from funnel_drafts where email = ${email} order by created_at desc limit 1`;
    expect(draft, `the start stored no draft for ${email}`).toBeTruthy();
    expect(draft!.locale, "premise: the draft remembers the language the start named").toBe("fr");
    await sql`update funnel_drafts set created_at = now() - interval '25 hours' where id = ${draft!.id}`;
    return draft!.id;
  });

  const reminders = () =>
    withDb((sql) =>
      sql<
        { status: string; transactional: boolean; recipient: string; recipient_user_id: string | null; subject: string }[]
      >`
        select status, transactional, recipient, recipient_user_id, subject
          from email_outbox
         where kind = 'funnel_reminder' and ref_type = 'funnel_draft' and ref_id = ${draftId}`,
    );
  const remind = () => request.post("/api/funnel/remind", { headers: { "x-cron-secret": cronSecret! } });

  const first = await remind();
  expect(first.status(), "the cron route runs with the job's secret").toBe(200);
  const firstBody = (await first.json()) as { data?: { sent?: number } };
  expect(firstBody.data?.sent ?? 0, "the run queued at least this draft's reminder").toBeGreaterThanOrEqual(1);
  const rows = await reminders();
  expect(rows, "one funnel_reminder row for the draft").toHaveLength(1);
  expect(rows[0]).toEqual({
    status: "queued",
    transactional: true,
    recipient: email,
    recipient_user_id: null,
    subject: frSubject.replaceAll("{competitionName}", name),
  });

  // The draft is stamped: a second run (the next cron tick, or a second scheduler) adds nothing.
  const second = await remind();
  expect(second.status(), "a second cron run answers 200").toBe(200);
  expect(await reminders(), "a second run queues no second reminder").toHaveLength(1);
});
