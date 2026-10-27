// The discipline panel's Confirm, refused because the player is on no entrant of the division (422
// SUSPENSION_NO_ENTRANT — the ban could never be served). The panel's generic catch paints `err.message`, which is the
// server's ENGLISH sentence; this refusal is said from the dictionary instead, chosen off the CODE, never the prose.
//
// Driven through the hook harness (the real island, its real `decide` handler): a static render has no click. The
// harness has no provider tree, so `useMsg` reads the English catalog — which is why the "really from the dictionary,
// in four locales" half lives in `components/v2/__tests__/schedule-lock-refusal-copy.test.ts` against the dictionaries
// and this component's SOURCE.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { SUSPENSION_NO_ENTRANT_CODE } from "@/lib/suspension-no-entrant";
import enUi from "@/dictionaries/en/ui.json";
import type { Suspension } from "@/server/usecases/discipline";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

const apiV1 = vi.fn();
// `importOriginal`, not a stub class: the panel branches on `err instanceof ApiV1Error && err.code === …`, and a
// hand-rolled error class carries no `code` — the branch would be unreachable and the test would pass for the wrong reason.
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: (...args: unknown[]) => apiV1(...args) };
});

const { ApiV1Error } = await import("@/lib/client-v1");
const { DisciplinePanel } = await import("../discipline-panel");

const EN = enUi as unknown as Record<string, string>;
/** The server's own sentence, as the wire carries it — what must NOT be painted for this code. */
const SERVER_ENGLISH = "this player is on no entrant in this division, so the ban could never be served";

const PENDING: Suspension = {
  id: "s1",
  divisionId: "d1",
  personId: "p1",
  personName: "Zara Unrostered",
  entrantId: null,
  entrantName: null,
  status: "pending",
  source: "manual",
  reason: "violent conduct",
  matchesTotal: 1,
  matchesServed: 0,
  fixtureId: null,
  createdAt: "2026-10-27T00:00:00Z",
  decidedAt: null,
  triggerVoided: false,
  coveredMatches: [],
};

type PanelProps = Parameters<typeof DisciplinePanel>[0];

/** Mount the panel with one pending ban, press its Confirm, and let the refused request settle. */
async function confirmRefusedWith(err: unknown): Promise<{ text: string; calls: unknown[][] }> {
  apiV1.mockReset();
  apiV1.mockImplementation(async () => {
    throw err;
  });
  const island = renderIsland<PanelProps>((props: PanelProps) => DisciplinePanel(props), {
    divisionId: "d1",
    initial: [PENDING],
    squad: [],
    canEdit: true,
    tz: "UTC",
  });
  const confirms = island
    .tree()
    .filter((el: ReactElement) => el.type === "button" && textOf(el) === EN["disc.panel.confirm"]);
  expect(confirms, "one pending row, one Confirm").toHaveLength(1);
  (propsOf(confirms[0]!).onClick as () => void)();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { text: island.text(), calls: apiV1.mock.calls };
}

describe("DisciplinePanel — a confirm refused because the player is on no entrant", () => {
  it("says it from the dictionary, keyed on SUSPENSION_NO_ENTRANT, not the server's English sentence", async () => {
    const { text, calls } = await confirmRefusedWith(new ApiV1Error(SERVER_ENGLISH, 422, SUSPENSION_NO_ENTRANT_CODE));
    expect(calls.map((c) => [c[0], (c[1] as { json?: unknown }).json]), "the real PATCH was sent").toEqual([
      ["/api/v1/suspensions/s1", { kind: "confirm" }],
    ]);
    expect(EN["disc.panel.noEntrant"], "premise: the dictionary carries the sentence").toEqual(expect.any(String));
    expect(text).toContain(EN["disc.panel.noEntrant"]);
    expect(text, "the server's English is not painted").not.toContain(SERVER_ENGLISH);
  });

  it("positive pair: another refusal's code still shows that refusal's own message (the branch is the CODE's)", async () => {
    const other = "this sport does not track discipline";
    const { text } = await confirmRefusedWith(new ApiV1Error(other, 422, "ERROR"));
    expect(text).toContain(other);
    expect(text).not.toContain(EN["disc.panel.noEntrant"]);
  });
});
