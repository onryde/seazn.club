// Seazn-hosted video Task 26: the organiser's Delete on a Seazn replay part, through the REAL container (`PhoneTab`, driven with
// `renderIsland` and a doubled v1 transport and house confirm) — the seam from the panel's hook (useSeaznReplayActions) to the route
// and back to the session view's own read. The card's drawing and the flow's steps are seazn-replays-card.test.tsx's; this file proves
// the CONTAINER wires them: the body hands the card the hook's state, a "yes" sends the DELETE and re-reads `current`, a "no" sends
// nothing, a refusal is the row's failure. A sibling of fixture-stream-panel.test.tsx (459 KB; its harness is private to it).
// `apps/web` vitest is `environment: "node"`: the tap and the dialog are the e2e's (e2e/walkthrough/seazn-hosted.spec.ts).
//
// Sport: not applicable — the Phone tab's replay card reads no sport.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderIsland, propsOf } from "@/components/__tests__/_hook-harness";
import { defaultTemplateFor } from "@/components/overlay/template-registry";
import { messages, type MessageKey } from "@/lib/messages";
import type { StreamPhone, StreamSessionCurrent } from "@/server/api-v1/schemas";
import type { StreamSessionView } from "@/lib/stream-session-view";
import type { ConfirmOptions } from "@/components/ui/confirm-provider";
import { PhoneTab, PhoneTabBody, type PhoneScore, type PhoneTabBodyProps } from "@/components/v2/fixture-stream-panel";

const apiV1 = vi.fn<(url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>>(async () => ({}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: (url: string, options?: { method?: string; json?: unknown }) => apiV1(url, options),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/div",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/billing-checkout-client", () => ({ fetchRelayCheckoutClientSecret: vi.fn() }));
const confirm = vi.hoisted(() => ({ answer: true, asked: [] as unknown[] }));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async (o: unknown) => {
    confirm.asked.push(o);
    return confirm.answer;
  },
}));
vi.mock("@/lib/seazn-qr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seazn-qr")>()),
  renderSeaznQr: async () => ({ src: "data:image/svg+xml;charset=utf-8,x", modules: 57 }),
}));
const provided = vi.hoisted(() => ({ view: null as StreamSessionView | null }));
vi.mock("@/components/v2/stream-session-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/v2/stream-session-provider")>()),
  useProvidedPhoneSession: () => (provided.view === null ? null : { view: provided.view }),
}));

type Replay = StreamSessionCurrent["seaznReplays"][number];
const m = (k: MessageKey, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce((s, [k2, v]) => s.replace(`{${k2}}`, String(v)), messages[k] as string);
const SCORE_OFF: PhoneScore = {
  available: false, stored: null, template: defaultTemplateFor("football"), delayMs: null, sportKey: "football", editor: null,
  modeFailed: false, onMode: () => {},
};
const TAB = { fixtureId: "f-1", orgId: "o-1", streamBalance: 3, streamSplit: null, monthlyAllowance: 0, currency: "eur" as const, phoneLostMinutes: 20, autoStopMinutes: 3, pasteCodeShown: true, tz: "Europe/London", score: SCORE_OFF };
const CURRENT = "GET /api/v1/fixtures/f-1/stream-sessions/current";
const PHONE = "GET /api/v1/fixtures/f-1/stream-phone";
const TARGETS_URL = "GET /api/v1/orgs/o-1/stream-targets";
const PART: Replay = { id: "00000000-0000-4000-8000-000000000002", partNo: 2, state: "playable", lengthSeconds: 60, onMatchPage: true };
const DELETE_PART = `DELETE /api/v1/fixtures/f-1/replays/${PART.id}`;

const phoneRead = (): StreamPhone => ({
  code: { issuedAt: "2026-09-14T11:00:00.000Z", state: "active", endCause: null },
  phone: null, destination: null, lastTakeover: null, auto: null, legacy: false, finished: false, session: null, court: null,
} as unknown as StreamPhone);

function serve(o: { refuseDelete?: boolean } = {}) {
  apiV1.mockImplementation(async (url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    const key = `${options?.method ?? "GET"} ${url}`;
    if (key === CURRENT) return null;
    if (key === PHONE) return structuredClone(phoneRead());
    if (key === TARGETS_URL) return [];
    if (key === DELETE_PART) {
      if (o.refuseDelete) throw Object.assign(new Error("replay not found"), { status: 404 });
      return { deleted: true };
    }
    throw new Error(`unrouted ${key}`);
  });
}
const calls = (): string[] => apiV1.mock.calls.map(([url, o]) => `${o?.method ?? "GET"} ${url}`);
const count = (key: string): number => calls().filter((c) => c === key).length;
const settle = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1); };
const bodyOf = (island: { tree: () => ReactElement[] }): PhoneTabBodyProps => {
  const el = island.tree().find((e) => e.type === PhoneTabBody);
  if (!el) throw new Error("no PhoneTabBody in the container's tree");
  return propsOf(el) as unknown as PhoneTabBodyProps;
};
let islands: { unmount: () => void }[] = [];
async function mount(o: { refuseDelete?: boolean } = {}) {
  serve(o);
  const island = renderIsland(PhoneTab, TAB);
  islands.push(island);
  await settle();
  return island;
}

