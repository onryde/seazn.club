// Seazn-hosted video Task 25: the organiser's list of a fixture's Seazn replays, in the fixture stream panel's ended card. Each part
// the replay move made, in part order, with its state in the organiser's words: "Getting the replay ready" (processing), ready with
// its length (playable), or the failure sentence (failed). A part is labelled "Part {n}" only when there are two or more (the panel's
// YouTube replay rule: one part is just the replay). Nothing at all when there is none.
//
// Task 25 review m3 (owned by Task 26): the words say what is TRUE where the part plays. A playable part is "Ready on the match page"
// only when the public can see the match (`onMatchPage`, server/video/organiser-replays.ts); otherwise it says the public cannot. A
// failed part also says the original recording still plays meanwhile (on the match page, or kept, when the public cannot see it), for
// the recording's own lifetime — the number is relay config's DELETE_RECORDING_AFTER_DAYS, never one typed here.
//
// Task 26: Delete on EVERY part, Download only on a PLAYABLE one, both 44 px targets (min-h-11). Download is a link to the download
// route — a path of ours with the fixture and the replay ids and nothing else (no token, no host address, no query). The delete flow
// (`deleteSeaznReplayFlow`) asks first and does nothing on "no"; a refused DELETE is the row's failure; a deleted part leaves the
// list at once (`gone`), before the next read of the view drops it.
//
// The words are the dictionaries'; the states and the order are the read's. Static markup: the card is a pure function of its props.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { LOCALES } from "@/lib/i18n-constants";
import type { StreamSessionCurrent } from "@/server/api-v1/schemas";
import { DELETE_RECORDING_AFTER_DAYS } from "@/server/relay/config";
import { type SeaznReplayActions, SeaznReplaysCard, deleteSeaznReplayFlow, replayDownloadHref, replayLength } from "../seazn-replays-card";

type Replay = StreamSessionCurrent["seaznReplays"][number];
const DICT_DIR = join(__dirname, "../../../dictionaries");
const uiDict = (locale: string): Record<string, string> => JSON.parse(readFileSync(join(DICT_DIR, locale, "ui.json"), "utf8"));
const en = uiDict("en");
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const FIXTURE = "11111111-1111-4111-8111-111111111111";
const r = (partNo: number, state: Replay["state"], lengthSeconds: number | null = null, onMatchPage = true): Replay =>
  ({ id: id(partNo), partNo, state, lengthSeconds, onMatchPage });
const IDLE: SeaznReplayActions = { deleting: null, failed: null, gone: new Set(), onDelete: () => {} };
const html = (replays: Replay[], locale = "en", actions: SeaznReplayActions = IDLE) =>
  renderToStaticMarkup(
    <DictProvider dict={uiDict(locale)} locale={locale as "en"}>
      <SeaznReplaysCard fixtureId={FIXTURE} replays={replays} actions={actions} />
    </DictProvider>,
  );
const text = (h: string) =>
  h.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").replace(/^\||\|$/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const LI = /<li data-testid="stream-seazn-replay" data-state="([^"]+)"[^>]*>(.*?)<\/li>/g;
const ACTIONS = /<div data-testid="stream-seazn-replay-actions"[^>]*>(.*?)<\/div>/;
/** Each row: [its state attribute, its text without the actions row]. */
const rows = (out: string): [string, string][] => [...out.matchAll(LI)].map((m) => [m[1]!, text(m[2]!.replace(ACTIONS, ""))]);
/** Each row's actions: [testid, its text, its href or null, disabled?, its class]. */
const actionsOf = (out: string) =>
  [...out.matchAll(LI)].map((m) =>
    [...(m[2]!.match(ACTIONS)?.[1] ?? "").matchAll(/<(a|button) ([^>]*)>(.*?)<\/\1>/g)].map((a) => ({
      testid: /data-testid="([^"]+)"/.exec(a[2]!)?.[1],
      text: text(a[3]!),
      href: /href="([^"]*)"/.exec(a[2]!)?.[1] ?? null,
      download: / download=""/.test(a[2]!),
      disabled: / disabled=""/.test(a[2]!),
      cls: /class="([^"]*)"/.exec(a[2]!)?.[1] ?? "",
    })),
  );
