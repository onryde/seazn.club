// The Signal-path component (spec 2026-09-30 §3.2, mockup option-a.html) and the D3 warning box. `apps/web` vitest is
// node — no DOM — so this proves what a static render CAN: which classes each node and link carries, what the group
// announces, where the destination's label sits at each width (by class), and that D9's reserved prop renders nothing.
// Layout, the cascade and real contrast are the walkthrough's and the screenshots' (AGENTS.md class 2).
//
// One sport is not a question here: the chain reads no sport.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { D3Warning, PhoneStripView, SignalChain } from "@/components/v2/stream-signal-chain";
import { platformName } from "@/components/v2/stream-platform-mark";
import { chainFor, type Chain } from "@/lib/stream-chain";
import { messages } from "@/lib/messages";
import { HEALTH_KEYS, OUTPUT_WARNING_AFTER_MS, phoneStrip, type PhoneLinePart, type PhoneStrip } from "@/lib/stream-session-view";
import { HEALTH_REASONS } from "@/server/relay/domain/health-reasons";
import type { StreamPhone, StreamSessionCurrent } from "@/server/api-v1/schemas";
import { StreamTargetKind } from "@/server/api-v1/schemas";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";

const W = OUTPUT_WARNING_AFTER_MS;
const view = (state: string, ingest: string | null, output: string | null, elapsedMs = 0) =>
  ({
    state,
    ingest: ingest ? { state: ingest, protocol: "srt" } : null,
    output: output ? { state: output, since: "2026-09-30T12:00:00.000Z", elapsedMs } : null,
  }) as never;

const warming = view("warming", null, null);
const liveOk = view("live", "connected", "ok");
const liveConnecting = view("live", "connected", "connecting", 0);
const liveWarned = view("live", "connected", "connecting", W);
const liveStale = view("live", "disconnected", "ok");
const ending = view("ending", "connected", "ok");

const DEST = { kind: "youtube" as const, label: "Club YouTube" };

function chainHtml(chain: Chain, destination: { kind: (typeof StreamTargetKind.options)[number]; label: string } = DEST): string {
  return renderToStaticMarkup(<SignalChain chain={chain} destination={destination} />);
}

