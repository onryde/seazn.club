// renderSeaznQr's symbol (spec 2026-09-30 §7, owner ruling D7: every QR carries the Seazn logo, at EC H). The SVG the
// helper draws is rasterised by a real renderer (librsvg, inside sharp) and read back by a real decoder (jsQR), the
// pipeline `src/server/__tests__/_sheet-raster.ts` uses for the printed sheets — at EVERY size the page displays,
// each read from the binding sheet or from the component that paints it, never typed here.
//
// No sport is read anywhere on this path: a QR encodes a string, so one payload per call site is the sweep.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureQrV1 } from "@/lib/capture-qr";
import { qrText } from "@/lib/stream-session-view";
import {
  SEAZN_QR_ERROR_CORRECTION,
  SEAZN_QR_ICON_FRACTION,
  SEAZN_QR_ICON_PAD_MODULES,
  SEAZN_QR_QUIET_MODULES,
  seaznQrLayout,
  seaznQrSvg,
} from "../seazn-qr";
import { enlargedQrSize } from "../qr-enlarge";

const LOGO = `data:image/png;base64,${readFileSync(resolve(import.meta.dirname, "../../../public/logo-square.png")).toString("base64")}`;
const THEMES_PATH = resolve(import.meta.dirname, "../../../../../docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md");
const DLINK_PANEL_PATH = resolve(import.meta.dirname, "../../components/v2/device-link-panel.tsx");
const CHECKIN_PATH = resolve(import.meta.dirname, "../../components/v2/checkin-qr.tsx");

async function decode(svg: string, px: number): Promise<string | null> {
  const { data, info } = await sharp(Buffer.from(svg)).resize(px, px).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // jsQR reads RGBA; a raster that came back with fewer channels would be read as garbage, not as a failed scan.
  expect(info.channels, "the raster is RGBA").toBe(4);
  return jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height)?.data ?? null;
}

/** A realistic capture payload (spec §7: ≈ 435 bytes): the contract's shape (`lib/capture-qr`, parsed below so a shape
 *  drift fails here), Cloudflare's credential lengths — a 32-hex SRT stream id and 65-character secrets — serialised
 *  by the panel's own `qrText`. The contract's checked-in fixture is 352 bytes, too short to stand for the real one. */
function streamPayloadFixture(): string {
  const secret = (a: string, b: string) => `${a.repeat(32)}k${b.repeat(32)}`;
  const qr = CaptureQrV1.parse({
    v: 1,
    sid: "2a6a0d4e-7c1b-4e9a-9f2d-3b1c5d7e9f01",
    slot: 0,
    cred: {
      srt: { url: "srt://live.cloudflare.com:778", streamId: "f256e6ea9341d51eea64c9454659e576", passphrase: secret("a", "b"), latencyMs: 2000 },
      rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: secret("c", "d") },
    },
    preferred: "srt",
    exp: 1_790_000_000,
  });
  expect(qr.cred.srt.passphrase.length).toBe(65);
  expect(qr.cred.rtmps.streamKey.length).toBe(65);
  return qrText(qr);
}

const STREAM_PAYLOAD = streamPayloadFixture();
const DLINK = "https://seazn.club/score/" + "a".repeat(43);
const CHECKIN = "https://seazn.club/checkin/" + "b".repeat(43);

