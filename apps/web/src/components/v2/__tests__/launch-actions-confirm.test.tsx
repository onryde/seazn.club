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
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
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

const renderDialog = (props: Parameters<typeof StartConfirmDialog>[0]) =>
  renderToStaticMarkup(
    <DictProvider locale={"en" as Locale} dict={enDict}>
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
      expect(html).toContain(esc(enDict["launch.confirm.format"] as string));
      expect(html).toContain(esc(enDict["launch.confirm.rules"] as string));
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
