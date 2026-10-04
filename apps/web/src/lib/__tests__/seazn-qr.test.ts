// renderSeaznQr's symbol (spec 2026-09-30 §7, owner ruling D7: every QR carries the Seazn logo, at EC H). The SVG the
// helper draws is rasterised by a real renderer (librsvg, inside sharp) and read back by a real decoder (jsQR), the
// pipeline `src/server/__tests__/_sheet-raster.ts` uses for the printed sheets — at EVERY size the page paints, each
// read from the binding sheet or from the component that paints it, never typed here.
//
// B6 fix round 1 (controller rulings I-1, I-2): every payload is built by the REAL builder at a realistic length — the
// check-in link by `mintCheckinToken`, the Remote scoring link by `mintDeviceLinkSecret`, the capture payload from the
// relay's own constants — and every painted size is a whole number of device px per module (`snapQrSize`), where the
// symbol decodes EXACTLY. There is no tolerance window: a size that does not decode is a red.
//
// No sport is read anywhere on this path: a QR encodes a string, so one payload per call site is the sweep.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CaptureQrV2, captureQrV2Text } from "@/lib/capture-qr";
import { routes } from "@/lib/routes";
import { mintCheckinToken } from "@/server/usecases/checkin-token";
import { endOfLocalDay, mintDeviceLinkSecret } from "@/server/usecases/device-links";
import { renderScorerSheetPdf } from "@/server/scorer-sheet-pdf";
import { header as sheetHeader, model as sheetModel, row as sheetRow, useBrandFonts } from "@/server/__tests__/_sheet-fixtures";
import { pdfImages, pdfLinks } from "../../../e2e/pdf-uris";
import {
  SEAZN_QR_ERROR_CORRECTION,
  SEAZN_QR_ICON_FRACTION,
  SEAZN_QR_ICON_PAD_MODULES,
  SEAZN_QR_LOGO_PATH,
  SEAZN_QR_QUIET_MODULES,
  seaznQrLayout,
  seaznQrModules,
  seaznQrSvg,
} from "../seazn-qr";

/** The public file at a site path — what the browser's fetch of that path returns. */
const publicFile = (path: string) => readFileSync(resolve(import.meta.dirname, "../../../public", `.${path}`));
/** The icon the page REALLY embeds: the file at the helper's declared path, never a copy named here (review m-8). */
const LOGO = `data:image/png;base64,${publicFile(SEAZN_QR_LOGO_PATH).toString("base64")}`;
/** Spec §7's logo and the printed sheets' (`scorer-sheet-pdf.ts` reads the same file). */
const SHEET_LOGO_PATH = "/logo-square.png";
const THEMES_PATH = resolve(import.meta.dirname, "../../../../../docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md");
const DLINK_PANEL_PATH = resolve(import.meta.dirname, "../../components/v2/device-link-panel.tsx");
const CHECKIN_PATH = resolve(import.meta.dirname, "../../components/v2/checkin-qr.tsx");
const SHEET_PDF_PATH = resolve(import.meta.dirname, "../../server/scorer-sheet-pdf.ts");
/** The production origin (`lib/site-origin.ts`'s fallback): the LONGEST origin a real link carries today, so the
 *  symbol here is at least the version a real one is. */
const ORIGIN = "https://seazn.club";

async function decode(svg: string, px: number): Promise<string | null> {
  const { data, info } = await sharp(Buffer.from(svg)).resize(px, px).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // jsQR reads RGBA; a raster that came back with fewer channels would be read as garbage, not as a failed scan.
  expect(info.channels, "the raster is RGBA").toBe(4);
  expect(info.width, "the raster is the painted size, not librsvg's own").toBe(px);
  return jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height)?.data ?? null;
}

/** The capture payload v2 (spec 2026-10-01 §6.2, W3) as the panel shows it: the contract's shape (`lib/capture-qr`'s
 *  CaptureQrV2, parsed so a shape drift fails here) — a 12-character code over §6.2's alphabet and a 16-byte tok in
 *  base64url, as `stream-codes.ts` mints them — serialised by the panel's own `captureQrV2Text`. Every field is fixed
 *  length (slot 0 in PR-1), so every real payload is this length: there is no longer a "realistic" length to reach. */
