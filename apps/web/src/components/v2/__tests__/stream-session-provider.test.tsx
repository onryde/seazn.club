// Spec 2026-09-30 §2 (T9b): ONE `current` poller per fixture page. `StreamSessionProvider` owns it; the Stream button and
// the panel read it through `useSharedPhoneSession`. `apps/web` vitest is node — `renderToStaticMarkup` runs no effects,
// so what this file CAN pin is which session each reader is handed (context is real in a static render). Whether the
// browser then runs one poll or two is the walkthrough's one-poller witness (stream-relay.spec.ts, A1b).
//
// One sport is not a question here: the session reads no sport.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamSessionProvider, useSharedPhoneSession } from "@/components/v2/stream-session-provider";
import type { StreamSessionView } from "@/lib/stream-session-view";

vi.mock("@/components/ui/confirm-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui/confirm-provider")>()),
  useConfirm: () => async () => true,
}));

const view = (id: string, fixtureId: string): StreamSessionView =>
  ({ id, fixtureId, state: "live", output: null, ingest: null, target: { id: "t1", kind: "youtube", label: "Club" } }) as unknown as StreamSessionView;

/** Prints what a reader for `fixtureId` is handed: the view's id (or "none") and whether a read has landed. */
function Probe({ fixtureId }: { fixtureId: string }) {
  const s = useSharedPhoneSession(fixtureId);
  return <i data-probe={fixtureId}>{`${s.view?.id ?? "none"}|${s.loaded ? "loaded" : "unread"}`}</i>;
}
const read = (html: string, fixtureId: string) => new RegExp(`data-probe="${fixtureId}">([^<]*)<`).exec(html)?.[1];

describe("StreamSessionProvider / useSharedPhoneSession — one session per fixture page", () => {
  it("a reader under the provider for ITS fixture gets the provider's session", () => {
    const html = renderToStaticMarkup(
      <StreamSessionProvider fixtureId="f1" initialView={view("s1", "f1")}>
        <Probe fixtureId="f1" />
      </StreamSessionProvider>,
    );
    expect(read(html, "f1")).toBe("s1|loaded");
  });

  it("the empty case: with no provider a reader has its OWN session — nothing read yet, nothing shown", () => {
    expect(read(renderToStaticMarkup(<Probe fixtureId="f1" />), "f1")).toBe("none|unread");
  });

  it("a provider for ANOTHER fixture is not this fixture's session — that reader keeps its own", () => {
    const html = renderToStaticMarkup(
      <StreamSessionProvider fixtureId="f1" initialView={view("s1", "f1")}>
        <Probe fixtureId="f1" />
        <Probe fixtureId="f2" />
      </StreamSessionProvider>,
    );
    expect(read(html, "f1")).toBe("s1|loaded");
    expect(read(html, "f2"), "f2 must never be shown f1's stream").toBe("none|unread");
  });

  it("a second provider for the SAME fixture adds nothing: its readers still get the outer session (never a second poll)", () => {
    const html = renderToStaticMarkup(
      <StreamSessionProvider fixtureId="f1" initialView={view("s1", "f1")}>
        <StreamSessionProvider fixtureId="f1">
          <Probe fixtureId="f1" />
        </StreamSessionProvider>
      </StreamSessionProvider>,
    );
    expect(read(html, "f1"), "an inner provider that shadowed the outer would read none|unread").toBe("s1|loaded");
  });

  // B5 review m-1: the console always mounts the provider (a stable root), `enabled` false when the page has no stream.
  // A disabled provider adds nothing — it neither polls nor hands out a session of its own, whatever it was seeded with.
  it("a DISABLED provider adds nothing: a reader under it keeps its own session, and an outer one passes through", () => {
    const alone = renderToStaticMarkup(
      <StreamSessionProvider fixtureId="f1" enabled={false} initialView={view("s1", "f1")}>
        <Probe fixtureId="f1" />
      </StreamSessionProvider>,
    );
    expect(read(alone, "f1"), "not the disabled provider's seeded session").toBe("none|unread");
    const nested = renderToStaticMarkup(
      <StreamSessionProvider fixtureId="f1" initialView={view("s1", "f1")}>
        <StreamSessionProvider fixtureId="f1" enabled={false}>
          <Probe fixtureId="f1" />
        </StreamSessionProvider>
      </StreamSessionProvider>,
    );
    expect(read(nested, "f1"), "the outer session passes through a disabled provider").toBe("s1|loaded");
  });

  it("…while a nested provider for a DIFFERENT fixture is that fixture's own", () => {
    const html = renderToStaticMarkup(
      <StreamSessionProvider fixtureId="f1" initialView={view("s1", "f1")}>
        <StreamSessionProvider fixtureId="f2" initialView={view("s2", "f2")}>
          <Probe fixtureId="f1" />
          <Probe fixtureId="f2" />
        </StreamSessionProvider>
      </StreamSessionProvider>,
    );
    // The inner provider is f2's: an f1 reader under it does not match it, so it reads its OWN (unread) session.
    expect(read(html, "f2")).toBe("s2|loaded");
    expect(read(html, "f1")).toBe("none|unread");
  });
});
