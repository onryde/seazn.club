// B5 review m-1: the console mounts the stream session provider on EVERY fixture page, `enabled` only when the page has a
// stream. A disabled session never asks the confirm dialog anything, so it must not demand one — the console's node
// harnesses render it without a `<ConfirmProvider>`, exactly as before the provider was unconditional. An ENABLED
// session still fails fast without the dialog (Stop on air is always confirmed), and with no dialog a session that is
// somehow asked to stop declines rather than stopping unconfirmed — the missing dialog decides that, not `enabled`.
//
// This file deliberately does NOT mock `@/components/ui/confirm-provider` — the real context is what is under test.
// One sport is not a question here: the session reads no sport.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { StreamSessionProvider, usePhoneSession } from "@/components/v2/stream-session-provider";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import type { StreamSessionView } from "@/lib/stream-session-view";

const apiV1 = vi.fn<(url: string, options?: { method?: string }) => Promise<unknown>>(async () => null);
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: (url: string, options?: { method?: string }) => apiV1(url, options),
}));
afterEach(() => apiV1.mockClear());

const LIVE = {
  id: "s1",
  fixtureId: "f1",
  state: "live",
  output: null,
  ingest: null,
  startedAt: "2026-09-30T12:00:00.000Z",
  target: { id: "t1", kind: "youtube", label: "Club" },
} as unknown as StreamSessionView;

describe("the session's confirm dialog — needed only while the session is enabled (B5 review m-1)", () => {
  it("a DISABLED provider renders with no ConfirmProvider in the tree (every fixture page with no stream)", () => {
    expect(renderToStaticMarkup(<StreamSessionProvider fixtureId="f1" enabled={false}><i>page</i></StreamSessionProvider>)).toBe("<i>page</i>");
  });

  it("an ENABLED provider with no ConfirmProvider fails fast, naming what is missing", () => {
    expect(() => renderToStaticMarkup(<StreamSessionProvider fixtureId="f1"><i>page</i></StreamSessionProvider>)).toThrow(/ConfirmProvider/);
  });

  it("…and renders under one (the root layout's)", () => {
    expect(
      renderToStaticMarkup(
        <ConfirmProvider>
          <StreamSessionProvider fixtureId="f1"><i>page</i></StreamSessionProvider>
        </ConfirmProvider>,
      ),
    ).toContain("<i>page</i>");
  });

  it("with NO dialog in the tree, a (disabled) session asked to Stop a live view declines — nothing is stopped unconfirmed", async () => {
    const island = renderIsland(
      (p: { enabled: boolean }) => {
        const s = usePhoneSession("f1", { enabled: p.enabled, initialView: LIVE });
        return <i data-state={s.state} data-stop={s.stop as unknown as string} />;
      },
      { enabled: false },
    );
    const el = island.tree().find((e) => (e.props as { "data-state"?: string })["data-state"] !== undefined)!;
    expect((el.props as { "data-state": string })["data-state"], "premise: the seeded view is live").toBe("live");
    await (el.props as unknown as { "data-stop": () => Promise<void> })["data-stop"]();
    expect(apiV1.mock.calls.map(([url]) => url), "no stop request, no read").toEqual([]);
    island.unmount();
  });
});