function streamPayloadFixture(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const code = Array.from(randomBytes(12), (b) => alphabet[b % alphabet.length]).join("");
  const qr = CaptureQrV2.parse({ v: 2, code, slot: 0, tok: randomBytes(16).toString("base64url") });
  return captureQrV2Text(qr);
}

/** The Remote scoring link as `device-link-panel.tsx` builds it (`${origin}/score/${secret}`), over a REAL secret. */
const dlinkPayload = (): string => `${ORIGIN}/score/${mintDeviceLinkSecret()}`;
/** The check-in link as `/api/v1/fixtures/[id]/checkin-link` builds it: a REAL signed token, valid to the end of the
 *  fixture's local day, on the check-in route. */
const checkinPayload = async (): Promise<string> =>
  `${ORIGIN}${routes.checkin(await mintCheckinToken(randomUUID(), endOfLocalDay(new Date(), "Europe/London")))}`;

const STREAM_PAYLOAD = streamPayloadFixture();
const DLINK = dlinkPayload();
const CHECKIN = await checkinPayload();

/** The byte capacity of a version at EC H — QRCode's own table, so a length floor is stated in the encoder's terms. */
function capacityH(version: number): number {
  let lo = 1;
  let hi = 3000;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    try {
      QRCode.create("a".repeat(m), { errorCorrectionLevel: "H", version });
      lo = m;
    } catch {
      hi = m - 1;
    }
  }
  return lo;
}

describe("the three payloads are the REAL ones, at their real length (ruling I-1: a toy string under-sizes the symbol)", () => {
  it("each payload is at least as long as the symbol version a real one needs — a length floor per row", () => {
    // [name, payload, the version a real payload reaches at EC H]
    const rows: [string, string, number][] = [
      ["stream capture", STREAM_PAYLOAD, 8], // 69 B: QR v2's four keys, every field fixed length (capture QR v2 §6.2)
      ["check-in", CHECKIN, 16], // ≈ 229 B: an HS256 JWT over { fid }, iat and exp (review I-1: 229-232)
      ["Remote scoring", DLINK, 8], // 71 B: `dl_` + 43 base64url characters
    ];
    let checked = 0;
    for (const [name, text, version] of rows) {
      // Longer than the version below it can hold, so the symbol is at least that version — what a real one paints.
      expect(text.length, `${name}: ${text.length} B`).toBeGreaterThan(capacityH(version - 1));
      expect(QRCode.create(text, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION }).version, name).toBeGreaterThanOrEqual(version);
      checked++;
    }
    expect(checked).toBe(3);
    expect(CHECKIN).toMatch(/^https:\/\/seazn\.club\/checkin\/eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(DLINK).toMatch(/^https:\/\/seazn\.club\/score\/dl_[\w-]{43}$/);
  });
});