function dict(locale: Locale): Dict {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../dictionaries/${locale}/ui.json`), "utf8")) as Dict;
}

describe("SignalChain (spec §3.2)", () => {
  it("lime appears only as a ring or line class — never on text, across EVERY §3.2 row's nodes", () => {
    // Every row of the table, rendered: each node carries data-tone; no element anywhere carries a lime TEXT class.
    const rows = [null, warming, liveOk, liveConnecting, liveWarned, liveStale, ending].map((v) => chainFor(v)!);
    let nodes = 0;
    let limeNodes = 0;
    for (const chain of rows) {
      const html = chainHtml(chain);
      expect(html).not.toMatch(/text-\[var\(--mk-lime\)\]|text-lime-/);
      for (const m of html.matchAll(/data-tone="(\w+)"[^>]*class="([^"]*)"/g)) {
        nodes++;
        if (m[1] === "lime") {
          limeNodes++;
          expect(m[2]).toMatch(/ring-\[var\(--mk-lime\)\]/);
        }
      }
    }
    expect(nodes).toBe(rows.length * 3); // three nodes per row, or the scan matched nothing
    expect(limeNodes).toBeGreaterThan(0); // the lime rows really were scanned
  });

  it("every node and link exposes its word and style as data, read from the mapping — the walkthrough's handle", () => {
    const html = chainHtml(chainFor(liveWarned)!);
    expect(html).toMatch(/data-testid="stream-chain"/);
    expect(html).toMatch(/data-phone="connected"/);
    expect(html).toMatch(/data-seazn="receiving"/);
    expect(html).toMatch(/data-dest="notReceiving"/);
    expect(html).toMatch(/data-link1="flowing"/);
    expect(html).toMatch(/data-link2="problem"/);
  });

  it("links render their style class; ONLY connecting animates, and it is opted out under reduced motion (globals.css)", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../../../app/globals.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.stream-link-connecting[^}]*animation:\s*none/);
    // §3.2's D3 row is "amber DASHES" — static; the animation runs only while connecting.
    expect(css).not.toMatch(/\.stream-link-problem\s*\{[^}]*animation/);
    expect(css).toMatch(/\.stream-link-connecting\s*\{[^}]*animation:/);
    // The four styles are each defined, and lime is a LINE colour in them (D5) — never a hard-coded hex.
    let defined = 0;
    for (const s of ["idle", "connecting", "flowing", "problem"]) {
      expect(css, s).toMatch(new RegExp(`\\.stream-link-${s}\\s*\\{`));
      defined++;
    }
    expect(defined).toBe(4);
    expect(css).not.toMatch(/\.stream-link-[a-z]+\s*\{[^}]*#a3e635/i);
    expect(chainHtml(chainFor(warming)!)).toMatch(/class="[^"]*stream-link-connecting/);
    expect(chainHtml(chainFor(liveWarned)!)).toMatch(/class="[^"]*stream-link-problem/);
  });

  it("the destination label sits under its node at ≥768 and on its own line under the chain below 768", () => {
    const html = chainHtml(chainFor(null)!, { kind: "youtube", label: "Club YouTube" });
    expect(html).toMatch(/<span class="max-md:hidden">YouTube · Club YouTube<\/span>/);
    expect(html).toMatch(/<span class="md:hidden">YouTube<\/span>/);
    expect(html).toMatch(/data-testid="stream-chain-dest-label"[^>]*class="[^"]*\smd:hidden"/);
    expect(html).toMatch(/data-testid="stream-chain-dest-label"[^>]*>To <span[^>]*>Club YouTube<\/span><\/p>/);
  });

  // B5 review m-3: in Live the picker is gone, so the chain's destination node is the only place the panel names the
  // destination at ≥768 — a truncated "YouTube · Riverside Badminto…" names nothing. The destination's name WRAPS there
  // (never overflows); below 768 it keeps `truncate`, where it is the platform alone and the label has its own line.
  // The Phone and Seazn names are fixed short words and keep their one line at every width.
  it("m-3: the destination's name truncates only below 768 and wraps in full at ≥768; Phone and Seazn keep one line", () => {
    const label = "Riverside Badminton Club — Saturday Senior League Channel";
    const html = chainHtml(chainFor(null)!, { kind: "youtube", label });
    const dest = /<span data-testid="stream-chain-dest-name" class="([^"]*)">/.exec(html);
    expect(dest, "the destination's name element").not.toBeNull();
    const cls = ` ${dest![1]} `;
    expect(cls, "below 768: one line (the platform alone)").toContain(" truncate ");
    expect(cls, "≥768: the truncate's nowrap is lifted").toContain(" md:whitespace-normal ");
    expect(cls, "…breaking a long word rather than overflowing").toContain(" md:[overflow-wrap:anywhere] ");
    expect(html).toContain(`<span class="max-md:hidden">YouTube · ${label}</span>`);
    const truncated = [...html.matchAll(/<span class="mt-2 max-w-full truncate[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(truncated, "Phone and Seazn: one line each").toEqual([messages["stream.chain.phone"], messages["stream.chain.seazn"]]);
  });

  it("every destination kind the wire declares gets its platform name on the node (legacy kinds included)", () => {
    let checked = 0;
    for (const kind of StreamTargetKind.options) {
      const name = platformName((k) => messages[k], kind);
      expect(chainHtml(chainFor(null)!, { kind, label: "L" }), kind).toContain(`<span class="md:hidden">${name}</span>`);
      checked++;
    }
    expect(checked).toBe(StreamTargetKind.options.length);
  });

  // A11 (stream-relay.spec.ts): browser zoom at 125% on a 320-px phone is a 256-CSS-px layout. Three 64-px nodes that
  // cannot shrink (the mockup's `w-16 shrink-0`) put the destination node 10 px past that viewport. 64 px stays the
  // node's width wherever it fits; below that the node gives way (`min-w-0`, no `shrink-0`), and its 40-px ring with it
  // never — the ring is `shrink-0`. The walkthrough measures the real box; this pins the classes it depends on.
  // Capture QR v2 §6.12 (Option B rev 2): the PHONE node is 80 px below 768 (was 64) so "Reconnecting…" (76 px at
  // 11 px) fits one line; 96 at ≥768 as before. Seazn stays 64/96 and the destination 64/208.
  it("each node may shrink below its width on a zoomed phone (min-w-0, never shrink-0); its 40 px ring may not — the phone node 80 px below 768", () => {
    const html = chainHtml(chainFor(liveOk)!);
    const nodes = Object.fromEntries([...html.matchAll(/<div data-node="([a-z]+)" class="(flex [^"]*)">/g)].map((m) => [m[1]!, m[2]!.split(" ")]));
    expect(Object.keys(nodes), "three nodes").toEqual(["phone", "seazn", "dest"]);
    expect(nodes.phone, "phone: 80 px below 768, 96 from it").toEqual(expect.arrayContaining(["w-20", "md:w-24"]));
    expect(nodes.seazn).toEqual(expect.arrayContaining(["w-16", "md:w-24"]));
    expect(nodes.dest).toEqual(expect.arrayContaining(["w-16", "md:w-52"]));
    expect(nodes.phone).not.toContain("w-16");
    for (const cls of Object.values(nodes)) {
      expect(cls).toContain("min-w-0");
      expect(cls).not.toContain("shrink-0");
    }
    const rings = [...html.matchAll(/<span data-tone="[a-z]+" class="([^"]*)">/g)].map((m) => m[1]!);
    expect(rings, "three rings").toHaveLength(3);
    for (const cls of rings) expect(cls.split(" "), cls).toContain("shrink-0");
  });

  it("§6.12: a node's state word may break only as a fallback for a longer translation — `max-w-full [overflow-wrap:anywhere]` on every word", () => {
    const html = chainHtml(chainFor(view("live", "disconnected", "unknown", W), { capture: { phone: null, countdown: { kind: "live", reason: "phone_lost", elapsedMs: 1, remainingMs: 1 } } })!);
    const words = [...html.matchAll(/<span class="(mt-0\.5 [^"]*)">/g)].map((m) => m[1]!.split(" "));
    expect(words, "three state words").toHaveLength(3);
    for (const w of words) expect(w).toEqual(expect.arrayContaining(["max-w-full", "[overflow-wrap:anywhere]"]));
    expect(html).toContain(`>${messages["stream.chain.word.reconnecting"]}<`);
    expect(messages["stream.chain.word.reconnecting"]).toBe("Reconnecting…");
  });

  it("the strip renders INSIDE the chain card, after the group (Option B: the caret points up at the phone node)", () => {
    const html = renderToStaticMarkup(
      <SignalChain chain={chainFor(null)!} destination={DEST}>
        <p data-testid="strip-child">x</p>
      </SignalChain>,
    );
    const card = html.indexOf('data-testid="stream-chain"');
    const group = html.indexOf('role="group"');
    const child = html.indexOf('data-testid="strip-child"');
    expect([card >= 0, group > card, child > group]).toEqual([true, true, true]);
    expect(html.endsWith("</div>"), "the child is inside the card").toBe(true);
    expect(html.slice(child)).not.toMatch(/role="group"/);
  });

  // PR-2 (§7.4, Option A): the reserved `phoneStatus` slot is filled by the STRIP under the chain (the phone-health line is
  // one line in that strip), so the prop is gone — the chain itself draws no phone text beyond its node words.
  it("D9 → Option A: the chain takes no phoneStatus; its markup carries no phone-health text of its own", () => {
    const html = chainHtml(chainFor(liveOk)!);
    expect(html).not.toMatch(/Mbps|charging|heard/);
    expect(html).not.toContain("stream-phone-line");
  });

  it("the chain box has the 2px lime top border and a group label that reads the three states", () => {
    const html = chainHtml(chainFor(null)!);
    expect(html).toMatch(/border-t-2 border-\[var\(--mk-lime\)\]/);
    expect(html).toMatch(/role="group"[^>]*aria-label="Signal path: phone Not connected, Seazn Ready, YouTube Not live"/);
  });

  /** Each node's markup, keyed by its `data-node` — the mark is read off the node that DRAWS it, not off the page. */
  const nodesOf = (html: string) => {
    const parts = html.split(/(?=data-node=")/).slice(1);
    return Object.fromEntries(parts.map((p) => [/^data-node="([a-z]+)"/.exec(p)![1]!, p]));
  };

  it("every node names itself (phone, seazn, dest), once, in chain order", () => {
    expect(Object.keys(nodesOf(chainHtml(chainFor(liveOk)!)))).toEqual(["phone", "seazn", "dest"]);
  });

  it("the live dot and the D3 '!' are marks on the destination ring while the phone is sending, and only there", () => {
    const live = nodesOf(chainHtml(chainFor(liveOk)!));
    expect(live.dest!.match(/data-mark="dot"/g)?.length ?? 0).toBe(1);
    expect(Object.values(live).join("")).not.toMatch(/data-mark="bang"/);
    const warned = nodesOf(chainHtml(chainFor(liveWarned)!));
    expect(warned.dest!.match(/data-mark="bang"/g)?.length ?? 0).toBe(1);
    expect(warned.phone, "the phone is sending: no mark").not.toMatch(/data-mark=/);
    expect(Object.values(warned).join("")).not.toMatch(/data-mark="dot"/);
    expect(chainHtml(chainFor(null)!)).not.toMatch(/data-mark=/);
  });

  it("the phone silent past the hold: the '!' is drawn on the PHONE ring, the destination ring has none (ruling 2026-10-01)", () => {
    const silentWarned = nodesOf(chainHtml(chainFor(view("live", "disconnected", "connecting", W))!));
    expect(silentWarned.phone!.match(/data-mark="bang"/g)?.length ?? 0).toBe(1);
    expect(silentWarned.dest, "no '!' on the destination").not.toMatch(/data-mark=/);
    expect(silentWarned.seazn).not.toMatch(/data-mark=/);
  });

  it("the words come from the dictionary in the viewer's locale — French at 320 is French, never English", () => {
    const fr = dict("fr");
    const html = renderToStaticMarkup(
      <DictProvider dict={fr} locale="fr">
        <SignalChain chain={chainFor(liveWarned)!} destination={DEST} />
      </DictProvider>,
    );
    expect(html).toContain(`>${fr["stream.chain.word.notReceiving"]}<`);
    expect(html).toContain(`>${fr["stream.chain.phone"]}<`);
    expect(html).not.toContain(">Not receiving<");
  });

  // Owner ruling 2026-10-08 (B7 fix round 1, B): stalled → the Seazn node says "Waiting for video" in the viewer's locale;
  // healthy → "Receiving". Both directions, all four locales, from the chain the server's verdict draws.
  it("the Seazn node's stalled word, in every locale: 'Waiting for video' while the server says stalled, 'Receiving' when it does not", () => {
    const facts = (health: "stalled" | null) => ({
      present: true, silent: false, notResponding: false, model: "Pixel 8", appVersion: null, mode: "automatic" as const, state: "publishing" as const,
      notReady: null, notReadyShown: false, health, startFailed: null, lastBeatAt: "2026-10-08T12:00:00Z",
      elapsedMs: 4_000, beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null }, farPoll: false,
    });
    const seaznOf = (health: "stalled" | null, locale: Locale) => {
      const h = renderToStaticMarkup(
        <DictProvider dict={dict(locale)} locale={locale}>
          <SignalChain chain={chainFor(liveOk, { capture: { phone: facts(health), countdown: null } })!} destination={DEST} />
        </DictProvider>,
      );
      return h.split(/(?=data-node=")/).find((x) => x.startsWith('data-node="seazn"'))!;
    };
    expect(messages["stream.chain.word.waitingVideo"]).toBe("Waiting for video");
    let checked = 0;
    for (const locale of LOCALES) {
      const d = dict(locale);
      expect(d["stream.chain.word.waitingVideo"], locale).toBeTruthy();
      expect(d["stream.chain.word.waitingVideo"], `${locale}: its own word`).not.toBe(d["stream.chain.word.receiving"]);
      expect(seaznOf("stalled", locale), `${locale} stalled`).toContain(`>${d["stream.chain.word.waitingVideo"]}<`);
      expect(seaznOf("stalled", locale), `${locale} stalled`).not.toContain(`>${d["stream.chain.word.receiving"]}<`);
      expect(seaznOf(null, locale), `${locale} healthy`).toContain(`>${d["stream.chain.word.receiving"]}<`);
      expect(seaznOf(null, locale), `${locale} healthy`).not.toContain(`>${d["stream.chain.word.waitingVideo"]}<`);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
  });
});

describe("D3Warning (D3; I-1 — the cause decides the sentence)", () => {
  it("the key box (cause destination) is a status box naming the platform, with an Open Directory link to the Streaming tab in a new tab — 44 px on a phone", () => {
    const html = renderToStaticMarkup(<D3Warning cause="destination" kind="twitch" />);
    expect(html).toMatch(/data-testid="stream-output-warning"[^>]*data-cause="destination"/);
    expect(html).toMatch(/data-testid="stream-output-warning"[^>]*role="status"|role="status"[^>]*data-testid="stream-output-warning"/);
    expect(html).toContain(messages["stream.output.warning"].replace("{platform}", "Twitch").replace(/'/g, "&#x27;"));
    expect(html).toMatch(/data-testid="stream-output-open-directory"[^>]*href="\/directory\?tab=streaming"/);
    expect(html).toMatch(/data-testid="stream-output-open-directory"[^>]*target="_blank"/);
    expect(html).toMatch(/data-testid="stream-output-open-directory"[^>]*class="[^"]*min-h-11[^"]*md:min-h-0/);
    expect(html).toContain(`>${messages["stream.output.openDirectory"]}</a>`);
  });

  // I-1 (owner 2026-10-01, option a): the phone has no signal — the box points at the PHONE, in the owner's words, with
  // nothing to open in Directory (the key is not the problem); the same amber status box, the stream keeps running.
  it("the phone box (cause phone) says Seazn isn't getting video from the phone — the owner's sentence — and offers NO Directory link", () => {
    const html = renderToStaticMarkup(<D3Warning cause="phone" kind="twitch" />);
    expect(html).toMatch(/data-testid="stream-output-warning"[^>]*data-cause="phone"/);
    expect(html).toMatch(/data-testid="stream-output-warning"[^>]*role="status"|role="status"[^>]*data-testid="stream-output-warning"/);
    expect(messages["stream.output.phoneWarning"], "the owner's EN copy, verbatim").toBe(
      "Seazn isn't getting video from the phone. Check the phone is still streaming and has signal.",
    );
    expect(html).toContain(messages["stream.output.phoneWarning"].replace(/'/g, "&#x27;"));
    expect(html, "no Directory link").not.toContain("stream-output-open-directory");
    expect(html, "never the key sentence").not.toContain(messages["stream.output.warning"].split("{platform}")[0]!.replace(/'/g, "&#x27;"));
    expect(html, "amber, as the key box").toMatch(/border-amber-300 bg-amber-50/);
  });

  it("the phone box reads in the viewer's locale — every locale has its own sentence, never the English one", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const d = dict(locale);
      const text = d["stream.output.phoneWarning"];
      expect(text, `${locale}: the key exists`).toBeTruthy();
      if (locale !== "en") expect(text, `${locale}: translated`).not.toBe(dict("en")["stream.output.phoneWarning"]);
      const html = renderToStaticMarkup(
        <DictProvider dict={d} locale={locale}>
          <D3Warning cause="phone" kind="youtube" />
        </DictProvider>,
      );
      expect(html, locale).toContain(String(text).replace(/'/g, "&#x27;"));
      checked++;
    }
    expect(checked).toBe(4);
  });
});


describe("PhoneStripView — the phone's message under the chain (capture QR v2 §6.12, Option B rev 2)", () => {
  const strip = (props: Parameters<typeof PhoneStripView>[0], locale: Locale = "en") =>
    renderToStaticMarkup(
      <DictProvider dict={dict(locale)} locale={locale}>
        <PhoneStripView {...props} />
      </DictProvider>,
    );

  it("a status box with the tone's classes, the caret on the phone node, the icon and the sentence — slate for pair-first", () => {
    const html = strip({ id: "why-1", strip: { tone: "slate", icon: "phone", lead: null, body: { key: "stream.phone.pairFirst" } }, caret: true });
    expect(html).toMatch(/^<div id="why-1" data-testid="stream-phone-strip" data-tone="slate" data-icon="phone" role="status" class="relative mt-3 rounded-md border px-3 py-2 text-sm border-slate-200 bg-slate-50 text-slate-700">/);
    expect(html).toContain('class="absolute -top-[7px] left-[34px] h-3 w-3 rotate-45 border-l border-t border-slate-200 bg-slate-50 md:left-[42px]"');
    expect(html).toContain(">Pair a phone first: scan the code with Seazn Capture<");
  });

  it("amber with the lead in medium weight, and the countdown's durations in the locale, unbroken (whitespace-nowrap tabular-nums) — en and fr", () => {
    const props = {
      id: "s", caret: true,
      strip: { tone: "amber" as const, icon: "clock" as const, lead: "stream.phone.waitingVideo" as const, body: { key: "stream.phone.countdown.warming.no_inbound_timeout" as const, elapsedMs: 45_000, remainingMs: 555_000 } },
    };
    const en = strip(props);
    expect(en).toContain("border-amber-300 bg-amber-50 text-amber-900");
    expect(en).toContain(`<p class="font-medium">Waiting for the phone&#x27;s video</p>`);
    // The mockup's own sentence, verbatim — the duration is the server's 555 000 ms, never a clock read here.
    expect(en).toContain(`No video from the phone yet — the stream is cancelled in <span aria-live="off" class="whitespace-nowrap tabular-nums">9 min, 15 sec</span> if it doesn&#x27;t arrive.`);
    // French spaces with a narrow no-break space: the oracle is the platform's own Intl.DurationFormat, not a typed string.
    const DF = (Intl as unknown as { DurationFormat: new (l: string, o: object) => { format(d: object): string } }).DurationFormat;
    const fr = new DF("fr", { style: "short" }).format({ minutes: 9, seconds: 15 });
    expect(fr.replace(/\s/g, " ")).toBe("9 min et 15 s");
    expect(strip(props, "fr")).toContain(`<span aria-live="off" class="whitespace-nowrap tabular-nums">${fr}</span>`);
    const live = strip({ id: "l", caret: true, strip: { tone: "amber", icon: "clock", lead: null, body: { key: "stream.phone.countdown.live.phone_lost", elapsedMs: 160_000, remainingMs: 740_000 } } });
    expect(live).toContain(`No video from the phone for <span aria-live="off" class="whitespace-nowrap tabular-nums">2 min, 40 sec</span> — the stream ends in <span aria-live="off" class="whitespace-nowrap tabular-nums">12 min, 20 sec</span> if it doesn&#x27;t come back.`);
  });

  // B8 review m-5: the strip is a status region and the panel re-renders it on every poll. A duration that moves would
  // re-announce the whole sentence each time — so each duration is a live-OFF island, and nothing else in the box is.
  it("m-5: only the countdown's durations are aria-live=off — the box stays the status region, and the words around them stay live", () => {
    const html = strip({ id: "l", caret: true, strip: { tone: "amber", icon: "clock", lead: "stream.phone.waitingVideo", body: { key: "stream.phone.countdown.live.phone_lost", elapsedMs: 160_000, remainingMs: 740_000 } } });
    expect(html).toMatch(/^<div id="l" data-testid="stream-phone-strip"[^>]* role="status"/);
    const live = [...html.matchAll(/aria-live="([^"]+)"/g)].map((m) => m[1]);
    const durations = [...html.matchAll(/<span[^>]*tabular-nums[^>]*>/g)].map((m) => m[0]);
    expect(durations.length, "the sentence's two durations").toBe(2);
    for (const d of durations) expect(d).toContain('aria-live="off"');
    expect(live, "nothing else carries aria-live").toEqual(["off", "off"]);
    // An untimed sentence has no island at all.
    expect(strip({ id: "p", caret: true, strip: { tone: "slate", icon: "phone", lead: null, body: { key: "stream.phone.pairFirst" } } })).not.toContain("aria-live");
  });

  it("each icon is its own drawing (phone, alert, clock, pause), and no caret without a chain to point at", () => {
    const d = (icon: "phone" | "alert" | "clock" | "pause") => strip({ id: "i", caret: false, strip: { tone: "amber", icon, lead: null, body: { key: "stream.phone.paused.camera" } } });
    const svgs = (["phone", "alert", "clock", "pause"] as const).map((i) => /<svg[\s\S]*?<\/svg>/.exec(d(i))![0]);
    expect(new Set(svgs).size, "four distinct icons").toBe(4);
    expect(d("pause")).toContain('d="M10 9v6M14 9v6"');
    expect(d("pause")).not.toContain("rotate-45");
  });
});

