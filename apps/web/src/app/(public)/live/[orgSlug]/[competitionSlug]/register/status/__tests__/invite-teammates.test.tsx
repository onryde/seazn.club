// InviteTeammates (polish wave P6, redesigned in wave K) — the captain's "Invite your teammates" block: every roster slot named with
// whether that person has joined, Copy link and (where the device can) Share for each one still to join, and the general link apart
// under "Someone not listed?". No URL is printed. No jsdom in this workspace: driven through the shared node-env hook harness, with
// the browser globals stubbed.
//
// What the harness cannot see is stated in the entry-card tests (the block is mounted by the real card, and the real cascade is
// the e2e's); what it CAN see is the join between a click and what reaches the clipboard / the share sheet, and which person the
// block then says the link belongs to.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { joinLinkPath } from "@/lib/join-link";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import { compileClasses } from "@/components/v2/__tests__/_compiled-css";
import { InviteActions, InviteTeammates } from "../invite-teammates";

const ORIGIN = "https://seazn.test";
const PATH = "/live/riverside/summer-smash/register/join?join_code=SZ-ABCD-EF23&player_id=p2";
const COPY = t(uiEn, "register.status.invite.copy");
const SHARE = t(uiEn, "register.status.invite.share");

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
const share = vi.fn<(data: { title: string; text: string; url: string }) => Promise<void>>(async () => {});
const onCopied = vi.fn<() => void>();
const ACTIONS = {
  path: PATH,
  copyLabel: COPY,
  shareTitle: "Join Team Alpha",
  shareText: "Join Team Alpha (Mixed) — open the link.",
  describedBy: "slot-name-0",
  onCopied,
};

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
  onCopied.mockClear();
  share.mockReset();
  share.mockImplementation(async () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

type Island = Pick<ReturnType<typeof renderIsland>, "tree">;
const buttons = (island: Island) => island.tree().filter((e) => e.type === "button");
const buttonLabelled = (island: Island, label: string) => buttons(island).find((b) => textOf(b) === label);
const click = (el: ReturnType<typeof buttons>[number] | undefined) => (propsOf(el!).onClick as () => Promise<void>)();

describe("InviteActions — what is on screen", () => {
  it("the server render: Copy link carrying its link as data-href and naming whose it is, NO Share yet, and no URL printed", () => {
    stubBrowser({ canShare: true });
    const island = renderIsland(InviteActions, ACTIONS);
    const copy = buttonLabelled(island, COPY)!;
    expect(copy, "Copy link").toBeTruthy();
    expect(propsOf(copy)["data-href"], "the link, for whoever follows it").toBe(PATH);
    expect(propsOf(copy)["data-testid"]).toBe("reg-invite-copy");
    expect(propsOf(copy)["aria-describedby"], "a screen reader hears whose link").toBe("slot-name-0");
    expect(buttonLabelled(island, SHARE)).toBeUndefined();
    expect(island.tree().some((e) => e.type === "a"), "no link printed").toBe(false);
    expect(textOf(island.tree())).not.toContain("join_code");
    expect(String(propsOf(island.tree()[0]!).className), "it carries the link, so it is blocked from replay itself").toMatch(/(^|\s)ph-no-capture(\s|$)/);
  });

  it("after hydration on a device with Web Share: Share appears, described by the same name", () => {
    stubBrowser({ canShare: true });
    const island = renderIsland(InviteActions, ACTIONS, undefined, { hydrate: true });
    const shareButton = buttonLabelled(island, SHARE);
    expect(shareButton).toBeTruthy();
    expect(propsOf(shareButton!)["aria-describedby"]).toBe("slot-name-0");
  });

  it("after hydration on a device WITHOUT Web Share: still no Share (Copy link is the whole offer)", () => {
    stubBrowser({ canShare: false });
    const island = renderIsland(InviteActions, ACTIONS, undefined, { hydrate: true });
    expect(buttonLabelled(island, SHARE)).toBeUndefined();
    expect(buttonLabelled(island, COPY)).toBeTruthy();
  });
});

describe("InviteActions — Copy link", () => {
  it("writes the ABSOLUTE url (origin + path) to the clipboard, then reports it copied (once), and prints nothing", async () => {
    stubBrowser({ canShare: true });
    const island = renderIsland(InviteActions, ACTIONS);
    await click(buttonLabelled(island, COPY));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}${PATH}`);
    expect(onCopied).toHaveBeenCalledTimes(1);
    expect(island.tree().some((e) => e.type === "a")).toBe(false);
  });

  it("a blocked clipboard never claims the link was copied, and shows the link so it can be copied by hand", async () => {
    stubBrowser({ canShare: false, clipboardBlocked: true });
    const island = renderIsland(InviteActions, ACTIONS);
    await expect(click(buttonLabelled(island, COPY))).resolves.not.toThrow();
    expect(onCopied).not.toHaveBeenCalled();
    const anchor = island.tree().find((e) => e.type === "a");
    expect(anchor, "the by-hand fallback").toBeTruthy();
    expect(propsOf(anchor!).href).toBe(PATH);
    expect(textOf(anchor!)).toBe(`${ORIGIN}${PATH}`);
  });
});

describe("InviteActions — Share", () => {
  it("hands the sheet the title, the text and the ABSOLUTE url; the clipboard is not touched when the sheet took it", async () => {
    stubBrowser({ canShare: true });
    const island = renderIsland(InviteActions, ACTIONS, undefined, { hydrate: true });
    await click(buttonLabelled(island, SHARE));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ title: ACTIONS.shareTitle, text: ACTIONS.shareText, url: `${ORIGIN}${PATH}` });
    expect(writeText).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("a dismissed sheet (AbortError) copies nothing: the person said no", async () => {
    stubBrowser({ canShare: true });
    share.mockImplementation(async () => {
      throw new DOMException("dismissed", "AbortError");
    });
    const island = renderIsland(InviteActions, ACTIONS, undefined, { hydrate: true });
    await click(buttonLabelled(island, SHARE));
    expect(share).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("a sheet that fails for any other reason falls back to copying the link, and says so", async () => {
    stubBrowser({ canShare: true });
    share.mockImplementation(async () => {
      throw new DOMException("not allowed", "NotAllowedError");
    });
    const island = renderIsland(InviteActions, ACTIONS, undefined, { hydrate: true });
    await click(buttonLabelled(island, SHARE));
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}${PATH}`);
    expect(onCopied).toHaveBeenCalledTimes(1);
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
      { id: "p1", name: "Sam Captain", joined: true },
      { id: "p2", name: "Dana Whitfield", joined: false },
      { id: "p3", name: "Jordan Player", joined: false },
    ],
    generic: true,
  };
  const mount = (props: typeof BLOCK) => renderIsland(InviteTeammates, props);
  const slotRows = (island: Island) => island.tree().filter((e) => e.type === "li" && propsOf(e)["data-invite-slot"]);
  const actionsIn = (el: ReturnType<typeof slotRows>[number]) => {
    const found: ReturnType<typeof slotRows> = [];
    const visit = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const element = node as ReturnType<typeof slotRows>[number];
      if (element.type === InviteActions) found.push(element);
      visit(propsOf(element).children);
    };
    visit(propsOf(el).children);
    return found;
  };
  const allActions = (island: Island) => island.tree().filter((e) => e.type === InviteActions);
  const liveRegion = (island: Island) => island.tree().find((e) => propsOf(e).role === "status")!;

  it("one row per roster slot, in roster order, each naming its person with a joined / not-joined chip (anti-vacuity: 3 rows)", () => {
    stubBrowser({ canShare: false });
    const rows = slotRows(mount(BLOCK));
    expect(rows).toHaveLength(3);
    const joined = t(uiEn, "register.status.roster.joined");
    const waiting = t(uiEn, "register.status.roster.notJoined");
    const read = rows.map((r) => textOf(r).replace(/\s+/g, " ").trim());
    expect(read).toEqual([`Sam Captain ✓ ${joined}`, `Dana Whitfield ${waiting}`, `Jordan Player ${waiting}`]);
  });

  it("a joined slot has its chip and NO link or buttons; each slot still to join has its OWN link", () => {
    stubBrowser({ canShare: false });
    const rows = slotRows(mount(BLOCK));
    expect(actionsIn(rows[0]!), "Sam has joined: nothing to hand out").toHaveLength(0);
    let linked = 0;
    for (const [i, id] of [[1, "p2"], [2, "p3"]] as const) {
      const actions = actionsIn(rows[i]!);
      expect(actions, id).toHaveLength(1);
      expect(propsOf(actions[0]!).path, id).toBe(joinLinkPath("riverside", "summer-smash", "SZ-ABCD-EF23", id));
      expect(propsOf(actions[0]!).copyLabel).toBe(COPY);
      linked += 1;
    }
    expect(linked).toBe(2);
  });

  it("each row's buttons are described by THAT row's name element, so a screen reader hears whose link it is", () => {
    stubBrowser({ canShare: false });
    const island = mount(BLOCK);
    const rows = slotRows(island);
    for (const row of rows.slice(1)) {
      const describedBy = propsOf(actionsIn(row)[0]!).describedBy as string;
      const named = island.tree().find((e) => propsOf(e).id === describedBy);
      expect(named, describedBy).toBeTruthy();
      expect(textOf(row)).toContain(textOf(named!));
    }
  });

  it("the general link sits apart: after the roster, below a divider, under 'Someone not listed?', with its own Copy invite link", () => {
    stubBrowser({ canShare: false });
    const island = mount(BLOCK);
    const tree = island.tree();
    const generic = tree.find((e) => propsOf(e)["data-invite-generic"]);
    expect(generic, "the general block").toBeTruthy();
    expect(String(propsOf(generic!).className)).toMatch(/(^|\s)border-t(\s|$)/);
    expect(textOf(generic!)).toContain(t(uiEn, "register.status.invite.notListed"));
    const all = allActions(island);
    expect(all, "two slots still to join + the general link").toHaveLength(3);
    const last = all[all.length - 1]!;
    expect(propsOf(last).path).toBe(joinLinkPath("riverside", "summer-smash", "SZ-ABCD-EF23"));
    expect(propsOf(last).copyLabel).toBe(t(uiEn, "register.status.invite.copyGeneric"));
    expect(tree.indexOf(generic!), "after every slot row").toBeGreaterThan(tree.indexOf(slotRows(island)[2]!));
  });

  it("copying says WHOSE link it was, in the live region: the person's name, then the general link's own words", () => {
    stubBrowser({ canShare: false });
    const island = mount(BLOCK);
    expect(textOf(liveRegion(island)), "silent until something is copied").toBe("");
    expect(propsOf(liveRegion(island))["aria-live"]).toBe("polite");
    (propsOf(allActions(island)[0]!).onCopied as () => void)();
    expect(textOf(liveRegion(island))).toBe(t(uiEn, "register.status.invite.copiedFor", { name: "Dana Whitfield" }));
    expect(textOf(island.tree())).toContain(t(uiEn, "register.status.invite.copiedFor", { name: "Dana Whitfield" }));
    (propsOf(allActions(island)[1]!).onCopied as () => void)();
    expect(textOf(liveRegion(island))).toBe(t(uiEn, "register.status.invite.copiedFor", { name: "Jordan Player" }));
    (propsOf(allActions(island)[2]!).onCopied as () => void)();
    expect(textOf(liveRegion(island))).toBe(t(uiEn, "register.status.invite.copiedGeneric"));
  });

  it("no URL and no join code is printed anywhere in the block; the whole block is ph-no-capture", () => {
    stubBrowser({ canShare: true });
    const island = renderIsland(InviteTeammates, BLOCK, undefined, { hydrate: true });
    const text = textOf(island.tree());
    expect(text).not.toContain("join_code");
    expect(text).not.toContain("SZ-ABCD-EF23");
    expect(text).not.toContain("/register/join");
    const root = island.tree()[0]!;
    expect(propsOf(root)["data-testid"]).toBe("reg-invite");
    expect(String(propsOf(root).className)).toMatch(/(^|\s)ph-no-capture(\s|$)/);
  });

  it("each link's share title and text name THIS entry and division (so the message a teammate receives says what it is for)", () => {
    stubBrowser({ canShare: false });
    const all = allActions(mount(BLOCK));
    expect(all.length).toBe(3);
    for (const actions of all) {
      expect(propsOf(actions).shareTitle).toBe(t(uiEn, "register.status.invite.shareTitle", { entry: "Team Alpha" }));
      expect(propsOf(actions).shareText).toBe(t(uiEn, "register.status.invite.shareText", { entry: "Team Alpha", division: "Mixed Doubles" }));
    }
  });

  it("a team reads 'teammates', a pair reads 'partner' (heading and intro both); a pair has no general link", () => {
    stubBrowser({ canShare: false });
    const team = textOf(mount(BLOCK).tree());
    const pairIsland = mount({ ...BLOCK, kind: "pair", slots: BLOCK.slots.slice(0, 2), generic: false });
    const pair = textOf(pairIsland.tree());
    expect(team).toContain(t(uiEn, "register.status.invite.heading"));
    expect(team).toContain(t(uiEn, "register.status.invite.intro"));
    expect(pair).toContain(t(uiEn, "register.status.invite.headingPair"));
    expect(pair).toContain(t(uiEn, "register.status.invite.introPair"));
    expect(pair).not.toContain(t(uiEn, "register.status.invite.heading"));
    expect(pair).not.toContain(t(uiEn, "register.status.invite.notListed"));
    expect(allActions(pairIsland).map((a) => propsOf(a).path)).toEqual([joinLinkPath("riverside", "summer-smash", "SZ-ABCD-EF23", "p2")]);
  });

  it("a team whose every slot has joined keeps only the general link (chips stay, no slot buttons)", () => {
    stubBrowser({ canShare: false });
    const island = mount({ ...BLOCK, slots: BLOCK.slots.map((s) => ({ ...s, joined: true })) });
    expect(slotRows(island)).toHaveLength(3);
    expect(allActions(island).map((a) => propsOf(a).path)).toEqual([joinLinkPath("riverside", "summer-smash", "SZ-ABCD-EF23")]);
  });

  it("a team with no roster at all: the general link alone, with no divider above it", () => {
    stubBrowser({ canShare: false });
    const island = mount({ ...BLOCK, slots: [] });
    expect(slotRows(island)).toHaveLength(0);
    const generic = island.tree().find((e) => propsOf(e)["data-invite-generic"])!;
    expect(String(propsOf(generic).className)).not.toMatch(/(^|\s)border-t(\s|$)/);
    expect(allActions(island)).toHaveLength(1);
  });

  it("empty case: nothing to hand out (every slot joined, no general link) is no block (a heading over chips invites nobody)", () => {
    stubBrowser({ canShare: false });
    expect(mount({ ...BLOCK, slots: BLOCK.slots.map((s) => ({ ...s, joined: true })), generic: false }).tree()).toEqual([]);
    expect(mount({ ...BLOCK, slots: [], generic: false }).tree()).toEqual([]);
  });
});

