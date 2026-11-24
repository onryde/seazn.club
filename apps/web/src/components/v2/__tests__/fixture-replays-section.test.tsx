// Seazn-hosted video Task 33d (T31b review m3): the fixture page's standalone replays list (fixture-replays-section.tsx) hands the
// page's one reading of the member-seat freeze to the card. The page test (f/[no]/__tests__/stream-mount.test.tsx) pins WHAT the page
// hands the section; seazn-replays-card.test.tsx pins how the card draws a paused seat. This file pins the hop between them, through the
// REAL section and the REAL card (static markup; only the router and the house confirm are stood in for — neither is touched by a
// render). Sport: not applicable — the list reads no sport.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import type { StreamSessionCurrent } from "@/server/api-v1/schemas";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => async () => false }));

import { FixtureReplaysSection } from "../fixture-replays-section";

type Replay = StreamSessionCurrent["seaznReplays"][number];
const en = JSON.parse(readFileSync(join(__dirname, "../../../dictionaries/en/ui.json"), "utf8")) as Record<string, string>;
const PARTS: Replay[] = [
  { id: "00000000-0000-4000-8000-000000000001", partNo: 1, state: "playable", lengthSeconds: 60, onMatchPage: true },
  { id: "00000000-0000-4000-8000-000000000002", partNo: 2, state: "failed", lengthSeconds: null, onMatchPage: true },
];
const html = (memberFrozen: boolean) =>
  renderToStaticMarkup(
    <DictProvider dict={en} locale="en">
      <FixtureReplaysSection fixtureId="11111111-1111-4111-8111-111111111111" replays={PARTS} memberFrozen={memberFrozen} />
    </DictProvider>,
  );
const count = (h: string, testid: string) => h.split(`data-testid="${testid}"`).length - 1;

describe("Task 33d: the standalone replays list hands the card the page's seat pause", () => {
  it("not paused: both parts with their actions (Download on the playable one, Delete on each), and no paused line", () => {
    const out = html(false);
    expect(count(out, "stream-seazn-replay"), "anti-vacuity: both parts").toBe(2);
    expect([count(out, "stream-seazn-replay-download"), count(out, "stream-seazn-replay-delete")]).toEqual([1, 2]);
    expect(count(out, "stream-seazn-replays-paused")).toBe(0);
  });

  it("paused: the same two parts, no Download and no Delete, and the one line in the dictionary's words", () => {
    const out = html(true);
    expect(count(out, "stream-seazn-replay"), "the parts stay").toBe(2);
    expect([count(out, "stream-seazn-replay-download"), count(out, "stream-seazn-replay-delete")]).toEqual([0, 0]);
    expect(count(out, "stream-seazn-replays-paused")).toBe(1);
    expect(out).toContain(en["stream.replay.seazn.seatPaused"]!.replace(/'/g, "&#x27;"));
  });
});
