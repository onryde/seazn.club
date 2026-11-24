// "Stream this court" refused (court stream spec 2026-11-14 §5.1; web plan Task 12, review W-C M-4): the link route's two refusals an
// organiser can meet before anything is wrong with a court — no streaming for the organisation (402 `PAYMENT_REQUIRED`) and a server
// with no court streaming set up (503 `court_streaming_unconfigured`) — are said in their own words, in every language, never as the
// generic "That didn't work". Driven through the sheet's Link button with the v1 transport doubled.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderIsland, propsOf, walk, textOf } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { ApiV1Error } from "@/lib/client-v1";
import { linkFailureKey } from "@/lib/match-day/court-stream";
import { t } from "@/lib/i18n-runtime";
import { FROZEN_SEAT_FEATURE } from "@/lib/seat-frozen";
import type { StreamTarget } from "@/server/api-v1/schemas";
import { CourtStreamSheet, TargetPicker } from "../court-stream-sheet";
import type { MatchDayCtx } from "../court-focus";

const apiV1 = vi.fn<(url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>>(async () => ({}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: (url: string, options?: { method?: string; json?: unknown }) => apiV1(url, options),
}));

const DICTS = { en, es, fr, nl } as Record<string, Dict>;
const youtube = { connectionId: "c1", channelId: "UC1", channelTitle: "Riverside Live", privacy: "public", madeForKids: false, status: "connected", liveState: "enabled", termsOutdated: false, openBroadcasts: 0 };
const SEAZN = { id: "t-seazn", kind: "seazn", label: "Seazn", watchUrl: null, createdAt: "2026-09-01T00:00:00.000Z", keyHint: null, inUse: null, youtube: null } as unknown as StreamTarget;
const TARGETS = [{ id: "t-1", kind: "youtube", label: "Riverside", watchUrl: null, createdAt: "2026-10-01T00:00:00.000Z", keyHint: null, inUse: null, youtube }] as unknown as StreamTarget[];

beforeEach(() => {
  apiV1.mockReset().mockImplementation(async (url) => (url.includes("stream-targets") ? TARGETS : {}));
});

/** The sheet's open Link button lives in the Modal's `footer`, so the footer is walked as well as the body. */
function parts(tree: ReactElement[]): { body: ReactElement[]; footer: ReactElement[] } {
  const modal = tree[0]!;
  return { body: tree, footer: walk(propsOf(modal).footer as ReactNode) };
}
const byTestId = (els: ReactElement[], id: string) => els.find((el) => propsOf(el)["data-testid"] === id);

async function refuse(d: Dict, refusal: ApiV1Error, targets: StreamTarget[] = TARGETS): Promise<string> {
  apiV1.mockImplementation(async (url, o) => {
    if (url.includes("stream-targets")) return targets;
    if (o?.method === "POST") throw refusal;
    return {};
  });
  const ctx = { dict: d, orgId: "org-1", competitionId: "comp-1", locale: "en", tz: "Europe/London" } as MatchDayCtx;
  const island = renderIsland(CourtStreamSheet, { ctx, court: { court_id: "ct-1", court_name: "Court 2" }, linkId: null, onClose: () => {}, onChanged: () => {} });
  await vi.waitFor(() => expect(propsOf(byTestId(parts(island.tree()).footer, "md-cs-link-confirm")!).disabled).toBe(false));
  (propsOf(byTestId(parts(island.tree()).footer, "md-cs-link-confirm")!).onClick as () => void)();
  await vi.waitFor(() => expect(byTestId(island.tree(), "md-cs-failed")).toBeDefined());
  return textOf(propsOf(byTestId(island.tree(), "md-cs-failed")!).children as ReactNode);
}

describe("the link route's refusals, said in their own words", () => {
  it("the mapping: 402 and 503 are named, the court already streaming is kept, anything else stays generic", () => {
    expect(linkFailureKey("PAYMENT_REQUIRED")).toBe("matchDay.courtStream.noPlan");
    expect(linkFailureKey("court_streaming_unconfigured")).toBe("matchDay.courtStream.notConfigured");
    expect(linkFailureKey("court_already_streaming")).toBe("matchDay.courtStream.alreadyStreaming");
    expect(linkFailureKey("RELAY_KEK_MISSING")).toBe("matchDay.refusal.other");
    expect(linkFailureKey("")).toBe("matchDay.refusal.other");
  });

  it.each(Object.keys(DICTS))("%s: each line is that language's own sentence, apart from the generic one and from each other", (lang) => {
    const d = DICTS[lang]!;
    const noPlan = t(d, "matchDay.courtStream.noPlan");
    const notConfigured = t(d, "matchDay.courtStream.notConfigured");
    expect(noPlan).not.toBe(t(d, "matchDay.refusal.other"));
    expect(notConfigured).not.toBe(t(d, "matchDay.refusal.other"));
    expect(noPlan).not.toBe(notConfigured);
    if (lang !== "en") {
      expect(noPlan, "not the English line").not.toBe(t(en as Dict, "matchDay.courtStream.noPlan"));
      expect(notConfigured, "not the English line").not.toBe(t(en as Dict, "matchDay.courtStream.notConfigured"));
    }
  });

  it("a 402 on Link shows the no-streaming line in the sheet, not 'That didn't work'", async () => {
    const said = await refuse(en as Dict, new ApiV1Error("Plan upgrade required: streaming.relay", 402, "PAYMENT_REQUIRED"));
    expect(said).toBe("Streaming is switched off for this organisation, so a court can't be linked. Contact us to turn it back on.");
    expect(said).not.toBe("That didn't work. Try again.");
  });

  it("a 503 court_streaming_unconfigured on Link shows the not-set-up line", async () => {
    const said = await refuse(en as Dict, new ApiV1Error("Court streaming is not configured on this server", 503, "court_streaming_unconfigured"));
    expect(said).toBe("Court streaming isn't set up on this server yet. Contact us.");
  });

  it("in Dutch the same two refusals read in Dutch", async () => {
    const d = DICTS.nl!;
    expect(await refuse(d, new ApiV1Error("x", 402, "PAYMENT_REQUIRED"))).toBe(t(d, "matchDay.courtStream.noPlan"));
    expect(await refuse(d, new ApiV1Error("x", 503, "court_streaming_unconfigured"))).toBe(t(d, "matchDay.courtStream.notConfigured"));
  });
});