describe("renderSeaznQr's symbol (spec §7, D7)", () => {
  it("the stream payload is the v2 one at its fixed length — 69 B, the four keys, no credential", () => {
    expect(STREAM_PAYLOAD.length).toBe(69);
    expect(Object.keys(JSON.parse(STREAM_PAYLOAD))).toEqual(["v", "code", "slot", "tok"]);
  });

  it("encodes at the declared EC level: the viewBox is the H symbol's size plus the quiet zone — and differs from the M size", () => {
    const h = QRCode.create(STREAM_PAYLOAD, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION }).modules.size;
    const m = QRCode.create(STREAM_PAYLOAD, { errorCorrectionLevel: "M" }).modules.size;
    expect(h).not.toBe(m);
    const total = h + 2 * SEAZN_QR_QUIET_MODULES;
    const svg = seaznQrSvg(STREAM_PAYLOAD, { logoHref: LOGO });
    expect(svg).toContain(`viewBox="0 0 ${total} ${total}"`);
    // Its intrinsic size is one px per module (a whole scale even unstyled); the page paints it at a snapped size.
    expect(svg).toContain(`width="${total}" height="${total}"`);
    expect(seaznQrSvg(STREAM_PAYLOAD, { logoHref: LOGO, size: 678 })).toContain('width="678" height="678"');
    expect(seaznQrModules(STREAM_PAYLOAD), "the module count the page snaps to is the symbol's, quiet zone included").toBe(total);
    expect(seaznQrModules(DLINK)).toBe(QRCode.create(DLINK, { errorCorrectionLevel: "H" }).modules.size + 2 * SEAZN_QR_QUIET_MODULES);
  });

  // Review m-4 (minor tail): nothing typed. The icon's side is the sheet's own declared `ICON`, checked against the icon
  // a REAL sheet prints; the symbol it sits on is measured off that sheet; the screen's fraction is §8a's binding row.
  // The brief's "12 mm on a ~152 pt symbol ≈ 0.22" was a false premise: a real Remote scoring link prints a v8 symbol of
  // about 132 pt under the default header (12 mm = 0.26 of it) and 108 pt under the tallest one (0.31). So the screen's
  // 0.22 is NOT the print's ratio — it is pinned to §8a, and held at or under the print's, where the knock-out is
  // proven to decode in every print condition (`scorer-sheet-pdf.test.ts`, `_sheet-raster.ts`).
  describe("the logo's size against the printed sheets' (review m-4)", () => {
    beforeAll(useBrandFonts);
    it("§8a's fraction, the sheet's own ICON and ICON_PAD — and never a larger knock-out than a real printed sheet's", async () => {
      const source = readFileSync(SHEET_PDF_PATH, "utf8");
      expect(/const MM = 72 \/ 25\.4;/.test(source), "scorer-sheet-pdf.ts still measures in points per millimetre").toBe(true);
      const iconMm = Number(/const ICON = (\d+(?:\.\d+)?) \* MM;/.exec(source)?.[1]);
      const iconPad = Number(/const ICON_PAD = (\d+);/.exec(source)?.[1]);
      expect(iconMm, "drawBrandQr declares its ICON in millimetres").toBeGreaterThan(0);
      expect(SEAZN_QR_ICON_PAD_MODULES, "the white pad round the icon, in modules — drawBrandQr's ICON_PAD").toBe(iconPad);
      const encodingRow = readFileSync(THEMES_PATH, "utf8").split("\n").find((l) => l.startsWith("| QR encoding |"));
      const bound = /the icon covers ([\d.]+) of the symbol/.exec(encodingRow ?? "");
      expect(bound, "§8a's QR encoding row states the icon's fraction").not.toBeNull();
      expect(SEAZN_QR_ICON_FRACTION, "§8a's QR encoding row").toBe(Number(bound![1]));
      const tallHeader = {
        ...sheetHeader,
        title: "Northern Counties Inter-Club Badminton Championships — Autumn Series Finals 2026",
        branding: { orgName: "Riverside Shuttlers", logos: [] },
      };
      const ratios: string[] = [];
      let checked = 0;
      for (const [name, h] of [["default header", sheetHeader], ["tallest header", tallHeader]] as const) {
        // A real Remote scoring link on every card: the sheet prints the same `/score/<secret>` URL the panel does.
        const pdf = await renderScorerSheetPdf({ ...sheetModel([[1, 2, 3].map((i) => sheetRow(i, { url: DLINK }))]), header: h });
        const icons = pdfImages(pdf);
        const symbols = pdfLinks(pdf);
        expect(icons.length, `${name}: one icon per card`).toBe(symbols.length);
        for (const [i, symbol] of symbols.entries()) {
          expect(icons[i]!.width, `${name}: the printed icon IS the declared ICON`).toBeCloseTo((iconMm * 72) / 25.4, 2);
          const ratio = icons[i]!.width / symbol.width;
          ratios.push(`${name} ${symbol.width.toFixed(1)} pt → ${ratio.toFixed(3)}`);
          expect(SEAZN_QR_ICON_FRACTION, `${name}: the screen knocks out no more than the print (${ratios.at(-1)})`).toBeLessThanOrEqual(ratio);
          checked++;
        }
      }
      expect(checked, ratios.join("; ")).toBe(6);
    });
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
      const svg = seaznQrSvg(text, { logoHref: LOGO });
      expect(svg).toContain(`<image href="${LOGO}" x="${at}" y="${at}" width="${L.icon}" height="${L.icon}"/>`);
      expect(L.icon).toBeCloseTo(n * SEAZN_QR_ICON_FRACTION, 10);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("no logo (a failed icon fetch): no <image>, and no module is knocked out — the symbol is QRCode's own, module for module", () => {
    const qr = QRCode.create(DLINK, { errorCorrectionLevel: SEAZN_QR_ERROR_CORRECTION });
    const n = qr.modules.size;
    const svg = seaznQrSvg(DLINK, { logoHref: null });
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
    const withLogo = seaznQrSvg(DLINK, { logoHref: LOGO });
    const drawnWithLogo = [...withLogo.matchAll(/M\d+ \d+h(\d+)v1h-\d+z/g)].reduce((s, m) => s + Number(m[1]), 0);
    expect(knocked, "premise: the knock-out covers live modules").toBeGreaterThan(0);
    expect(drawnWithLogo).toBe(dark - knocked);
  });

  it("DECODES EXACTLY with the logo on, at every size the page PAINTS — whole device px per module, at 1×, 2× and 3× (ruling I-2)", async () => {
    // The sizes: each box the page paints into, read from the binding sheet or the component that owns it, snapped by
    // the rule's own arithmetic (modules × ⌊box × DPR ÷ modules⌋ device px) — written out here, not snapQrSize's.
    const row = readFileSync(THEMES_PATH, "utf8").split("\n").find((l) => l.startsWith("| QR size |"));
    expect(row, "§8a lost its QR size row").toBeDefined();
    const sheetNum = (re: RegExp, what: string) => {
      const m = re.exec(row!);
      expect(m, `§8a's QR size row no longer states ${what}`).not.toBeNull();
      return Number(m![1]);
    };
    const streamCap = sheetNum(/min\((\d+)px, available\)/, "min(Npx, available)");
    const avail320 = sheetNum(/of an `available` of \*\*(\d+)\*\* at 320 \(fixture page\)/, "the 320 available");
    const avail125 = sheetNum(/of an `available` of \*\*(\d+)\*\* at 320 @ 125 % zoom/, "the 125 % available");
    const declared = (path: string, name: string) => {
      const m = new RegExp(`const ${name} = (\\d+);`).exec(readFileSync(path, "utf8"));
      expect(m, `${name} is declared`).not.toBeNull();
      return Number(m![1]);
    };
    const dlinkCap = declared(DLINK_PANEL_PATH, "DLINK_QR_MAX_PX");
    const checkinCap = declared(CHECKIN_PATH, "CHECKIN_QR_MAX_PX");
    // D10's enlarged room at the e2e's two viewports, in the ruling's own words (the caption's room binds only on a
    // near-square screen).
    const enlarged = [Math.min(320, 568) - 2 * 16, Math.min(1280, 800) - 2 * 16];
    const devicePx = (box: number, modules: number, dpr: number) => modules * Math.floor((box * dpr) / modules);
    type Case = { name: string; text: string; box: number; dpr: number };
    const cases: Case[] = [];
    for (const dpr of [1, 2, 3]) {
      cases.push({ name: "stream @ the cap (1280, 768)", text: STREAM_PAYLOAD, box: streamCap, dpr });
      cases.push({ name: "stream @ 320", text: STREAM_PAYLOAD, box: avail320, dpr });
      cases.push({ name: "Remote scoring @ its cap", text: DLINK, box: dlinkCap, dpr });
      cases.push({ name: "check-in @ its cap", text: CHECKIN, box: checkinCap, dpr });
    }
    // 320 @ 125 % zoom: on a 1× desktop panel (DPR 1.25, the edge) and on a phone (a 320-CSS-px phone is 2×, so 2.5).
    cases.push({ name: "stream @ 320 @ 125 % zoom, 1× desktop panel", text: STREAM_PAYLOAD, box: avail125, dpr: 1.25 });
    cases.push({ name: "stream @ 320 @ 125 % zoom, phone", text: STREAM_PAYLOAD, box: avail125, dpr: 2.5 });
    for (const box of enlarged) {
      cases.push({ name: `stream enlarged ${box}`, text: STREAM_PAYLOAD, box, dpr: 1 });
      cases.push({ name: `Remote scoring enlarged ${box}`, text: DLINK, box, dpr: 1 });
      cases.push({ name: `check-in enlarged ${box}`, text: CHECKIN, box, dpr: 1 });
    }
    let checked = 0;
    const seen = new Set<string>();
    const misses: string[] = [];
    for (const c of cases) {
      const modules = seaznQrModules(c.text);
      const px = devicePx(c.box, modules, c.dpr);
      expect(px, `${c.name}: at least one device px per module`).toBeGreaterThanOrEqual(modules);
      if ((await decode(seaznQrSvg(c.text, { size: px, logoHref: LOGO }), px)) !== c.text) misses.push(`${c.name} @ ${px} device px (${c.dpr}×)`);
      seen.add(`${c.name}/${px}`);
      checked++;
    }
    expect(misses, "every painted size decodes exactly — no tolerance window").toEqual([]);
    expect(checked).toBe(3 * 4 + 2 + 3 * enlarged.length);
    expect(seen.size, "the rows are distinct sizes, not one size checked many times").toBeGreaterThan(15);
  });

  it("the check-in QR paints at ≥ 3 px per module for a REAL check-in link, and Remote scoring at ≥ 3 too (ruling I-1)", () => {
    const rows: [string, string, string, string][] = [
      ["check-in", CHECKIN, CHECKIN_PATH, "CHECKIN_QR_MAX_PX"],
      ["Remote scoring", DLINK, DLINK_PANEL_PATH, "DLINK_QR_MAX_PX"],
    ];
    let checked = 0;
    for (const [name, text, path, constant] of rows) {
      const cap = Number(new RegExp(`const ${constant} = (\\d+);`).exec(readFileSync(path, "utf8"))?.[1]);
      const modules = seaznQrModules(text);
      expect(Math.floor(cap / modules), `${name}: ${cap} px over ${modules} modules`).toBeGreaterThanOrEqual(3);
      checked++;
    }
    expect(checked).toBe(2);
  });

  // T11 owns §6.2's size gate: the v2 payload (69 B) is a v8 symbol, 49 modules and the quiet zone — 57 — so the sheet's
  // painted figures move with it. The premise is QRCode's own, never seaznQrModules' alone.
  it("the sheet's painted figures ARE the rule applied to its own `available` figures, for the v2 payload (v8)", () => {
    const row = readFileSync(THEMES_PATH, "utf8").split("\n").find((l) => l.startsWith("| QR size |"))!;
    const modules = seaznQrModules(STREAM_PAYLOAD);
    const symbol = QRCode.create(STREAM_PAYLOAD, { errorCorrectionLevel: "H" });
    expect([symbol.version, symbol.modules.size], "premise: the v2 payload is a v8 symbol at EC H — 49 modules").toEqual([8, 49]);
    expect(modules, "…and the quiet zone").toBe(49 + 2 * SEAZN_QR_QUIET_MODULES);
    expect(row).toContain(`${modules} for the v2 payload (v8)`);
    // [painted, available, DPR, the floor in device px per module]
    const figures: [RegExp, RegExp, number, number][] = [
      [/\*\*([\d.]+) CSS px at 1280\*\*/, /min\((\d+)px, available\)/, 1, 3],
      [/\*\*([\d.]+) CSS px at 320 \(fixture page\)\*\*/, /of an `available` of \*\*(\d+)\*\* at 320 \(fixture page\)/, 1, 2],
      // The 125 % controller ruling (option c): a PHONE at 125 % is DPR 2.5 and holds three px per module…
      [/\*\*([\d.]+) CSS px at 320 @ 125 % zoom on a phone \(DPR 2\.5\)\*\*/, /of an `available` of \*\*(\d+)\*\* at 320 @ 125 % zoom/, 2.5, 3],
      // …and the 1× desktop panel's DPR 1.25 is the edge: one px per module inline, the enlarged view its scan surface.
      [/\*\*([\d.]+) CSS px at 320 @ 125 % zoom on a 1× desktop panel \(DPR 1\.25\)\*\*/, /of an `available` of \*\*(\d+)\*\* at 320 @ 125 % zoom/, 1.25, 1],
    ];
    let checked = 0;
    for (const [paintedRe, availRe, dpr, floor] of figures) {
      const painted = Number(paintedRe.exec(row)?.[1]);
      const available = Number(availRe.exec(row)?.[1]);
      expect(painted, String(paintedRe)).toBeGreaterThan(0);
      const k = Math.floor((available * dpr) / modules);
      expect(painted, `${painted} of ${available} @ ${dpr}×`).toBeCloseTo((modules * k) / dpr, 1);
      expect(k, `${painted} CSS px @ ${dpr}×: device px per module`).toBeGreaterThanOrEqual(floor);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe("renderSeaznQr — the data URL the three call sites paint (the icon fetched once per page)", () => {
  /** A fresh module (its once-per-page cache starts empty) over a stubbed `fetch` and `FileReader` — node has no
   *  FileReader, and the icon's real bytes are what the browser would embed. */
  async function fresh(fetchImpl: (input: string) => Promise<Response>) {
    vi.resetModules();
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(fetchImpl);
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
  /** What the browser's fetch of a site path answers: the public file's real bytes. */
  const png = (path: string = SEAZN_QR_LOGO_PATH) => new Response(new Blob([publicFile(path)], { type: "image/png" }));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the icon is fetched ONCE for every QR on the page, from the logo path, and embedded as a data URL; each QR carries its module count", async () => {
    const { mod, fetchMock } = await fresh(async (path) => png(path));
    const texts = [STREAM_PAYLOAD, DLINK, CHECKIN];
    const qrs = [];
    for (const text of texts) qrs.push(await mod.renderSeaznQr(text));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(mod.SEAZN_QR_LOGO_PATH);
    let checked = 0;
    for (const [i, qr] of qrs.entries()) {
      expect(svgOf(qr.src)).toContain(`<image href="${LOGO}"`);
      // The count the page snaps to is the symbol's own (QRCode's matrix plus the quiet zone), not a second encode's.
      const total = QRCode.create(texts[i]!, { errorCorrectionLevel: "H" }).modules.size + 2 * SEAZN_QR_QUIET_MODULES;
      expect(qr.modules).toBe(total);
      expect(svgOf(qr.src)).toContain(`viewBox="0 0 ${total} ${total}"`);
      checked++;
    }
    expect(checked).toBe(3);
    // The v2 capture payload (69 B) and the Remote scoring link (71 B) are both v8 since T11, so the sizes are two, not
    // three — the check-in symbol (v16) is the one that tells a shared count from a per-payload one.
    expect(new Set(qrs.map((q) => q.modules)).size, "the payloads' own distinct symbol sizes").toBe(
      new Set(texts.map((t) => QRCode.create(t, { errorCorrectionLevel: "H" }).modules.size)).size,
    );
    expect(new Set(qrs.map((q) => q.modules)).size, "PREMISE: at least two sizes to tell apart").toBeGreaterThanOrEqual(2);
  });

  it("a failed icon fetch still paints the QR — logo-less, the plain symbol — and the next QR tries the fetch again", async () => {
    let fail = true;
    const { mod, fetchMock } = await fresh(async () => (fail ? new Response("nope", { status: 404 }) : png()));
    const without = svgOf((await mod.renderSeaznQr(DLINK)).src);
    expect(without).not.toContain("<image");
    expect(without).toBe(seaznQrSvg(DLINK, { logoHref: null }));
    fail = false;
    const withLogo = svgOf((await mod.renderSeaznQr(DLINK)).src);
    expect(fetchMock, "the failure was not cached").toHaveBeenCalledTimes(2);
    expect(withLogo).toContain(`<image href="${LOGO}"`);
  });

  it("an icon fetch that NEVER answers (review m-8): the QR paints logo-less after the timeout, the fetch is aborted, and the next QR tries again", async () => {
    vi.useFakeTimers();
    try {
      const signals: (AbortSignal | undefined)[] = [];
      let hang = true;
      const { mod, fetchMock } = await fresh(async () => png());
      fetchMock.mockImplementation(async (_input, init) => {
        signals.push(init?.signal ?? undefined);
        return hang ? new Promise<Response>(() => {}) : png();
      });
      expect(mod.SEAZN_QR_LOGO_TIMEOUT_MS, "a short wait: the QR is the point, the logo is dressing").toBeLessThanOrEqual(3000);
      let settled: { src: string; modules: number } | null = null;
      void mod.renderSeaznQr(DLINK).then((q) => (settled = q));
      await vi.advanceTimersByTimeAsync(mod.SEAZN_QR_LOGO_TIMEOUT_MS - 1);
      expect(settled, "still waiting just before the timeout").toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled, "the QR painted at the timeout").not.toBeNull();
      expect(svgOf(settled!.src)).toBe(seaznQrSvg(DLINK, { logoHref: null }));
      expect(signals[0]?.aborted, "the hung request was aborted, not left open").toBe(true);
      hang = false;
      vi.useRealTimers();
      const next = svgOf((await mod.renderSeaznQr(DLINK)).src);
      expect(fetchMock, "a timed-out fetch is not cached").toHaveBeenCalledTimes(2);
      expect(next).toContain(`<image href="${LOGO}"`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the data URL each QR paints carries the 192-px icon, not the 512-px logo — under 40 % of its weight (review m-8)", async () => {
    // Measured through the real path: the page's fetch answered with the public file at the declared path, against the
    // same symbol drawn with spec §7's 512-px logo-square.png (the printed sheets' file).
    const { mod } = await fresh(async (path) => png(path));
    const sheetLogo = `data:image/png;base64,${publicFile(SHEET_LOGO_PATH).toString("base64")}`;
    const sizes: string[] = [];
    let checked = 0;
    for (const [name, text] of [["stream", STREAM_PAYLOAD], ["check-in", CHECKIN], ["Remote scoring", DLINK]] as const) {
      const painted = (await mod.renderSeaznQr(text)).src.length;
      const heavy = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(seaznQrSvg(text, { logoHref: sheetLogo }))}`.length;
      sizes.push(`${name} ${(painted / 1000).toFixed(1)} kB (was ${(heavy / 1000).toFixed(1)})`);
      expect(painted, `${name}: ${sizes.at(-1)}`).toBeLessThan(0.4 * heavy);
      checked++;
    }
    expect(checked, sizes.join("; ")).toBe(3);
  });

  it("the 192-px icon IS the sheets' logo, downscaled — the same artwork, so the screen and the print carry one mark", async () => {
    const small = await sharp(publicFile(SEAZN_QR_LOGO_PATH)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const big = await sharp(publicFile(SHEET_LOGO_PATH)).resize(small.info.width, small.info.height).ensureAlpha().raw().toBuffer();
    expect(small.info.width, "a square icon").toBe(small.info.height);
    expect(small.info.width, "smaller than the sheet's logo, or the swap saved nothing").toBeLessThan((await sharp(publicFile(SHEET_LOGO_PATH)).metadata()).width!);
    expect(big.length).toBe(small.data.length);
    let diff = 0;
    for (let i = 0; i < big.length; i++) diff += Math.abs(big[i]! - small.data[i]!);
    // Resampling alone differs by under one level in 255 on average; a different picture differs by tens.
    expect(diff / big.length, "mean per-channel difference, in levels of 255").toBeLessThan(2);
  });
});
