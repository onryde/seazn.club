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
import { DestinationWarning, SignalChain } from "@/components/v2/stream-signal-chain";
import { platformName } from "@/components/v2/stream-platform-mark";
import { chainFor, type Chain } from "@/lib/stream-chain";
import { messages } from "@/lib/messages";
import { OUTPUT_WARNING_AFTER_MS } from "@/lib/stream-session-view";
import { StreamTargetKind } from "@/server/api-v1/schemas";
import type { Dict, Locale } from "@/lib/i18n-constants";

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

function chainHtml(chain: Chain, destination: { kind: (typeof StreamTargetKind.options)[number]; label: string } = DEST, phoneStatus?: string): string {
  return renderToStaticMarkup(<SignalChain chain={chain} destination={destination} phoneStatus={phoneStatus} />);
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
  it("each node may shrink below its 64 px on a zoomed phone (min-w-0, never shrink-0); its 40 px ring may not", () => {
    const html = chainHtml(chainFor(liveOk)!);
    const nodes = [...html.matchAll(/<div class="(flex w-16[^"]*)">/g)].map((m) => m[1]!);
    expect(nodes, "three nodes").toHaveLength(3);
    for (const cls of nodes) {
      expect(cls.split(" "), cls).toContain("min-w-0");
      expect(cls.split(" "), cls).not.toContain("shrink-0");
    }
    const rings = [...html.matchAll(/<span data-tone="[a-z]+" class="([^"]*)">/g)].map((m) => m[1]!);
    expect(rings, "three rings").toHaveLength(3);
    for (const cls of rings) expect(cls.split(" "), cls).toContain("shrink-0");
  });

  it("D9: phoneStatus is accepted and renders NOTHING in this branch", () => {
    const a = chainHtml(chainFor(liveOk)!, undefined, "🔋 64% · warm");
    const b = chainHtml(chainFor(liveOk)!);
    expect(a).toBe(b);
  });

  it("the chain box has the 2px lime top border and a group label that reads the three states", () => {
    const html = chainHtml(chainFor(null)!);
    expect(html).toMatch(/border-t-2 border-\[var\(--mk-lime\)\]/);
    expect(html).toMatch(/role="group"[^>]*aria-label="Signal path: phone Not connected, Seazn Ready, YouTube Not live"/);
  });

  it("the live dot and the D3 '!' are marks on the destination ring, and only there", () => {
    const live = chainHtml(chainFor(liveOk)!);
    expect(live.match(/data-mark="dot"/g)?.length ?? 0).toBe(1);
    expect(live).not.toMatch(/data-mark="bang"/);
    const warned = chainHtml(chainFor(liveWarned)!);
    expect(warned.match(/data-mark="bang"/g)?.length ?? 0).toBe(1);
    expect(warned).not.toMatch(/data-mark="dot"/);
    expect(chainHtml(chainFor(null)!)).not.toMatch(/data-mark=/);
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
});

describe("DestinationWarning (D3)", () => {
  it("is a status box naming the platform, with an Open Directory link to the Streaming tab in a new tab — 44 px on a phone", () => {
    const html = renderToStaticMarkup(<DestinationWarning kind="twitch" />);
    expect(html).toMatch(/data-testid="stream-output-warning"[^>]*role="status"|role="status"[^>]*data-testid="stream-output-warning"/);
    expect(html).toContain(messages["stream.output.warning"].replace("{platform}", "Twitch").replace(/'/g, "&#x27;"));
    expect(html).toMatch(/data-testid="stream-output-open-directory"[^>]*href="\/directory\?tab=streaming"/);
    expect(html).toMatch(/data-testid="stream-output-open-directory"[^>]*target="_blank"/);
    expect(html).toMatch(/data-testid="stream-output-open-directory"[^>]*class="[^"]*min-h-11[^"]*md:min-h-0/);
    expect(html).toContain(`>${messages["stream.output.openDirectory"]}</a>`);
  });
});
