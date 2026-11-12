// InviteTeammates (polish wave P6) — the captain's "Invite your teammates" block: per link, the link itself, Copy link and (where the
// device can) Share. No jsdom in this workspace: driven through the shared node-env hook harness, with the browser globals stubbed.
//
// What the harness cannot see is stated in the entry-card tests (the block is mounted by the real card, and the real cascade is
// the e2e's); what it CAN see is the join between a click and what reaches the clipboard / the share sheet, which is the whole
// point of the block: a link that is never written is a button that lies.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { joinLinkPath } from "@/lib/join-link";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import { InviteRow, InviteTeammates } from "../invite-teammates";

const ORIGIN = "https://seazn.test";
const PATH = "/live/riverside/summer-smash/register/join?join_code=SZ-ABCD-EF23&player_id=p2";
const ROW = { label: "For Jordan Player", path: PATH, shareTitle: "Join Team Alpha", shareText: "Join Team Alpha (Mixed) — open the link." };
const COPY = t(uiEn, "register.status.invite.copy");
const COPIED = t(uiEn, "register.status.invite.copied");
const SHARE = t(uiEn, "register.status.invite.share");

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
const share = vi.fn<(data: { title: string; text: string; url: string }) => Promise<void>>(async () => {});

function stubBrowser(opts: { canShare: boolean; clipboardBlocked?: boolean }) {
  vi.stubGlobal("window", { location: { origin: ORIGIN } });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: opts.clipboardBlocked
        ? vi.fn(async () => {
            throw new Error("blocked");
          })
        : writeText,
    },
    ...(opts.canShare ? { share } : {}),
  });
}