// PR-2 (§7.4, §7.5; Option A, owner-approved 2026-10-07): the strip's info line, the amber lead with its one value, and
// the refusal's remedies — drawn from `phoneStrip`'s answer over REAL read-model shapes, so the line a customer reads is
// the builder's own output, never a literal typed on both ends.
describe("PhoneStripView — PR-2's line, lead values and remedies (Option A)", () => {
  type Facts = NonNullable<StreamPhone["phone"]>;
  const facts = (over: Partial<Facts> = {}): Facts => ({
    present: true, silent: false, notResponding: false, model: "Pixel 8", appVersion: "1.4.0", mode: "automatic", state: "publishing",
    notReady: null, notReadyShown: false, health: null, startFailed: null, lastBeatAt: "2026-10-08T12:00:00Z",
    elapsedMs: 4_000, beat: { battery: null, bitrateKbps: null, delivery: null, thermal: null, dataUsedMB: null }, farPoll: false, ...over,
  });
  const readModel = (f: Facts | null, over: Partial<StreamPhone> = {}): StreamPhone => ({
    code: { issuedAt: "2026-10-08T11:00:00Z", state: "active", endCause: null }, phone: f, destination: null, lastTakeover: null,
    auto: null, legacy: false, finished: false, session: null, ...over,
  });
  const live = { state: "live", ingest: { state: "connected", protocol: "srt" }, output: null, countdown: null } as unknown as StreamSessionCurrent;
  const html = (s: PhoneStrip, locale: Locale = "en", onBuy?: () => void) =>
    renderToStaticMarkup(
      <DictProvider dict={dict(locale)} locale={locale}>
        <PhoneStripView id="w" strip={s} caret onBuy={onBuy} />
      </DictProvider>,
    );
  /** The strip as a customer reads it: each tag a boundary, entities decoded, whitespace folded. */
  const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const BAT = { percent: 78, charging: true, drainPctPerHour: null };

  it("live and healthy: one slate line — the spec's own sentence, built from the read model; the bitrate in the locale (fr: a decimal comma)", () => {
    const strip = phoneStrip(readModel(facts({ beat: { battery: BAT, bitrateKbps: 2400, delivery: "ok", thermal: 1, dataUsedMB: 3 } })), live)!;
    const en = html(strip);
    expect(en).toMatch(/data-tone="slate"/);
    expect(text(en)).toBe("Phone · 78% charging · 2.4 Mbps · heard 4 s ago");
    expect(text(html(strip, "fr"))).toBe(`Téléphone · 78 % en charge · ${new Intl.NumberFormat("fr", { minimumFractionDigits: 1 }).format(2.4)} Mbps · dernier signal il y a 4 s`);
  });

  it("FP14: a Paired-phase beat (battery, thermal, bitrate null) — the line OMITS them: never '0 Mbps', never 'null' or 'undefined', no stray '%'", () => {
    const strip = phoneStrip(readModel(facts({ state: "paired" })), live)!;
    const out = text(html(strip));
    expect(out).toBe("Phone · heard 4 s ago");
    for (const bad of ["0 Mbps", "Mbps", "null", "undefined", "NaN", "%"]) expect(out, bad).not.toContain(bad);
  });

  it("each amber reason the SERVER names: the sentence in medium weight, the line beneath in small slate — not-responding names its seconds and stands alone", () => {
    let checked = 0;
    for (const health of HEALTH_REASONS) {
      const f = facts({ health, elapsedMs: 52_000, beat: { battery: { percent: 14, charging: false, drainPctPerHour: null }, bitrateKbps: 2400, delivery: "stalled", thermal: 4, dataUsedMB: 1 } });
      const h = html(phoneStrip(readModel(f), live)!);
      expect(h, health).toMatch(/data-tone="amber"/);
      const lead = /<p class="font-medium">([\s\S]*?)<\/p>/.exec(h)![1]!;
      const SPEC: Record<string, string> = {
        not_responding: "Phone not responding · last heard 52 s ago",
        stalled: "Video isn't reaching Seazn from the phone",
        hot: "The phone is running hot",
        battery_low: "Phone battery low (14%) — plug it in",
      };
      expect(text(lead), health).toBe(SPEC[health]);
      const line = /data-testid="stream-phone-line"[^>]*>([\s\S]*?)<\/p>/.exec(h);
      if (health === "not_responding") expect(line, health).toBeNull();
      else expect(text(line![1]!), health).toBe("Phone · 14% not charging · 2.4 Mbps · heard 52 s ago");
      expect(HEALTH_KEYS[health]).toBeTruthy();
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length);
  });

  it("m-5 holds for PR-2, and B7 review M-4: the WHOLE health line is aria-live=off (every reading ticks), the not-responding count is — the box stays the status region", () => {
    const healthy = html(phoneStrip(readModel(facts({ beat: { battery: BAT, bitrateKbps: 2400, delivery: "ok", thermal: 1, dataUsedMB: 3 } })), live)!);
    expect(healthy).toMatch(/^<div id="w" data-testid="stream-phone-strip"[^>]* role="status"/);
    expect([...healthy.matchAll(/aria-live="([^"]+)"/g)].map((m) => m[1])).toEqual(["off"]);
    expect(healthy, "the off is the LINE's own").toMatch(/<p data-testid="stream-phone-line" aria-live="off"/);
    const line = /<p data-testid="stream-phone-line"[^>]*>([\s\S]*?)<\/p>/.exec(healthy)![1]!;
    expect(text(line), "PREMISE: the line carries the ticking readings").toBe("Phone · 78% charging · 2.4 Mbps · heard 4 s ago");
    const lead = html(phoneStrip(readModel(facts({ health: "stalled" })), live)!);
    expect([...lead.matchAll(/aria-live="([^"]+)"/g)].map((m) => m[1]), "a lead above the line: only the line is off").toEqual(["off"]);
    expect(lead).toMatch(/<p data-testid="stream-phone-line" aria-live="off"/);
    const silent = html(phoneStrip(readModel(facts({ health: "not_responding", elapsedMs: 52_000 })), live)!);
    expect([...silent.matchAll(/aria-live="([^"]+)"/g)].map((m) => m[1])).toEqual(["off"]);
  });

  it("B7 review M-5: every READING on the line is one unbroken unit (nowrap) — only the model and the waiting sentence may wrap; every part kind is swept", () => {
    // One part of EVERY kind — `satisfies Record<kind, …>` makes a new kind a tsc error here until it is classed.
    const EVERY = {
      phone: { kind: "phone" }, model: { kind: "model", text: "Pixel 8" }, mode: { kind: "mode", mode: "automatic" },
      battery: { kind: "battery", percent: 78, charging: true }, bitrate: { kind: "bitrate", kbps: 2400 },
      heard: { kind: "heard", elapsedMs: 4_000 }, waiting: { kind: "waiting" },
    } satisfies { [K in PhoneLinePart["kind"]]: Extract<PhoneLinePart, { kind: K }> };
    const h = html({ tone: "slate", icon: "phone", lead: null, body: null, line: Object.values(EVERY) });
    const parts = [...h.matchAll(/<span data-line-part="([a-z]+)"( class="([^"]*)")?>/g)].map((m) => [m[1]!, m[3] ?? ""] as const);
    const WRAPS = new Set(["model", "waiting"]);
    let checked = 0;
    for (const [kind, cls] of parts) {
      expect(cls.split(" ").includes("whitespace-nowrap"), kind).toBe(!WRAPS.has(kind));
      checked++;
    }
    expect(parts.map(([k]) => k), "every kind rendered, once, in order").toEqual(Object.keys(EVERY));
    expect(checked).toBe(Object.keys(EVERY).length);
    // The builder's own healthy line: its readings are the nowrap ones.
    const real = html(phoneStrip(readModel(facts({ beat: { battery: BAT, bitrateKbps: 2400, delivery: "ok", thermal: 1, dataUsedMB: 3 } })), live)!);
    expect(real).toMatch(/<span data-line-part="bitrate" class="whitespace-nowrap">2.4 Mbps<\/span>/);
  });

  it("Ready, paired: the model, then the mode (muted) — Option A state 1", () => {
    const h = html(phoneStrip(readModel(facts({ state: "paired", mode: "operator" })), null)!);
    expect(text(h)).toBe("Pixel 8 · Operator");
  });

  it("the refusal: the reason sentence, and its remedy — Buy credits only with a handler (a button), Manage destinations a new-tab link to Directory → Streaming", () => {
    const auto = (refusal: "no_credit" | "no_destination" | "unavailable") => ({ enabled: true, refusal, wontStart: null, stopApplies: null });
    const noCredit = phoneStrip(readModel(facts({ state: "paired" }), { auto: auto("no_credit") }), null)!;
    const withBuy = html(noCredit, "en", () => {});
    expect(text(withBuy)).toBe("Automatic start couldn't begin: You need a match credit to go live. Buy credits");
    expect(withBuy).toMatch(/<button type="button" data-testid="stream-auto-remedy-buy" class="[^"]*min-h-11[^"]*"/);
    expect(html(noCredit), "no handler, no button").not.toContain("stream-auto-remedy-buy");
    const manage = html(phoneStrip(readModel(facts({ state: "paired" }), { auto: auto("no_destination") }), null)!);
    expect(manage).toMatch(/<a data-testid="stream-auto-remedy-manage" href="\/directory\?tab=streaming" target="_blank" rel="noopener" class="[^"]*min-h-11[^"]*"/);
    expect(text(manage)).toBe("Automatic start couldn't begin: This match has no destination to stream to. Manage destinations");
    const none = html(phoneStrip(readModel(facts({ state: "paired" }), { auto: auto("unavailable") }), null)!, "en", () => {});
    expect(none).not.toMatch(/stream-auto-remedy/);
    // B7 review M-6: the reason follows a colon mid-sentence — lower case in es/fr/nl, and "Automatic start" said naturally.
    expect(text(html(noCredit, "es", () => {}))).toBe("No se pudo iniciar automáticamente: necesitas un crédito para emitir. Comprar créditos");
    expect(text(html(noCredit, "fr", () => {}))).toBe("Impossible de démarrer automatiquement : il vous faut un crédit pour passer en direct. Acheter des crédits");
    expect(text(html(noCredit, "nl", () => {}))).toBe("Automatisch starten lukte niet: je hebt een tegoed nodig om live te gaan. Tegoed kopen");
  });
});
