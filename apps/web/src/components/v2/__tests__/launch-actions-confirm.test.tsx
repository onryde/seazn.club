// The always-on confirmation on Start tournament (design 2026-09-20).
//
// Start publishes the timetable to players and flips the division to `active`,
// and division status is forward-only. Before this, `launch-actions.tsx` was
// `onClick={() => void start()}` — one tap, no warning, on the most
// irreversible action in the product.
//
// WHY THE HARNESS. `apps/web` vitest is `environment: "node"`: there is no DOM,
// so the only way to press production's own `onClick` and read what the
// component DID — which requests it fired, and when — is the hook dispatcher
// shim in `_hook-harness`. Each of these reds against the pre-change component,
// which POSTed /start on the first tap and mounted no confirmation at all.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { Dict, Locale } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import {
  COMPETITION_STATUS_START_PROMOTES_FROM,
  COMPETITION_STATUS_START_PROMOTES_TO,
} from "@/lib/start-promotes-competition";
import type { BoardFixture } from "../board/types";

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, push: nav.push, replace: nav.replace }),
  usePathname: () => "/o/acme/c/champs/d/u12",
}));

/** Every request the island made. */
const net = vi.hoisted(() => ({ calls: [] as { url: string; method?: string; json?: unknown }[] }));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      return Promise.resolve({ generated: 0 });
    },
  };
});

import { LaunchActions } from "../launch-actions";
import { StartConfirmDialog } from "../start-confirm-dialog";

const enDict = en as unknown as Dict;
const DICTS: Record<string, Dict> = {
  en: en as unknown as Dict,
  es: es as unknown as Dict,
  fr: fr as unknown as Dict,
  nl: nl as unknown as Dict,
};

const FIXTURES = [
  {
    id: "f1",
    stage_id: "s1",
    division_id: "d1",
    round_no: 1,
    seq_in_round: 1,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    scheduled_at: "2026-08-01T09:00:00.000Z",
    venue: null,
    court_label: "Court 1",
    status: "scheduled",
    schedule_source: "manual",
    schedule_locked: false,
    outcome: null,
  },
] as unknown as BoardFixture[];

type LaunchProps = Parameters<typeof LaunchActions>[0];