beforeEach(() => {
  writeText.mockClear();
  share.mockReset();
  share.mockImplementation(async () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type Island = Pick<ReturnType<typeof renderIsland>, "tree">;
const buttons = (island: Island) => island.tree().filter((e) => e.type === "button");
const buttonLabelled = (island: Island, label: string) =>
  buttons(island).find((b) => textOf(b) === label);
const click = (el: ReturnType<typeof buttons>[number] | undefined) => (propsOf(el!).onClick as () => Promise<void>)();

describe("InviteRow — what is on screen", () => {
  it("the server render: the label, the link as a real anchor to the join page, Copy link — and NO Share (the device is not known yet)", () => {
    stubBrowser({ canShare: true });
    const island = renderIsland(InviteRow, ROW);
    const tree = island.tree();
    expect(textOf(tree)).toContain(ROW.label);
    const anchor = tree.find((e) => e.type === "a")!;
    expect(propsOf(anchor).href).toBe(PATH);
    expect(buttonLabelled(island, COPY)).toBeTruthy();
    expect(buttonLabelled(island, SHARE)).toBeUndefined();
  });

  it("after hydration on a device with Web Share: Share appears, and the link reads as the absolute URL it will copy (its href stays the path)", () => {
    stubBrowser({ canShare: true });
    const island = renderIsland(InviteRow, ROW, undefined, { hydrate: true });
    expect(buttonLabelled(island, SHARE)).toBeTruthy();
    const anchor = island.tree().find((e) => e.type === "a")!;
    expect(textOf(anchor)).toBe(`${ORIGIN}${PATH}`);
    expect(propsOf(anchor).href).toBe(PATH);
  });

  it("after hydration on a device WITHOUT Web Share: still no Share (Copy link is the whole offer)", () => {
    stubBrowser({ canShare: false });
    const island = renderIsland(InviteRow, ROW, undefined, { hydrate: true });
    expect(buttonLabelled(island, SHARE)).toBeUndefined();
    expect(buttonLabelled(island, COPY)).toBeTruthy();
  });

  it("the row is ph-no-capture on its own root (the join code is a capability: a replay must not record it)", () => {
    stubBrowser({ canShare: true });
    const root = renderIsland(InviteRow, ROW).tree()[0]!;
    expect(String(propsOf(root).className)).toContain("ph-no-capture");
  });
});

describe("InviteRow — Copy link", () => {
  it("writes the ABSOLUTE url (origin + path) to the clipboard and says so, for this row", async () => {
    stubBrowser({ canShare: true });
    const island = renderIsland(InviteRow, ROW);
    expect(buttonLabelled(island, COPIED)).toBeUndefined();
    await click(buttonLabelled(island, COPY));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}${PATH}`);
    expect(buttonLabelled(island, COPIED)).toBeTruthy();
    expect(buttonLabelled(island, COPY)).toBeUndefined();
  });

  it("a blocked clipboard never throws and never claims the link was copied", async () => {
    stubBrowser({ canShare: false, clipboardBlocked: true });
    const island = renderIsland(InviteRow, ROW);
    await expect(click(buttonLabelled(island, COPY))).resolves.not.toThrow();
    expect(buttonLabelled(island, COPIED)).toBeUndefined();
    expect(buttonLabelled(island, COPY)).toBeTruthy();
  });
});

describe("InviteRow — Share", () => {
  it("hands the sheet the title, the text and the ABSOLUTE url; the clipboard is not touched when the sheet took it", async () => {
    stubBrowser({ canShare: true });
    const island = renderIsland(InviteRow, ROW, undefined, { hydrate: true });
    await click(buttonLabelled(island, SHARE));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ title: ROW.shareTitle, text: ROW.shareText, url: `${ORIGIN}${PATH}` });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a dismissed sheet (AbortError) copies nothing: the person said no", async () => {
    stubBrowser({ canShare: true });
    share.mockImplementation(async () => {
      throw new DOMException("dismissed", "AbortError");
    });
    const island = renderIsland(InviteRow, ROW, undefined, { hydrate: true });
    await click(buttonLabelled(island, SHARE));
    expect(share).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    expect(buttonLabelled(island, COPIED)).toBeUndefined();
  });

  it("a sheet that fails for any other reason falls back to copying the link, and says so", async () => {
    stubBrowser({ canShare: true });
    share.mockImplementation(async () => {
      throw new DOMException("not allowed", "NotAllowedError");
    });
    const island = renderIsland(InviteRow, ROW, undefined, { hydrate: true });
    await click(buttonLabelled(island, SHARE));
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}${PATH}`);
    expect(buttonLabelled(island, COPIED)).toBeTruthy();
  });
});

describe("InviteTeammates — the block", () => {
  const BLOCK = {
    kind: "team" as "team" | "pair",
    entryName: "Team Alpha",
    divisionName: "Mixed Doubles",
    orgSlug: "riverside",
    competitionSlug: "summer-smash",
    joinCode: "SZ-ABCD-EF23",
    slots: [
      { id: "p2", name: "Jordan Player" },
      { id: "p3", name: "Sam Player" },
    ],
    generic: true,
  };
  const rowsOf = (props: typeof BLOCK) => renderIsland(InviteTeammates, props).tree().filter((e) => e.type === InviteRow);

  it("one row per slot, in roster order, then the general link: each built from the code by the shared builder (anti-vacuity: 3 expected, 3 found)", () => {
    stubBrowser({ canShare: false });
    const rows = rowsOf(BLOCK);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => propsOf(r).path)).toEqual([
      joinLinkPath("riverside", "summer-smash", "SZ-ABCD-EF23", "p2"),
      joinLinkPath("riverside", "summer-smash", "SZ-ABCD-EF23", "p3"),
      joinLinkPath("riverside", "summer-smash", "SZ-ABCD-EF23"),
    ]);
    expect(rows.map((r) => propsOf(r).label)).toEqual([
      t(uiEn, "register.status.invite.slotLabel", { name: "Jordan Player" }),
      t(uiEn, "register.status.invite.slotLabel", { name: "Sam Player" }),
      t(uiEn, "register.status.invite.genericLabel"),
    ]);
  });

  it("a pair: its partner's slot and no general row (generic false)", () => {
    stubBrowser({ canShare: false });
    const rows = rowsOf({ ...BLOCK, kind: "pair", slots: BLOCK.slots.slice(0, 1), generic: false });
    expect(rows.map((r) => propsOf(r).path)).toEqual([joinLinkPath("riverside", "summer-smash", "SZ-ABCD-EF23", "p2")]);
  });

  it("every general-only team (all slots claimed) still shows its one row", () => {
    stubBrowser({ canShare: false });
    expect(rowsOf({ ...BLOCK, slots: [] }).map((r) => propsOf(r).path)).toEqual([joinLinkPath("riverside", "summer-smash", "SZ-ABCD-EF23")]);
  });

  it("each row's share title and text name THIS entry and division (so the message a teammate receives says what it is for)", () => {
    stubBrowser({ canShare: false });
    const rows = rowsOf(BLOCK);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(propsOf(row).shareTitle).toBe(t(uiEn, "register.status.invite.shareTitle", { entry: "Team Alpha" }));
      expect(propsOf(row).shareText).toBe(t(uiEn, "register.status.invite.shareText", { entry: "Team Alpha", division: "Mixed Doubles" }));
    }
  });

  it("a team reads 'teammates', a pair reads 'partner' (heading and hint both)", () => {
    stubBrowser({ canShare: false });
    const team = textOf(renderIsland(InviteTeammates, BLOCK).tree());
    const pair = textOf(renderIsland(InviteTeammates, { ...BLOCK, kind: "pair", slots: BLOCK.slots.slice(0, 1), generic: false }).tree());
    expect(team).toContain(t(uiEn, "register.status.invite.heading"));
    expect(team).toContain(t(uiEn, "register.status.invite.hint"));
    expect(pair).toContain(t(uiEn, "register.status.invite.headingPair"));
    expect(pair).toContain(t(uiEn, "register.status.invite.hintPair"));
    expect(pair).not.toContain(t(uiEn, "register.status.invite.heading"));
  });

  it("empty case: no slots and no general link, no block (a heading over nothing is a lie)", () => {
    stubBrowser({ canShare: false });
    expect(renderIsland(InviteTeammates, { ...BLOCK, slots: [], generic: false }).tree()).toEqual([]);
  });
});