// B4 T16 (spec §5.4) — the block at 320. What a node-env harness CAN see is the class contract that produces the layout; the real
// paint (widths, where the chip lands, that nothing leaves the card) was measured in a browser at 320/768/1280 in en/nl/fr/es with a
// 43-character name (see the commit message). The card is `overflow-hidden`, so an overflow here never shows as page scroll: it is
// CLIPPED, which is exactly what the seven-width no-horizontal-scroll e2e cannot see.
const allActionsOf = (island: Island) => island.tree().filter((e) => e.type === InviteActions);

describe("InviteTeammates — layout at 320 (class contract)", () => {
  // A 43-character name (spaced) and a 43-character name with no break opportunity at all: the realistic worst cases for a
  // row that holds a name, a status chip and two 44px buttons in 222px.
  const SPACED = "Maria-Alexandra Featherstonehaugh Beaumonte";
  const TOKEN = "Featherstonehaughwetherspoonsmythejohnsonxx";
  const BLOCK = {
    kind: "team" as "team" | "pair",
    entryName: "Team Alpha",
    divisionName: "Mixed Doubles",
    orgSlug: "riverside",
    competitionSlug: "summer-smash",
    joinCode: "SZ-ABCD-EF23",
    slots: [
      { id: "p1", name: "Sam Captain", joined: true },
      { id: "p2", name: SPACED, joined: false },
      { id: "p3", name: TOKEN, joined: false },
    ],
    generic: true,
  };
  type Node = ReturnType<Island["tree"]>[number];
  const has = (el: Node, token: string) => String(propsOf(el).className ?? "").split(/\s+/).includes(token);
  const mount = () => renderIsland(InviteTeammates, BLOCK);
  /** The elements from the block's root down to `target`, root first and `target` last; null when `target` is not under it. */
  function pathTo(from: unknown, target: Node, trail: Node[] = []): Node[] | null {
    if (Array.isArray(from)) {
      for (const child of from) {
        const found = pathTo(child, target, trail);
        if (found) return found;
      }
      return null;
    }
    if (!from || typeof from !== "object" || !("props" in from)) return null;
    const el = from as Node;
    const here = [...trail, el];
    return el === target ? here : pathTo(propsOf(el).children, target, here);
  }
  const names = (island: Island) => island.tree().filter((e) => e.type === "span" && /-slot-\d+$/.test(String(propsOf(e).id ?? "")));
  const genericText = (island: Island) => island.tree().find((e) => e.type === "p" && /-generic$/.test(String(propsOf(e).id ?? "")))!;
  const rows = (island: Island) => island.tree().filter((e) => propsOf(e)["data-invite-slot"] || propsOf(e)["data-invite-generic"]);

  beforeEach(() => stubBrowser({ canShare: false }));

  it("every row (each roster slot AND the general link) wraps, so a long name sends its chip and buttons to the next line instead of squeezing the name (anti-vacuity: 3 slots + 1 general)", () => {
    const found = rows(mount());
    expect(found, "3 slot rows + the general row").toHaveLength(4);
    for (const row of found) expect(has(row, "flex-wrap"), String(propsOf(row).className)).toBe(true);
  });

  it("min-w-0 on the WHOLE chain from each name up to the block's root (li, ul, section, and the name's own cluster), so nothing in it can hold the row wider than the card", () => {
    const island = mount();
    const root = island.tree()[0]!;
    let checked = 0;
    const tags = new Set<string>();
    for (const target of [...names(island), genericText(island)]) {
      const path = pathTo(root, target);
      expect(path, "the name is reachable from the root").not.toBeNull();
      expect(path![0], "the chain starts at the block's root").toBe(root);
      for (const ancestor of path!.slice(0, -1)) {
        expect(has(ancestor, "min-w-0"), `<${String(ancestor.type)} class="${String(propsOf(ancestor).className)}"> sits above a name and lacks min-w-0`).toBe(true);
        tags.add(String(ancestor.type));
        checked += 1;
      }
    }
    expect(names(island), "3 slot names").toHaveLength(3);
    expect(checked, "ancestors checked").toBeGreaterThan(0);
    expect([...tags].sort(), "the chain really passed through the list, a row and the section").toEqual(expect.arrayContaining(["li", "section", "ul"]));
  });

  it("a name WRAPS (never truncates: it is how the captain tells whose link this is) and can never widen its row: min-w-0 + max-w-full + break-words", () => {
    const island = mount();
    const found = names(island);
    expect(found).toHaveLength(3);
    for (const name of found) {
      for (const token of ["min-w-0", "max-w-full", "break-words"]) expect(has(name, token), `${textOf(name)} lacks ${token}`).toBe(true);
      expect(has(name, "truncate"), "a truncated name would hide whose link it is").toBe(false);
    }
    expect(found.map((n) => textOf(n))).toEqual(["Sam Captain", SPACED, TOKEN]);
  });

  it("the name's cluster (and the general link's text) holds a 12rem floor, so the buttons drop under it on a phone rather than leaving the name ~130px; `grow`, never `flex-1`, so flex-1's own 0% basis can never outrank basis-48", () => {
    const island = mount();
    const root = island.tree()[0]!;
    const clusters = names(island).map((name) => pathTo(root, name)!.at(-2)!);
    expect(clusters, "one cluster per slot row").toHaveLength(3);
    for (const el of [...clusters, genericText(island)]) {
      for (const token of ["grow", "basis-48", "min-w-0"]) expect(has(el, token), `${String(propsOf(el).className)} lacks ${token}`).toBe(true);
      expect(has(el, "flex-1"), "flex-1 sets its own flex-basis").toBe(false);
      expect(has(el, "basis-32"), "the old 8rem floor").toBe(false);
    }
  });

  it("both status chips can wrap inside their own pill rather than run past the row: max-w-full (anti-vacuity: one joined chip, two not-joined)", () => {
    const chips = mount().tree().filter((e) => e.type === "span" && has(e, "rounded-full"));
    const joined = chips.filter((c) => has(c, "bg-emerald-50"));
    const waiting = chips.filter((c) => has(c, "bg-amber-50"));
    expect(joined, "Sam").toHaveLength(1);
    expect(waiting, "the two still to join").toHaveLength(2);
    for (const chip of chips) {
      expect(has(chip, "max-w-full"), String(propsOf(chip).className)).toBe(true);
      expect(has(chip, "shrink-0"), "the pill keeps its own width until the cap").toBe(true);
    }
  });

  it("the confirmation under the block breaks a name that has no space in it: 'Copied <43 unbroken characters>'s link' cannot leave the card", () => {
    const island = mount();
    (propsOf(allActionsOf(island)[1]!).onCopied as () => void)();
    const shown = island.tree().find((e) => e.type === "p" && propsOf(e)["aria-hidden"] === "true")!;
    expect(textOf(shown), "the copied line names the 43-character token").toContain(TOKEN);
    expect(has(shown, "break-words"), String(propsOf(shown).className)).toBe(true);
  });

  it("the block wears the status page's card frame (rounded-xl, a zinc-200 hairline) and a sentence-case display heading like 'What happens next', not the all-caps eyebrow", () => {
    const island = mount();
    const root = island.tree()[0]!;
    for (const token of ["rounded-xl", "border", "border-zinc-200", "bg-canvas", "ph-no-capture"]) expect(has(root, token), `root lacks ${token}`).toBe(true);
    const heading = island.tree().find((e) => e.type === "h4")!;
    expect(textOf(heading)).toBe(t(uiEn, "register.status.invite.heading"));
    expect(has(heading, "font-display")).toBe(true);
    expect(has(heading, "uppercase")).toBe(false);
  });

  it("the Copy / Share group wraps and may shrink to the row (so 'Copier le lien' + 'Partager' fall onto two lines, not past the card)", () => {
    const actions = renderIsland(InviteActions, ACTIONS).tree()[0]!;
    for (const token of ["flex-wrap", "min-w-0"]) expect(has(actions, token), token).toBe(true);
  });

  it("every utility the block and its buttons actually render compiles to a rule (a typo'd utility compiles to nothing and the layout silently reverts)", async () => {
    stubBrowser({ canShare: true, clipboardBlocked: true });
    const block = renderIsland(InviteTeammates, BLOCK, undefined, { hydrate: true });
    const buttons = renderIsland(InviteActions, ACTIONS, undefined, { hydrate: true });
    await (propsOf(buttons.tree().find((e) => e.type === "button" && textOf(e) === COPY)!).onClick as () => Promise<void>)();
    (propsOf(allActionsOf(block)[1]!).onCopied as () => void)();
    // `ph-no-capture` is PostHog's marker, not a utility; everything else is Tailwind.
    const used = [...new Set([...block.tree(), ...buttons.tree()].flatMap((e) => String(propsOf(e).className ?? "").split(/\s+/)).filter((c) => c && c !== "ph-no-capture"))];
    expect(used.length, "tokens checked").toBeGreaterThan(30);
    expect(used, "the by-hand link fallback was drawn too").toContain("break-all");
    expect(used, "the confirmation line was drawn too").toContain("break-words");
    const compiled = await compileClasses(used);
    const dead = used.filter((c) => Object.keys(compiled.get(c) ?? {}).length === 0);
    expect(dead, "utilities that compile to nothing").toEqual([]);
    expect(compiled.get("basis-48")!["flex-basis"], "12rem, read from the theme's spacing").toMatch(/48/);
  });
});