describe("Task 37: a court may stream to Seazn", () => {
  const ctx = (d: Dict = en as Dict) => ({ dict: d, orgId: "org-1", competitionId: "comp-1", locale: "en", tz: "Europe/London" } as MatchDayCtx);
  const sheet = () => renderIsland(CourtStreamSheet, { ctx: ctx(), court: { court_id: "ct-1", court_name: "Court 2" }, linkId: null, onClose: () => {}, onChanged: () => {} });

  it("the paused-seat 402 (members.max) is the seat line, not 'streaming is switched off'; any other feature's 402 stays the plan line (positive pair)", async () => {
    const paused = new ApiV1Error("Plan upgrade required: members.max", 402, "PAYMENT_REQUIRED", { feature_key: FROZEN_SEAT_FEATURE });
    const said = await refuse(en as Dict, paused);
    expect(said).toBe(t(en as Dict, "matchDay.courtStream.seatPaused"));
    expect(said).not.toBe(t(en as Dict, "matchDay.courtStream.noPlan"));
    expect(linkFailureKey(paused.code, paused)).toBe("matchDay.courtStream.seatPaused");
    const plan = new ApiV1Error("Plan upgrade required: streaming.relay", 402, "PAYMENT_REQUIRED", { feature_key: "streaming.relay" });
    expect(linkFailureKey(plan.code, plan)).toBe("matchDay.courtStream.noPlan");
    expect(await refuse(en as Dict, plan)).toBe(t(en as Dict, "matchDay.courtStream.noPlan"));
  });

  it("seazn_unavailable (Seazn switched off since the list was read) reads as its own sentence, in every language", async () => {
    expect(linkFailureKey("seazn_unavailable")).toBe("matchDay.courtStream.seaznUnavailable");
    let checked = 0;
    for (const [lang, d] of Object.entries(DICTS)) {
      const said = await refuse(d, new ApiV1Error("x", 422, "seazn_unavailable"), [SEAZN]);
      expect(said, lang).toBe(t(d, "matchDay.courtStream.seaznUnavailable"));
      expect(said, `${lang}: not the generic line`).not.toBe(t(d, "matchDay.refusal.other"));
      if (lang !== "en") expect(said, `${lang}: not the English line`).not.toBe(t(en as Dict, "matchDay.courtStream.seaznUnavailable"));
      checked++;
    }
    expect(checked).toBe(Object.keys(DICTS).length);
  });

  it("the three new lines are each language's own and differ from one another", () => {
    let checked = 0;
    for (const [lang, d] of Object.entries(DICTS)) {
      const lines = ["seaznHint", "seaznUnavailable", "seatPaused"].map((k) => t(d, `matchDay.courtStream.${k}` as never));
      expect(new Set(lines).size, lang).toBe(3);
      if (lang !== "en") for (const [i, k] of ["seaznHint", "seaznUnavailable", "seatPaused"].entries()) expect(lines[i], `${lang} ${k}`).not.toBe(t(en as Dict, `matchDay.courtStream.${k}` as never));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("with Seazn and a channel on offer nothing is preselected (Link stays shut, the picker lists Seazn first); a lone Seazn is preselected and Link posts its id", async () => {
    const picker = (island: { tree: () => ReactElement[] }) => island.tree().find((el) => el.type === TargetPicker);
    apiV1.mockImplementation(async (url) => (url.includes("stream-targets") ? [...TARGETS, SEAZN] : {}));
    const island = sheet();
    await vi.waitFor(() => expect((propsOf(picker(island)!).state as { status: string }).status).toBe("ok"));
    expect(propsOf(picker(island)!).value, "two choices: none preselected").toBeNull();
    expect(propsOf(byTestId(parts(island.tree()).footer, "md-cs-link-confirm")!).disabled).toBe(true);
    // The picker is the one place that orders and filters (courtTargets): it is handed the list as the server gave it.
    expect(((propsOf(picker(island)!).state as { list: { id: string }[] }).list).map((t) => t.id)).toEqual(["t-1", "t-seazn"]);

    apiV1.mockReset().mockImplementation(async (url) => (url.includes("stream-targets") ? [SEAZN] : {}));
    const lone = sheet();
    await vi.waitFor(() => expect(propsOf(byTestId(parts(lone.tree()).footer, "md-cs-link-confirm")!).disabled).toBe(false));
    expect(propsOf(picker(lone)!).value).toBe("t-seazn");
    (propsOf(byTestId(parts(lone.tree()).footer, "md-cs-link-confirm")!).onClick as () => void)();
    await vi.waitFor(() => expect(apiV1.mock.calls.some(([, o]) => o?.method === "POST")).toBe(true));
    const post = apiV1.mock.calls.find(([, o]) => o?.method === "POST")!;
    expect(post[0]).toBe("/api/v1/competitions/comp-1/court-streams");
    expect(post[1]?.json).toEqual({ court_id: "ct-1", target_id: "t-seazn" });
  });
});
