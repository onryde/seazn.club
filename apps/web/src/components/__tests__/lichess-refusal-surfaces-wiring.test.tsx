// The WIRING of the Lichess seat-gate refusal on the two organiser screens that gained it (the mapping is
// v2/__tests__/lichess-refusal-surfaces.test.ts; a green mapping suite is blind to a screen that never calls it):
//   * the registrant hub's actions - approve, mark paid and promote each seat a registrant, so each can be refused;
//   * the CSV import wizard - the commit is refused whole, naming the file rows, and the preview stays for the retry.
// The entrants panel (add / replace a roster / sync a squad) already has its own: v2/__tests__/entrants-panel-lichess-refusal.test.tsx.
// Both screens are mounted through the hook harness (no jsdom here) and driven through the handlers a click would call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { plural as pluralRuntime, t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: nav.refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; json?: unknown }[],
  /** What the next call to a route (its last path segment) answers: an error to throw, or null for success. */
  refuse: new Map<string, { message: string; status: number; code: string; extra: Record<string, unknown> }>(),
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method ?? "GET", json: options?.json });
      const key = url.split("/").pop()!;
      const failure = net.refuse.get(key);
      if (failure) {
        net.refuse.delete(key);
        throw new actual.ApiV1Error(failure.message, failure.status, failure.code, failure.extra);
      }
      return {};
    }),
  };
});

import { RegistrationHubRegistrantActions } from "@/components/registration-hub-registrant-actions";
import { ImportWizard } from "@/components/v2/import-wizard";

beforeEach(() => {
  nav.refresh.mockClear();
  net.calls.length = 0;
  net.refuse.clear();
});
afterEach(() => vi.unstubAllGlobals());

// ---- the registrant hub ---------------------------------------------------------------------------------------------

type ActionProps = Parameters<typeof RegistrationHubRegistrantActions>[0];
const PROPS: ActionProps = {
  registrationId: "reg-1",
  status: "pending",
  approval: "manual",
  amountCents: 0,
  divisionFeeCents: 0,
  paymentIntentId: null,
  refundedCents: 0,
};
const mount = (o: Partial<ActionProps> = {}) => renderIsland(RegistrationHubRegistrantActions, { ...PROPS, ...o });
const action = (island: ReturnType<typeof mount>, name: string) =>
  island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-action"] === name);
const click = (island: ReturnType<typeof mount>, name: string) => (propsOf(action(island, name)!).onClick as () => Promise<void>)();
const feedback = (island: ReturnType<typeof mount>) => {
  const el = island.tree().find((e) => propsOf(e)["data-registration-hub-registrant-actions-feedback"] !== undefined);
  return el ? { tone: propsOf(el)["data-tone"], text: textOf(el) } : null;
};

const SERVER_LINK = "Every player must link a Lichess account before entering online play";
const SERVER_RECONNECT = "Every player must reconnect their Lichess account so Seazn can submit their moves before entering online play";