describe("renderSeaznQr's symbol (spec §7, D7)", () => {
  it("the stream payload is realistic in size — the test would be vacuous on a short string", () => {
    expect(STREAM_PAYLOAD.length).toBeGreaterThanOrEqual(400);
  });

  it("encodes at the declared EC level: the viewBox is the H symbol's size plus the quiet zone — and differs from the M size", () => {
    const h = QRCode.create(STREAM_PAYLOAD, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION }).modules.size;
    const m = QRCode.create(STREAM_PAYLOAD, { errorCorrectionLevel: "M" }).modules.size;
    expect(h).not.toBe(m);
    const svg = seaznQrSvg(STREAM_PAYLOAD, { size: 320, logoHref: LOGO });
    expect(svg).toContain(`viewBox="0 0 ${h + 2 * SEAZN_QR_QUIET_MODULES} ${h + 2 * SEAZN_QR_QUIET_MODULES}"`);
    expect(svg).toContain('width="320" height="320"');
  });

  it("the knock-out is the smallest ODD square holding the icon plus its pad, centred (scorer-sheet-pdf geometry)", () => {
    let checked = 0;
    for (const n of [21, 37, 81, 105, 177]) {
      const L = seaznQrLayout(n);
      expect(L.k % 2, `n=${n}`).toBe(1);
      expect(L.k, `n=${n}`).toBeGreaterThanOrEqual(n * SEAZN_QR_ICON_FRACTION + 2 * SEAZN_QR_ICON_PAD_MODULES);
      expect(L.k - 2, `n=${n}`).toBeLessThan(n * SEAZN_QR_ICON_FRACTION + 2 * SEAZN_QR_ICON_PAD_MODULES);
      expect(L.k0 * 2 + L.k, `n=${n}`).toBe(n);
      expect(L.total, `n=${n}`).toBe(n + 2 * SEAZN_QR_QUIET_MODULES);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("carries the logo, centred, at the icon fraction: x/y/width/height are the layout's own numbers", () => {
    let checked = 0;
    for (const text of [DLINK, STREAM_PAYLOAD]) {
      const n = QRCode.create(text, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION }).modules.size;
      const L = seaznQrLayout(n);
      const at = SEAZN_QR_QUIET_MODULES + (n - L.icon) / 2;
      const svg = seaznQrSvg(text, { size: 280, logoHref: LOGO });
      expect(svg).toContain(`<image href="${LOGO}" x="${at}" y="${at}" width="${L.icon}" height="${L.icon}"/>`);
      expect(L.icon).toBeCloseTo(n * SEAZN_QR_ICON_FRACTION, 10);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("no logo (a failed icon fetch): no <image>, and no module is knocked out — the symbol is QRCode's own, module for module", () => {
    const qr = QRCode.create(DLINK, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION });
    const n = qr.modules.size;
    const svg = seaznQrSvg(DLINK, { size: 280, logoHref: null });
    expect(svg).not.toContain("<image");
    // Count the dark modules the path draws (each run is `M x yh{len}v1h-{len}z`) against the matrix's own count.
    const drawn = [...svg.matchAll(/M\d+ \d+h(\d+)v1h-\d+z/g)].reduce((s, m) => s + Number(m[1]), 0);
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += qr.modules.get(r, c) === 1 ? 1 : 0;
    expect(dark, "premise: the symbol has dark modules").toBeGreaterThan(0);
    expect(drawn).toBe(dark);
    // …and WITH the logo, exactly the knock-out square's dark modules are gone.
    const L = seaznQrLayout(n);
    let knocked = 0;
    for (let r = L.k0; r < L.k0 + L.k; r++) for (let c = L.k0; c < L.k0 + L.k; c++) knocked += qr.modules.get(r, c) === 1 ? 1 : 0;
    const withLogo = seaznQrSvg(DLINK, { size: 280, logoHref: LOGO });
    const drawnWithLogo = [...withLogo.matchAll(/M\d+ \d+h(\d+)v1h-\d+z/g)].reduce((s, m) => s + Number(m[1]), 0);
    expect(knocked, "premise: the knock-out covers live modules").toBeGreaterThan(0);
    expect(drawnWithLogo).toBe(dark - knocked);
  });

  it("DECODES with the logo on, at every size the page DISPLAYS — read from the sheet and the components, never typed here", async () => {
    // The stream QR's measured sizes are the amended _THEMES.md §8a `QR size` row's (1280, 320, 320 @ 125 %, …).
    const row = readFileSync(THEMES_PATH, "utf8").split("\n").find((l) => l.startsWith("| QR size |"));
    expect(row, "§8a lost its QR size row").toBeDefined();
    const streamPx = [...row!.matchAll(/\*\*(\d+) CSS px at/g)].map((m) => Number(m[1]));
    expect(streamPx.length).toBeGreaterThanOrEqual(3); // 1280, 320, 320 @ 125 % — more if a width was measured below 320
    // Remote scoring and check-in: the display size their own components declare.
    const dlinkPx = 4 * Number(/dlink\.alt[^>]*\bw-(\d+)\b/.exec(readFileSync(DLINK_PANEL_PATH, "utf8"))![1]);
    const checkinPx = Number(/checkinQr\.alt[\s\S]{0,200}?width=\{(\d+)\}/.exec(readFileSync(CHECKIN_PATH, "utf8"))![1]);
    // D10: the enlarged overlay's size at the two e2e viewports.
    const enlarged = [enlargedQrSize(320, 568), enlargedQrSize(1280, 800)];
    const cases: [string, string, number][] = [
      ...streamPx.map((px) => ["stream", STREAM_PAYLOAD, px] as [string, string, number]),
      ["remote scoring", DLINK, dlinkPx],
      ["check-in", CHECKIN, checkinPx],
      ...enlarged.map((px) => ["stream enlarged", STREAM_PAYLOAD, px] as [string, string, number]),
    ];
    // jsQR has blind spots that are the DECODER's, not the symbol's: at a 1:1 raster it misses the v22 stream symbol at
    // roughly a third of exact pixel sizes WITH OR WITHOUT the logo (measured 2026-09-30 over 160–800 px in 8-px steps:
    // plain 57/81, with the logo 56/81, and qrcode's own logo-less PNG 56/81 — the module grid read back pixel-perfect
    // at the failing sizes). So a size where the logo symbol does not decode is accepted only when (a) the PLAIN symbol
    // fails there too — the logo is not the cause — and (b) the logo symbol decodes within ±4 px — it is readable at
    // this scale. A logo that breaks the code (a lower EC level, a knock-out over a finder) fails (a).
    let checked = 0;
    let exact = 0;
    const blind: string[] = [];
    for (const [name, text, px] of cases) {
      expect(px, `${name} size`).toBeGreaterThan(0);
      checked++;
      if ((await decode(seaznQrSvg(text, { size: px, logoHref: LOGO }), px)) === text) {
        exact++;
        continue;
      }
      const plain = await decode(seaznQrSvg(text, { size: px, logoHref: null }), px);
      expect(plain, `${name} @ ${px}px: the PLAIN symbol decodes where the logo one does not — the logo broke it`).not.toBe(text);
      let near: number | null = null;
      for (const d of [1, -1, 2, -2, 3, -3, 4, -4]) {
        if ((await decode(seaznQrSvg(text, { size: px + d, logoHref: LOGO }), px + d)) === text) {
          near = px + d;
          break;
        }
      }
      expect(near, `${name} @ ${px}px: nothing within ±4 px decodes — the symbol is unreadable at this scale`).not.toBeNull();
      blind.push(`${name} @ ${px}px (decodes @ ${near}px)`);
    }
    expect(checked).toBe(streamPx.length + 2 + enlarged.length);
    // Anti-vacuity: the blind-spot path must stay the exception (jsQR's measured rate is about a third), or the test
    // has stopped reading exact sizes at all.
    expect(exact, `exact decodes vs jsQR blind spots: ${blind.join("; ") || "none"}`).toBeGreaterThan(blind.length);
  });
});

describe("renderSeaznQr — the data URL the three call sites paint (the icon fetched once per page)", () => {
  /** A fresh module (its once-per-page cache starts empty) over a stubbed `fetch` and `FileReader` — node has no
   *  FileReader, and the icon's real bytes are what the browser would embed. */
  async function fresh(fetchImpl: () => Promise<Response>) {
    vi.resetModules();
    const fetchMock = vi.fn(fetchImpl);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        error: Error | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(b: Blob) {
          void b.arrayBuffer().then((buf) => {
            this.result = `data:${b.type};base64,${Buffer.from(buf).toString("base64")}`;
            this.onload?.();
          });
        }
      },
    );
    return { mod: await import("../seazn-qr"), fetchMock };
  }
  const svgOf = (url: string) => {
    expect(url).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    return decodeURIComponent(url.slice("data:image/svg+xml;charset=utf-8,".length));
  };
  const png = () => new Response(new Blob([readFileSync(resolve(import.meta.dirname, "../../../public/logo-square.png"))], { type: "image/png" }));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the icon is fetched ONCE for every QR on the page, from the logo path, and embedded as a data URL", async () => {
    const { mod, fetchMock } = await fresh(async () => png());
    const urls = [
      await mod.renderSeaznQr(STREAM_PAYLOAD, { size: 640 }),
      await mod.renderSeaznQr(DLINK, { size: 280 }),
      await mod.renderSeaznQr(CHECKIN, { size: 240 }),
    ];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(mod.SEAZN_QR_LOGO_PATH);
    let checked = 0;
    for (const url of urls) {
      expect(svgOf(url)).toContain(`<image href="${LOGO}"`);
      checked++;
    }
    expect(checked).toBe(3);
    expect(svgOf(urls[0]!)).toContain('width="640" height="640"');
  });

  it("a failed icon fetch still paints the QR — logo-less, the plain symbol — and the next QR tries the fetch again", async () => {
    let fail = true;
    const { mod, fetchMock } = await fresh(async () => (fail ? new Response("nope", { status: 404 }) : png()));
    const without = svgOf(await mod.renderSeaznQr(DLINK, { size: 280 }));
    expect(without).not.toContain("<image");
    expect(without).toBe(seaznQrSvg(DLINK, { size: 280, logoHref: null }));
    fail = false;
    const withLogo = svgOf(await mod.renderSeaznQr(DLINK, { size: 280 }));
    expect(fetchMock, "the failure was not cached").toHaveBeenCalledTimes(2);
    expect(withLogo).toContain(`<image href="${LOGO}"`);
  });
});