const baseProps = (over: Partial<LaunchProps> = {}): LaunchProps => ({
  divisionId: "d1",
  orgSlug: "acme",
  compSlug: "champs",
  divSlug: "u12",
  status: "scheduled",
  canEdit: true,
  fixtures: FIXTURES,
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  stageKinds: ["league"],
  competitionStatus: "published",
  competitionVisibility: "public",
  viewerPlan: "community",
  ...over,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const withTestId = (tree: ReactElement[], id: string): ReactElement => {
  const el = tree.find((node) => propsOf(node)["data-testid"] === id);
  if (!el) throw new Error(`nothing rendered with data-testid="${id}"`);
  return el;
};

/** The confirmation's props — LaunchActions' own output, one level deep. */
const confirmProps = (tree: ReactElement[]) => {
  const el = tree.find((node) => node.type === StartConfirmDialog);
  if (!el) throw new Error("the launch actions mount no start confirmation");
  return propsOf(el) as Parameters<typeof StartConfirmDialog>[0];
};

const pressStart = async (island: { tree: () => ReactElement[] }) => {
  await (propsOf(withTestId(island.tree(), "launch-start-division")).onClick as () => void)();
  await flush();
};

/** Copy as it lands in the markup — "a stage's first match" carries an
 *  apostrophe, and `renderToStaticMarkup` escapes it. A bare `toContain` on the
 *  dictionary value passes on the two sentences without one and silently never
 *  checks the third. */
const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;");

const renderDialog = (props: Parameters<typeof StartConfirmDialog>[0], locale = "en") =>
  renderToStaticMarkup(
    <DictProvider locale={locale as Locale} dict={DICTS[locale]!}>
      <StartConfirmDialog {...props} />
    </DictProvider>,
  );

beforeEach(() => {
  net.calls.length = 0;
  nav.refresh.mockClear();
  nav.push.mockClear();
});

describe("Start tournament confirms first", () => {
  it("blocks the POST until the organiser confirms", async () => {
    const island = renderIsland(LaunchActions, baseProps());

    await pressStart(island);

    // THE GUARD. Tapping Start starts nothing at all.
    expect(net.calls).toEqual([]);
    const opened = confirmProps(island.tree());
    expect(opened.open).toBe(true);

    opened.onConfirm();
    await flush();

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe("/api/v1/divisions/d1/start");
    // Still no body — /start parses an absent one as `{}`, and every existing
    // key client POSTs it with none.
    expect(net.calls[0]!.json).toBeUndefined();
    expect(confirmProps(island.tree()).open).toBe(false);
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("Cancel fires no request at all", async () => {
    const island = renderIsland(LaunchActions, baseProps());

    await pressStart(island);
    confirmProps(island.tree()).onCancel();
    await flush();

    expect(confirmProps(island.tree()).open).toBe(false);
    expect(net.calls).toEqual([]);
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("omits the entrants line for an open-format division", async () => {
    // `enrollEntrants` exempts the WHOLE division when ANY stage is a ladder
    // or americano, so the mixed case is exempt too — the line would be false
    // there, and a dialog that lies once is not read again.
    const closed = renderIsland(LaunchActions, baseProps({ stageKinds: ["league", "knockout"] }));
    await pressStart(closed);
    const closedProps = confirmProps(closed.tree());
    expect(closedProps.entrantsLock).toBe(true);
    const closedHtml = renderDialog(closedProps);
    expect(closedHtml).toContain(esc(enDict["launch.confirm.entrants"] as string));
    expect(closedHtml).toContain('data-testid="start-confirm-entrants"');

    for (const stageKinds of [["ladder"], ["americano"], ["knockout", "ladder"]]) {
      const open = renderIsland(LaunchActions, baseProps({ stageKinds }));
      await pressStart(open);
      const html = renderDialog(confirmProps(open.tree()));
      expect(html, `stages ${stageKinds.join("+")}`).not.toContain(
        esc(enDict["launch.confirm.entrants"] as string),
      );
      expect(html, `stages ${stageKinds.join("+")}`).not.toContain(
        'data-testid="start-confirm-entrants"',
      );
      // The other two consequences still stand — the carve-out is one line.
      // `baseProps` carries one fixture, so the format line is the LOCKED form.
      expect(html).toContain(esc(enDict["launch.confirm.format"] as string));
      expect(html).toContain(esc(enDict["launch.confirm.rules"] as string));
    }
  });

  it("names the competition promotion only when the competition is published", async () => {
    // `startDivision` promotes the parent competition with
    // `... where id = $1 and status = 'published'` — so the line is true for
    // exactly one status and false for the other four. Omitted, never
    // softened, for the same reason the entrants line is: a dialog that lies
    // once is not read again.
    const published = renderIsland(LaunchActions, baseProps({ competitionStatus: "published" }));
    await pressStart(published);
    const publishedProps = confirmProps(published.tree());
    expect(publishedProps.competitionPromotes).toBe(true);
    const publishedHtml = renderDialog(publishedProps);
    expect(publishedHtml).toContain(esc(enDict["launch.confirm.competition"] as string));
    expect(publishedHtml).toContain('data-testid="start-confirm-competition"');

    for (const competitionStatus of ["draft", "live", "completed", "archived"]) {
      const island = renderIsland(LaunchActions, baseProps({ competitionStatus }));
      await pressStart(island);
      const props = confirmProps(island.tree());
      expect(props.competitionPromotes, competitionStatus).toBe(false);
      const html = renderDialog(props);
      expect(html, competitionStatus).not.toContain(esc(enDict["launch.confirm.competition"] as string));
      expect(html, competitionStatus).not.toContain('data-testid="start-confirm-competition"');
      // The rest of the dialog is untouched by the carve-out — one line.
      expect(html, competitionStatus).toContain(esc(enDict["launch.confirm.entrants"] as string));
      expect(html, competitionStatus).toContain(esc(enDict["launch.confirm.format"] as string));
      expect(html, competitionStatus).toContain('data-testid="start-confirm-format-locked"');
      expect(html, competitionStatus).toContain(esc(enDict["launch.confirm.rules"] as string));
    }
  });

  it("says nothing about the competition becoming visible, because it does not", async () => {
    // PUBLIC_DASHBOARD_STATUSES is ["published","live"], and every listing
    // surface excludes only DRAFTS (V419) — published and live alike — so a
    // published -> live move changes nothing anyone can see. The promotion
    // line states the status move and stops there.
    const island = renderIsland(LaunchActions, baseProps({ competitionStatus: "published" }));
    await pressStart(island);
    const html = renderDialog(confirmProps(island.tree()));
    // Read the sentence back OUT of the rendered markup, not out of the JSON:
    // the claim under test is what the organiser is shown.
    const rendered = /<li data-testid="start-confirm-competition">([^<]*)<\/li>/.exec(html);
    expect(rendered, "the promotion line did not render").not.toBeNull();
    const line = rendered![1]!.toLowerCase();
    for (const claim of ["visible", "discover", "public", "players", "anyone"]) {
      expect(line, claim).not.toContain(claim);
    }
    // Non-vacuity: the sentence does name both ends of the move it claims.
    expect(line).toContain(COMPETITION_STATUS_START_PROMOTES_FROM);
    expect(line).toContain(COMPETITION_STATUS_START_PROMOTES_TO);
  });

  it("carries the promotion line in all four locales, translated", async () => {
    // Not a key-presence check on the JSON: a key that exists but never
    // reaches the markup, or one that renders English in every locale, passes
    // that and fails the organiser. This renders the real dialog under each
    // locale's real dictionary and reads the sentence out of the HTML.
    const island = renderIsland(LaunchActions, baseProps({ competitionStatus: "published" }));
    await pressStart(island);
    const props = confirmProps(island.tree());
    const english = enDict["launch.confirm.competition"] as string;

    for (const locale of ["en", "es", "fr", "nl"]) {
      const line = DICTS[locale]!["launch.confirm.competition"] as string | undefined;
      expect(line, `${locale} is missing launch.confirm.competition`).toBeTruthy();
      expect(typeof line, locale).toBe("string");
      const html = renderDialog(props, locale);
      expect(html, locale).toContain(esc(line!));
      expect(html, locale).toContain('data-testid="start-confirm-competition"');
      // The three non-English locales must not be shipping the English
      // sentence — the failure mode a parity check cannot see.
      if (locale !== "en") expect(line, locale).not.toBe(english);
    }
  });

  it("does not claim the format is already locked when no fixtures exist", async () => {
    // THE regression, found by driving the product on 2026-09-20: this dialog
    // said "The format is already locked — fixtures exist" on a division whose
    // own page, directly behind it, read "No fixtures yet — generate them when
    // entrants are registered" and offered a Generate fixtures button. On the
    // quick-start path `/start` is what GENERATES the fixtures, so at the
    // moment the dialog renders there are none and nothing is locked.
    //
    // Unlike the entrants and competition lines, this one is REPLACED rather
    // than omitted: the format does lock, a moment later, and the organiser is
    // owed that fact in both states.
    const empty = renderIsland(LaunchActions, baseProps({ fixtures: [] }));
    await pressStart(empty);
    const emptyProps = confirmProps(empty.tree());
    expect(emptyProps.formatLocked).toBe(false);
    const emptyHtml = renderDialog(emptyProps);
    expect(emptyHtml, "the false claim must be gone").not.toContain(
      esc(enDict["launch.confirm.format"] as string),
    );
    expect(emptyHtml).not.toContain('data-testid="start-confirm-format-locked"');
    expect(emptyHtml, "and the truthful one must be there — not silence").toContain(
      esc(enDict["launch.confirm.formatLocksNow"] as string),
    );
    expect(emptyHtml).toContain('data-testid="start-confirm-format-locks"');

    // The positive pair: one fixture is all it takes, because the server's
    // guard has no status or stage filter.
    const one = renderIsland(LaunchActions, baseProps({ fixtures: FIXTURES }));
    await pressStart(one);
    const oneProps = confirmProps(one.tree());
    expect(oneProps.formatLocked).toBe(true);
    const oneHtml = renderDialog(oneProps);
    expect(oneHtml).toContain(esc(enDict["launch.confirm.format"] as string));
    expect(oneHtml).toContain('data-testid="start-confirm-format-locked"');
    expect(oneHtml).not.toContain(esc(enDict["launch.confirm.formatLocksNow"] as string));

    // Exactly one format line either way — never both, never none.
    for (const html of [emptyHtml, oneHtml]) {
      expect((html.match(/start-confirm-format-/g) ?? []).length).toBe(1);
    }
  });

  it("ships the not-yet-locked line in all four locales", async () => {
    // Same bar the other conditional lines are held to: a key present only in
    // English renders English to a Spanish organiser, and no unit test that
    // reads only `en` can see it.
    const island = renderIsland(LaunchActions, baseProps({ fixtures: [] }));
    await pressStart(island);
    const props = confirmProps(island.tree());
    const english = enDict["launch.confirm.formatLocksNow"] as string;
    for (const locale of ["en", "es", "fr", "nl"]) {
      const line = DICTS[locale]!["launch.confirm.formatLocksNow"] as string | undefined;
      expect(line, `${locale} is missing the key`).toBeTruthy();
      const html = renderDialog(props, locale);
      expect(html, locale).toContain(esc(line!));
      if (locale !== "en") expect(line, locale).not.toBe(english);
    }
  });

  it("states the consequences, and offers a live confirm", async () => {
    // Non-vacuity for the two above: a dialog that rendered an empty body, or
    // one whose confirm control was disabled into decoration, would satisfy
    // "the POST was blocked" and strand the organiser.
    const island = renderIsland(LaunchActions, baseProps());
    await pressStart(island);
    const html = renderDialog(confirmProps(island.tree()));

    expect(html).toContain(esc(enDict["launch.confirm.title"] as string));
    expect(html).toContain(esc(enDict["launch.confirm.lead"] as string));
    expect(html).toContain('data-testid="start-confirm-confirm"');
    expect(html).toContain('data-testid="start-confirm-cancel"');
    expect(html).not.toContain("disabled");
    // Nothing about conflicts: that is the reactive gate dialog's job, and an
    // advisory copy here could only go stale between showing and committing.
    expect(html.toLowerCase()).not.toContain("conflict");
  });
});

// Owner decision 2026-09-27: a draft is unlisted until published, and nothing
// publishes it for the organiser — `startDivision` promotes published → live
// only, so a draft STAYS a draft through Start. The organiser is starting the
// tournament believing it is out in the world; this is where they are told it
// is not. A one-line note with the way to publish, shown exactly when
// publishing would list it (a PUBLIC draft): for a private or unlisted draft
// "until you publish" is false, publishing lists neither.
describe("Start tournament — the still-a-draft note", () => {
  const NOTE = "launch.confirm.draft";
  const LINK = "launch.confirm.draftLink";
  const SETTINGS = "/o/acme/c/champs/settings";

  const dialogFor = async (over: Partial<LaunchProps>) => {
    const island = renderIsland(LaunchActions, baseProps(over));
    await pressStart(island);
    return confirmProps(island.tree());
  };

  it("premise: the note and its link are real English copy", () => {
    expect(enDict[NOTE], NOTE).toBeTruthy();
    expect(enDict[LINK], LINK).toBeTruthy();
  });

  it("a PUBLIC DRAFT: the dialog says it is still a draft and links to where it is published", async () => {
    const props = await dialogFor({ competitionStatus: "draft", competitionVisibility: "public" });
    expect(props.unlistedDraft).toBe(true);
    expect(props.settingsHref).toBe(SETTINGS);
    const html = renderDialog(props);
    expect(html).toContain('data-testid="start-confirm-draft"');
    expect(html).toContain(esc(enDict[NOTE] as string));
    expect(html).toContain(`href="${SETTINGS}"`);
    expect(html).toContain(esc(enDict[LINK] as string));
  });

  it("a PUBLISHED competition: no note, no link — the other half of the pair", async () => {
    const props = await dialogFor({ competitionStatus: "published", competitionVisibility: "public" });
    expect(props.unlistedDraft).toBe(false);
    const html = renderDialog(props);
    expect(html).not.toContain('data-testid="start-confirm-draft"');
    expect(html).not.toContain(esc(enDict[NOTE] as string));
    expect(html).not.toContain(`href="${SETTINGS}"`);
  });

  it("no note once past draft (live, completed, archived), nor on a private or unlisted draft", async () => {
    for (const competitionStatus of ["live", "completed", "archived"]) {
      const props = await dialogFor({ competitionStatus, competitionVisibility: "public" });
      expect(props.unlistedDraft, competitionStatus).toBe(false);
      expect(renderDialog(props), competitionStatus).not.toContain('data-testid="start-confirm-draft"');
    }
    for (const competitionVisibility of ["private", "unlisted"]) {
      const props = await dialogFor({ competitionStatus: "draft", competitionVisibility });
      expect(props.unlistedDraft, competitionVisibility).toBe(false);
      expect(renderDialog(props), competitionVisibility).not.toContain('data-testid="start-confirm-draft"');
    }
  });

  it("the note sits outside the consequences list — it is not something Start does", async () => {
    const html = renderDialog(await dialogFor({ competitionStatus: "draft", competitionVisibility: "public" }));
    const list = /<ul[^>]*data-testid="start-confirm-consequences"[^>]*>([\s\S]*?)<\/ul>/.exec(html);
    expect(list, "the consequences list rendered").not.toBeNull();
    expect(list![1]).not.toContain("start-confirm-draft");
    expect(html).toContain('data-testid="start-confirm-draft"');
  });

  it("carries the note and its link in all four locales, translated", async () => {
    const props = await dialogFor({ competitionStatus: "draft", competitionVisibility: "public" });
    for (const locale of ["en", "es", "fr", "nl"]) {
      const html = renderDialog(props, locale);
      for (const key of [NOTE, LINK]) {
        const line = DICTS[locale]![key] as string | undefined;
        expect(line, `${locale} is missing ${key}`).toBeTruthy();
        expect(html, `${locale} ${key}`).toContain(esc(line!));
        if (locale !== "en") expect(line, `${locale} ${key}`).not.toBe(enDict[key]);
      }
    }
  });
});