describe("the registrant hub says a Lichess refusal in the organiser's language, on every action that seats", () => {
  const doors = [
    { action: "approve", route: "approve", props: { status: "pending", approval: "manual" } },
    { action: "mark-paid", route: "mark-paid", props: { status: "pending", approval: "manual", amountCents: 1500, divisionFeeCents: 1500 } },
    { action: "promote", route: "promote", props: { status: "waitlisted", approval: "auto" } },
  ] as const;

  it("approve, mark paid and promote: LINK and RECONNECT each read as their own reason, never the server's English; the button comes back", async () => {
    let checked = 0;
    for (const door of doors) {
      for (const [code, key, serverEnglish] of [
        ["LICHESS_LINK_REQUIRED", "reg.hub.registrants.lichess.linkRequired.unnamed", SERVER_LINK],
        ["LICHESS_RECONSENT_REQUIRED", "reg.hub.registrants.lichess.reconnectRequired.unnamed", SERVER_RECONNECT],
      ] as const) {
        net.refuse.set(door.route, { message: serverEnglish, status: 422, code, extra: { person_ids: ["p-ada"] } });
        const island = mount({ ...door.props });
        await click(island, door.action);

        expect(net.calls.some((c) => c.url.endsWith(`/${door.route}`)), `premise: ${door.action} was sent`).toBe(true);
        const shown = feedback(island);
        expect(shown?.tone, `${door.action} ${code}: an error`).toBe("error");
        expect(shown?.text, `${door.action} ${code}: said from the dictionary`).toBe(t(uiEn, key));
        expect(shown?.text, `${door.action} ${code}: never the server's English`).not.toBe(serverEnglish);
        expect(action(island, door.action), `${door.action} ${code}: the organiser can try again`).toBeTruthy();
        expect(nav.refresh, `${door.action} ${code}: a refused action refreshes nothing`).not.toHaveBeenCalled();
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 3 doors x 2 reasons").toBe(6);
  });

  it("the SEQUENCE: refused, the player reconnects, the same click succeeds and the refusal is gone", async () => {
    net.refuse.set("approve", { message: SERVER_LINK, status: 422, code: "LICHESS_LINK_REQUIRED", extra: { person_ids: ["p-ada"] } });
    const island = mount({ status: "pending", approval: "manual" });
    await click(island, "approve");
    expect(feedback(island)?.text).toBe(t(uiEn, "reg.hub.registrants.lichess.linkRequired.unnamed"));

    await click(island, "approve"); // the server accepts this time
    expect(feedback(island)?.tone).toBe("success");
    expect(feedback(island)?.text).toBe(t(uiEn, "reg.hub.registrants.detail.actions.approved"));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("the other direction: any other refusal still shows the server's own message", async () => {
    net.refuse.set("promote", { message: "Division is at capacity", status: 422, code: "ERROR", extra: { person_ids: ["p-ada"] } });
    const island = mount({ status: "waitlisted", approval: "auto" });
    await click(island, "promote");
    expect(feedback(island)?.text).toBe("Division is at capacity");
  });
});

// ---- the CSV import wizard ------------------------------------------------------------------------------------------

const PREVIEW = {
  importId: "imp-1",
  filename: "roster.csv",
  rowCount: 2,
  mapping: {},
  plan: {
    ops: [{ kind: "entrant.create", ref: "e1", sourceRows: [2, 5], after: { displayName: "Ada Okonkwo" } }],
    stats: { clubs: 0, teams: 0, persons: 1, entrants: 1, rosters: 1, squads: 0 },
    issues: [],
  },
};

/** The commit answers with `commitAnswers` in order, then succeeds. */
function stubFetch(commitAnswers: { status: number; error: Record<string, unknown> }[]) {
  const commits: string[] = [];
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/v1/imports") return { ok: true, status: 200, json: async () => ({ ok: true, data: PREVIEW }) } as Response;
      if (url === `/api/v1/imports/${PREVIEW.importId}/commit`) {
        commits.push(url);
        const next = commitAnswers.shift();
        if (next) return { ok: false, status: next.status, json: async () => ({ ok: false, error: next.error }) } as unknown as Response;
        return {
          ok: true,
          status: 201,
          json: async () => ({ ok: true, data: { importId: PREVIEW.importId, stats: PREVIEW.plan.stats, divisionIds: ["div-1"] } }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return commits;
}

const mountWizard = () => renderIsland(ImportWizard, { viewerPlan: "community" });
type Island = ReturnType<typeof mountWizard>;
const wizardTree = (island: Island) => island.tree();
const commitButton = (island: Island) => wizardTree(island).find((e) => e.type === "button" && propsOf(e).className === "btn btn-primary");
const errorBanner = (island: Island) => wizardTree(island).find((e) => e.type === "p" && String(propsOf(e).className ?? "").includes("bg-red-50"));

async function mountWithPreview(): Promise<Island> {
  const island = mountWizard();
  const input = wizardTree(island).find((e) => propsOf(e).id === "import-file");
  if (!input) throw new Error("file input not found");
  const file = new File(["name\nAda Okonkwo"], "roster.csv", { type: "text/csv" });
  (propsOf(input).onChange as (e: unknown) => void)({ target: { files: [file] } });
  await vi.waitFor(() => expect(commitButton(island)).toBeTruthy());
  return island;
}
const bannerText = (island: Island) => {
  const el = errorBanner(island);
  return el ? textOf(el) : "";
};

describe("the CSV import wizard says a Lichess refusal in the organiser's language, naming the file rows", () => {
  it("LICHESS_LINK_REQUIRED then LICHESS_RECONSENT_REQUIRED: each reads as its reason with the rows the payload names; the preview stays; the retry imports", async () => {
    const commits = stubFetch([
      { status: 422, error: { code: "LICHESS_LINK_REQUIRED", message: SERVER_LINK, person_ids: [], rows: [2, 5] } },
      { status: 422, error: { code: "LICHESS_RECONSENT_REQUIRED", message: SERVER_RECONNECT, person_ids: ["p-ada"], rows: [5] } },
    ]);
    const island = await mountWithPreview();

    (propsOf(commitButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(errorBanner(island)).toBeTruthy());
    expect(bannerText(island)).toContain(pluralRuntime(uiEn, "import.lichess.linkRequired", 2, "en", { players: "2 and 5" }));
    expect(bannerText(island), "never the server's English").not.toContain("Every player must link");
    expect(commitButton(island), "the preview stays, so the same file can be imported again").toBeTruthy();

    // The SEQUENCE: refused again, for the OTHER reason and a single row - the new words replace the old.
    (propsOf(commitButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(bannerText(island)).toContain(pluralRuntime(uiEn, "import.lichess.reconnectRequired", 1, "en", { players: "5" })));
    expect(bannerText(island)).not.toContain(pluralRuntime(uiEn, "import.lichess.linkRequired", 2, "en", { players: "2 and 5" }));

    // The players have reconnected: the same click now imports, and the refusal is gone.
    (propsOf(commitButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(nav.refresh, "the third commit was accepted: the page refreshes").toHaveBeenCalledTimes(1));
    expect(errorBanner(island), "and the refusal is gone").toBeUndefined();
    expect(commits, "three commits, no re-upload").toHaveLength(3);
  });

  it("a refusal without rows says it of the file; any other error keeps the server's message", async () => {
    stubFetch([
      { status: 422, error: { code: "LICHESS_LINK_REQUIRED", message: SERVER_LINK } },
      { status: 422, error: { code: "ENTRANT_KIND_NOT_ALLOWED", message: "Online play takes individual entrants only", rows: [2] } },
    ]);
    const island = await mountWithPreview();

    (propsOf(commitButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(bannerText(island)).toContain(t(uiEn, "import.lichess.linkRequired.unnamed")));

    (propsOf(commitButton(island)!).onClick as () => void)();
    await vi.waitFor(() => expect(bannerText(island)).toContain("Online play takes individual entrants only"));
    expect(bannerText(island)).not.toContain(t(uiEn, "import.lichess.linkRequired.unnamed"));
  });
});