beforeEach(() => { vi.useFakeTimers(); apiV1.mockReset(); islands = []; confirm.answer = true; confirm.asked = []; provided.view = null; });
afterEach(() => { for (const i of islands) i.unmount(); vi.useRealTimers(); });

describe("Task 26: the panel's Delete, through the real container", () => {
  it("EMPTY CASE FIRST: before any delete the body hands the card an idle state — nothing deleting, nothing failed, nothing gone", async () => {
    const island = await mount();
    const a = bodyOf(island).replayActions;
    expect({ deleting: a.deleting, failed: a.failed, gone: [...a.gone] }).toEqual({ deleting: null, failed: null, gone: [] });
    expect(typeof a.onDelete).toBe("function");
    expect(calls().filter((c) => c.startsWith("DELETE")), "nothing sent on mount").toEqual([]);
  });

  it("the organiser says NO: the house confirm was asked (danger tone, touch size, the dictionary's words) and nothing is sent", async () => {
    const island = await mount();
    confirm.answer = false;
    const reads = count(CURRENT);
    bodyOf(island).replayActions.onDelete(PART, true);
    await settle();
    expect(confirm.asked).toEqual([{
      title: m("stream.replay.deletePartTitle", { n: 2 }),
      body: m("stream.replay.deleteConfirm"),
      confirmLabel: m("stream.replay.delete"),
      cancelLabel: m("stream.replay.deleteKeep"),
      tone: "danger",
      size: "touch",
    } satisfies ConfirmOptions]);
    expect(count(DELETE_PART)).toBe(0);
    expect(count(CURRENT), "and nothing is re-read").toBe(reads);
    expect(bodyOf(island).replayActions.gone.size).toBe(0);
  });

  it("the organiser says YES: ONE DELETE to the part's route, then the session view's own read of `current`; the part is gone at once and nothing is left deleting", async () => {
    const island = await mount();
    const reads = count(CURRENT);
    bodyOf(island).replayActions.onDelete(PART, false);
    await settle();
    expect((confirm.asked[0] as ConfirmOptions).title, "one part: the plain title").toBe(m("stream.replay.delete"));
    expect(count(DELETE_PART)).toBe(1);
    const order = calls();
    expect(order.lastIndexOf(CURRENT), "the read comes after the DELETE").toBeGreaterThan(order.indexOf(DELETE_PART));
    expect(count(CURRENT)).toBe(reads + 1);
    const a = bodyOf(island).replayActions;
    expect([...a.gone]).toEqual([PART.id]);
    expect(a.deleting).toBeNull();
    expect(a.failed).toBeNull();
    // (The body hands this state to the card with its own fixture id: fixture-stream-panel.test.tsx, "Task 25: the ended card's
    // Seazn replays", which has the session-view builder.)
  });

  it("a REFUSED delete is the row's failure: no re-read, the part stays; a second try that goes through clears the failure", async () => {
    const island = await mount({ refuseDelete: true });
    const reads = count(CURRENT);
    bodyOf(island).replayActions.onDelete(PART, false);
    await settle();
    expect(count(DELETE_PART)).toBe(1);
    expect(count(CURRENT), "no re-read after a refusal").toBe(reads);
    let a = bodyOf(island).replayActions;
    expect({ deleting: a.deleting, failed: a.failed, gone: [...a.gone] }).toEqual({ deleting: null, failed: PART.id, gone: [] });
    serve();
    bodyOf(island).replayActions.onDelete(PART, false);
    await settle();
    a = bodyOf(island).replayActions;
    expect({ deleting: a.deleting, failed: a.failed, gone: [...a.gone] }).toEqual({ deleting: null, failed: null, gone: [PART.id] });
    expect(count(DELETE_PART)).toBe(2);
  });

  it("while one delete is in flight, a second tap (this part or another) asks nothing and sends nothing", async () => {
    const island = await mount();
    let release: () => void = () => {};
    apiV1.mockImplementation(async (url, options) => {
      const key = `${options?.method ?? "GET"} ${url}`;
      if (key === DELETE_PART) await new Promise<void>((resolve) => { release = resolve; });
      if (key === CURRENT) return null;
      return { deleted: true };
    });
    bodyOf(island).replayActions.onDelete(PART, false);
    await settle();
    expect(bodyOf(island).replayActions.deleting, "PREMISE: the first is in flight").toBe(PART.id);
    bodyOf(island).replayActions.onDelete({ ...PART, id: "00000000-0000-4000-8000-000000000003", partNo: 3 }, true);
    await settle();
    expect(confirm.asked).toHaveLength(1);
    expect(calls().filter((c) => c.startsWith("DELETE"))).toEqual([DELETE_PART]);
    release();
    await settle();
    expect(bodyOf(island).replayActions.deleting).toBeNull();
  });
});