const still = (d: Record<string, string>, onMatchPage: boolean) =>
  d[onMatchPage ? "stream.replay.seazn.failedStillPlays" : "stream.replay.seazn.failedStillPlaysPrivate"]!.replace("{days}", String(DELETE_RECORDING_AFTER_DAYS));
const esc = (t: string) => t.replace(/'/g, "&#x27;");

describe("SeaznReplaysCard", () => {
  it("EMPTY CASE FIRST: no replay, no card at all; nor for a view from a server older than the field (no list); nor when every part was deleted here", () => {
    expect(html([])).toBe("");
    expect(renderToStaticMarkup(<SeaznReplaysCard fixtureId={FIXTURE} replays={undefined} actions={IDLE} />)).toBe("");
    expect(html([r(1, "playable", 60)], "en", { ...IDLE, gone: new Set([id(1)]) })).toBe("");
  });

  it("one part: the title, no part label, its state in words (a playable one with its length)", () => {
    expect(rows(html([r(1, "playable", 125)]))).toEqual([["playable", `${en["stream.replay.seazn.ready"]}|2:05`]]);
    expect(rows(html([r(1, "processing")]))).toEqual([["processing", en["stream.replay.seazn.processing"]!]]);
    expect(rows(html([r(1, "failed")]))).toEqual([["failed", `${en["stream.replay.seazn.failed"]}|${still(en, true)}`]]);
    expect(html([r(1, "processing")])).toContain(`>${en["stream.replay.seazn.title"]}<`);
  });

  it("three parts, each labelled by its OWN number (a gap stays a gap) in part order, each in its own state", () => {
    const out = html([r(4, "failed"), r(1, "playable", 3_725), r(2, "processing")]);
    expect(rows(out)).toEqual([
      ["playable", `Part 1|${en["stream.replay.seazn.ready"]}|1:02:05`],
      ["processing", `Part 2|${en["stream.replay.seazn.processing"]}`],
      ["failed", `Part 4|${en["stream.replay.seazn.failed"]}|${still(en, true)}`],
    ]);
  });

  it("a playable part with no length shows no length; a processing or failed part never shows one", () => {
    expect(rows(html([r(1, "playable")]))).toEqual([["playable", en["stream.replay.seazn.ready"]!]]);
    expect(rows(html([r(1, "processing", 90), r(2, "failed", 90)])).map(([, t]) => t)).toEqual([
      `Part 1|${en["stream.replay.seazn.processing"]}`, `Part 2|${en["stream.replay.seazn.failed"]}|${still(en, true)}`,
    ]);
  });

  it("review m3: a playable part the public cannot see (onMatchPage false) never says it is on the match page — it says the public cannot see the match", () => {
    expect(rows(html([r(1, "playable", 60, false)]))).toEqual([["playable", `${en["stream.replay.seazn.readyPrivate"]}|1:00`]]);
    expect(html([r(1, "playable", 60, false)]), "the public wording is not there").not.toContain(en["stream.replay.seazn.ready"]!);
    expect(en["stream.replay.seazn.readyPrivate"], "PREMISE: the two sentences differ").not.toBe(en["stream.replay.seazn.ready"]);
    // Mixed: each part by its own flag (the read gives one per part; they agree in practice, the card does not assume it).
    expect(rows(html([r(1, "playable", 60, true), r(2, "playable", 60, false)])).map(([, t]) => t)).toEqual([
      `Part 1|${en["stream.replay.seazn.ready"]}|1:00`, `Part 2|${en["stream.replay.seazn.readyPrivate"]}|1:00`,
    ]);
  });

  it("review m3: a failed part says the original recording still plays meanwhile, for relay config's own number of days — on the match page, or kept when the public cannot see the match", () => {
    expect(DELETE_RECORDING_AFTER_DAYS, "PREMISE: the recording's lifetime is a number of days").toBeGreaterThan(0);
    const pub = html([r(1, "failed")]);
    expect(pub).toContain(`data-testid="stream-seazn-replay-interim"`);
    expect(rows(pub)[0]![1]).toBe(`${en["stream.replay.seazn.failed"]}|${still(en, true)}`);
    expect(still(en, true), "the number is in the words").toContain(`${DELETE_RECORDING_AFTER_DAYS} days`);
    const priv = html([r(1, "failed", null, false)]);
    expect(rows(priv)[0]![1]).toBe(`${en["stream.replay.seazn.failed"]}|${still(en, false)}`);
    expect(text(priv), "a private match's failed part does not send anyone to the match page as a place it plays").not.toContain(en["stream.replay.seazn.failedStillPlays"]!.split("{days}")[0]!);
    // Never on a processing or playable part.
    expect(html([r(1, "processing"), r(2, "playable", 60)])).not.toContain("stream-seazn-replay-interim");
  });

  it("Task 26: Delete on EVERY part, Download only on a PLAYABLE one — a link to the download route with the ids and nothing else; both 44 px", () => {
    const out = html([r(1, "playable", 60), r(2, "processing"), r(3, "failed")]);
    const acts = actionsOf(out);
    expect(acts.map((row) => row.map((a) => a.testid))).toEqual([
      ["stream-seazn-replay-download", "stream-seazn-replay-delete"],
      ["stream-seazn-replay-delete"],
      ["stream-seazn-replay-delete"],
    ]);
    const dl = acts[0]![0]!;
    expect(dl.href).toBe(`/api/v1/fixtures/${FIXTURE}/replays/${id(1)}/download`);
    expect(dl.href).toBe(replayDownloadHref(FIXTURE, id(1)));
    expect(dl.href, "no query, no token, no host").not.toMatch(/[?#]|token|https?:|bunny|b-cdn/i);
    expect(dl.download, "the browser saves it, it does not navigate to it").toBe(true);
    let checked = 0;
    for (const a of acts.flat()) {
      expect(a.cls.split(/\s+/), `${a.testid}: a 44 px target`).toContain("min-h-11");
      expect(a.disabled, `${a.testid}: idle, not disabled`).toBe(false);
      checked++;
    }
    expect(checked, "anti-vacuity: 4 actions").toBe(4);
    // The words: the dictionary's, and each part's name for a screen reader when there are two or more.
    expect(acts[0]!.map((a) => a.text)).toEqual([`${en["stream.replay.download"]}| Part 1`, `${en["stream.replay.delete"]}| Part 1`]);
    expect(actionsOf(html([r(1, "playable", 60)]))[0]!.map((a) => a.text), "one part: no part name").toEqual([en["stream.replay.download"], en["stream.replay.delete"]]);
  });

  it("Task 26: while one part is deleting, it says so and every Delete waits; a refused delete says so on ITS row; a part deleted here leaves the list at once", () => {
    const parts = [r(1, "playable", 60), r(2, "playable", 60)];
    const busy = actionsOf(html(parts, "en", { ...IDLE, deleting: id(2) }));
    expect(busy.map((row) => row.at(-1)!.disabled)).toEqual([true, true]);
    expect(busy[1]!.at(-1)!.text).toBe(`${en["stream.replay.deleting"]}| Part 2`);
    expect(busy[0]!.at(-1)!.text).toBe(`${en["stream.replay.delete"]}| Part 1`);
    expect(busy[0]![0]!.disabled, "Download stays a link").toBe(false);
    const failed = html(parts, "en", { ...IDLE, failed: id(2) });
    expect([...failed.matchAll(LI)].map((m) => m[2]!.includes(`data-testid="stream-seazn-replay-delete-failed"`))).toEqual([false, true]);
    expect(failed).toContain(esc(en["stream.replay.deleteFailed"]!));
    const gone = html(parts, "en", { ...IDLE, gone: new Set([id(1)]) });
    expect(rows(gone), "the one left is the whole story: no part label").toEqual([["playable", `${en["stream.replay.seazn.ready"]}|1:00`]]);
  });

  it("every locale has its own words: no raw key, and each locale's title and states are its dictionary's", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const d = uiDict(locale);
      const out = html([r(1, "playable", 60), r(2, "processing"), r(3, "failed")], locale);
      expect(out, locale).not.toContain("stream.replay.seazn");
      for (const key of ["title", "ready", "processing", "failed"]) {
        const want = d[`stream.replay.seazn.${key}`];
        expect(want, `${locale}: stream.replay.seazn.${key}`).toBeTruthy();
        expect(out, `${locale}: ${key}`).toContain(esc(want!));
      }
      expect(out).toContain(d["stream.replay.seazn.part"]!.replace("{n}", "3"));
      expect(out, `${locale}: the failed part's interim`).toContain(esc(still(d, true)));
      expect(out, `${locale}: download`).toContain(esc(d["stream.replay.download"]!));
      expect(out, `${locale}: delete`).toContain(esc(d["stream.replay.delete"]!));
      const priv = html([r(1, "playable", 60, false), r(2, "failed", null, false)], locale);
      expect(priv, `${locale}: readyPrivate`).toContain(esc(d["stream.replay.seazn.readyPrivate"]!));
      expect(priv, `${locale}: failedStillPlaysPrivate`).toContain(esc(still(d, false)));
      expect(html([r(1, "playable", 60)], locale, { ...IDLE, deleting: id(1), failed: id(1) }), `${locale}: deleting + failed`)
        .toContain(esc(d["stream.replay.deleting"]!));
      for (const key of ["readyPrivate", "failedStillPlays", "failedStillPlaysPrivate"]) expect(d[`stream.replay.seazn.${key}`], `${locale}: ${key}`).toBeTruthy();
      for (const key of ["delete", "download", "deleteConfirm", "deletePartTitle", "deleteKeep", "deleting", "deleteFailed"]) {
        expect(d[`stream.replay.${key}`], `${locale}: stream.replay.${key}`).toBeTruthy();
        if (locale !== "en") expect(d[`stream.replay.${key}`], `${locale}: ${key} is translated`).not.toBe(en[`stream.replay.${key}`]);
      }
      expect(d["stream.replay.seazn.failedStillPlays"], `${locale}: names the days`).toContain("{days}");
      expect(d["stream.replay.deletePartTitle"], `${locale}: names the part`).toContain("{n}");
      checked++;
    }
    expect(checked, "anti-vacuity: every locale").toBe(LOCALES.length);
  });

  it("Task 31b: framed for the PAGE (the list on its own, no Stream panel around it), the card is a house card whose title is a heading; framed for the panel (the default) it stays the panel's inset box — the same rows and actions either way", () => {
    const parts = [r(1, "playable", 75), r(2, "failed")];
    const open = (h: string) => /^<section ([^>]*)>/.exec(h)![1]!;
    const inset = html(parts);
    const page = renderToStaticMarkup(
      <DictProvider dict={en} locale="en">
        <SeaznReplaysCard fixtureId={FIXTURE} replays={parts} actions={IDLE} frame="page" />
      </DictProvider>,
    );
    expect(open(inset)).toContain('class="min-w-0 space-y-2 rounded-lg border border-slate-200 p-3"');
    expect(open(page)).toMatch(/class="card min-w-0 space-y-2 p-5 max-md:p-3"/);
    expect(inset, "the panel's title is not a heading (the panel has its own)").not.toMatch(/<h2/);
    expect(page).toMatch(new RegExp(`<h2 [^>]*>${en["stream.replay.seazn.title"]}</h2>`));
    expect(rows(page), "the same rows").toEqual(rows(inset));
    expect(actionsOf(page), "the same actions").toEqual(actionsOf(inset));
    expect(actionsOf(page).flat().map((a) => a.testid), "anti-vacuity").toEqual([
      "stream-seazn-replay-download", "stream-seazn-replay-delete", "stream-seazn-replay-delete",
    ]);
  });

  // Task 33d (T31b review m3): a member whose seat is paused by the plan's member limit (entitlement-freeze.ts `frozenMemberIds`; the
  // owner is never in it) would get 402 from both routes (auth.ts `requireOrgAuth`, write scope). So the card shows every part and its
  // state, offers neither action, and says why in ONE line. The English is the controller's sentence, literal, so a reworded key reds.
  describe("Task 33d: a member whose seat is paused", () => {
    const PAUSED_LINE = "Your seat is paused, so replays can't be changed or downloaded. Ask the club owner.";
    const PARTS = [r(1, "playable", 60), r(2, "processing"), r(3, "failed")];
    const card = (o: { replays?: Replay[]; frame?: "inset" | "page"; memberFrozen?: boolean; locale?: string; actions?: SeaznReplayActions } = {}) =>
      renderToStaticMarkup(
        <DictProvider dict={uiDict(o.locale ?? "en")} locale={(o.locale ?? "en") as "en"}>
          <SeaznReplaysCard fixtureId={FIXTURE} replays={o.replays ?? PARTS} actions={o.actions ?? IDLE} frame={o.frame} memberFrozen={o.memberFrozen} />
        </DictProvider>,
      );
    const PAUSED = /<p data-testid="stream-seazn-replays-paused"[^>]*>(.*?)<\/p>/g;
    const pausedLines = (h: string) => [...h.matchAll(PAUSED)].map((m) => text(m[1]!));

    it("EMPTY CASE FIRST: paused with no part — none read, or every part deleted here — is no card and no line", () => {
      expect(card({ replays: [], memberFrozen: true })).toBe("");
      expect(card({ replays: [r(1, "playable", 60)], memberFrozen: true, actions: { ...IDLE, gone: new Set([id(1)]) } })).toBe("");
    });

    it("paused: every part and its state stay, NO Download and NO Delete (no actions row at all), and one line saying why — in both frames", () => {
      let checked = 0;
      for (const frame of ["inset", "page"] as const) {
        const shown = card({ frame });
        const paused = card({ frame, memberFrozen: true });
        expect(actionsOf(shown).flat().map((a) => a.testid), `${frame}: PREMISE: unpaused, the actions are there`).toEqual([
          "stream-seazn-replay-download", "stream-seazn-replay-delete", "stream-seazn-replay-delete", "stream-seazn-replay-delete",
        ]);
        expect(rows(paused), `${frame}: the same parts in the same states`).toEqual(rows(shown));
        expect(rows(paused), `${frame}: anti-vacuity`).toHaveLength(3);
        expect(paused, `${frame}: no actions row`).not.toContain('data-testid="stream-seazn-replay-actions"');
        expect(paused, `${frame}: no Download`).not.toContain('data-testid="stream-seazn-replay-download"');
        expect(paused, `${frame}: no Delete`).not.toContain('data-testid="stream-seazn-replay-delete"');
        expect(paused, `${frame}: no link to the download route`).not.toContain("/download");
        expect(pausedLines(paused), `${frame}: ONE line, the controller's words`).toEqual([PAUSED_LINE]);
        expect(pausedLines(shown), `${frame}: no line when the seat is not paused`).toEqual([]);
        checked++;
      }
      expect(checked).toBe(2);
    });

    it("not paused (memberFrozen false: an admin with a seat, and the owner, who is never frozen) is exactly the card it was without the prop", () => {
      for (const frame of ["inset", "page"] as const) expect(card({ frame, memberFrozen: false }), frame).toBe(card({ frame }));
      expect(pausedLines(card({ memberFrozen: false }))).toEqual([]);
    });

    it("a paused member sees no row's delete failure either (there is no Delete to have failed)", () => {
      const out = card({ memberFrozen: true, actions: { ...IDLE, failed: id(1) } });
      expect(out).not.toContain('data-testid="stream-seazn-replay-delete-failed"');
      expect(card({ actions: { ...IDLE, failed: id(1) } }), "PREMISE: unpaused, it shows").toContain('data-testid="stream-seazn-replay-delete-failed"');
    });

    it("every locale says it in its own words: the key is in each dictionary, translated outside English, and rendered as given", () => {
      let checked = 0;
      for (const locale of LOCALES) {
        const d = uiDict(locale);
        const want = d["stream.replay.seazn.seatPaused"];
        expect(want, `${locale}: stream.replay.seazn.seatPaused`).toBeTruthy();
        if (locale === "en") expect(want).toBe(PAUSED_LINE);
        else expect(want, `${locale}: translated`).not.toBe(en["stream.replay.seazn.seatPaused"]);
        expect(pausedLines(card({ locale, memberFrozen: true })), locale).toEqual([want]);
        checked++;
      }
      expect(checked, "anti-vacuity: every locale").toBe(LOCALES.length);
    });
  });

  it("replayLength: m:ss under an hour, h:mm:ss from an hour, nothing for a length that is not one", () => {
    expect([replayLength(0), replayLength(59), replayLength(60), replayLength(125), replayLength(3_599), replayLength(3_600), replayLength(36_061)])
      .toEqual(["0:00", "0:59", "1:00", "2:05", "59:59", "1:00:00", "10:01:01"]);
    expect([replayLength(null), replayLength(-1), replayLength(Number.NaN), replayLength(1.5)]).toEqual([null, null, null, null]);
  });
});

// The delete's flow, step by step, over fakes: the house confirm is ASKED FIRST and "no" does nothing; "yes" sends one DELETE to the
// part's route, then reads the view again. The steps are the hook's (useSeaznReplayActions), which only adds state around them.
describe("deleteSeaznReplayFlow", () => {
  const part = r(2, "playable", 60);
  const rig = (o: { confirm?: boolean; delThrows?: boolean; rereadThrows?: boolean } = {}) => {
    const log: string[] = [];
    return {
      log,
      run: () =>
        deleteSeaznReplayFlow({
          fixtureId: FIXTURE,
          replay: part,
          confirm: async () => (log.push("confirm"), o.confirm ?? true),
          del: async (url) => {
            log.push(`DELETE ${url}`);
            if (o.delThrows) throw new Error("409");
          },
          reread: async () => {
            log.push("reread");
            if (o.rereadThrows) throw new Error("offline");
          },
        }),
    };
  };

  it("EMPTY CASE FIRST: the organiser says no — nothing is sent and nothing is read", async () => {
    const r1 = rig({ confirm: false });
    expect(await r1.run()).toBe("cancelled");
    expect(r1.log).toEqual(["confirm"]);
  });

  it("yes: ONE DELETE to the part's own route, after the confirm, then a read of the view", async () => {
    const r1 = rig();
    expect(await r1.run()).toBe("deleted");
    expect(r1.log).toEqual(["confirm", `DELETE /api/v1/fixtures/${FIXTURE}/replays/${id(2)}`, "reread"]);
  });

  it("a refused DELETE is the row's failure, and nothing is read; a failed read after a delete that went through is still deleted", async () => {
    const refused = rig({ delThrows: true });
    expect(await refused.run()).toBe("failed");
    expect(refused.log).toEqual(["confirm", `DELETE /api/v1/fixtures/${FIXTURE}/replays/${id(2)}`]);
    const offline = rig({ rereadThrows: true });
    expect(await offline.run()).toBe("deleted");
    expect(offline.log.at(-1)).toBe("reread");
  });

  it("a second delete of the same part asks again (no memory of the first): the route answers it as already deleted", async () => {
    const r1 = rig();
    await r1.run();
    await r1.run();
    expect(r1.log.filter((l) => l === "confirm")).toHaveLength(2);
    expect(r1.log.filter((l) => l.startsWith("DELETE"))).toHaveLength(2);
  });
});
