// The division logo upload (division-settings.tsx `uploadLogo`) has three failures of its own: the picked file is not a
// usable image, the canvas could not turn it into a WebP, and the storage PUT was refused. They used to be bare English
// `Error`s ("bad image", "image conversion failed", "upload failed (403)") that `run()` showed through
// `settingsSaveErrorText` - so an organiser on a Dutch screen read English, and once FU5 made every non-server Error say
// "couldn't reach Seazn", they would have been told the network was down about a file that is simply not an image.
//
// `apps/web` vitest is node-only: there is no DOM to mount DivisionSettings in and click the file input. So this drives the
// two extracted helpers `uploadLogo` is built from (`fileToWebp`, `putLogo`) with stand-ins for the four browser APIs they
// touch (FileReader, Image, the canvas, fetch), and runs what they throw through the same `settingsSaveErrorText` that
// `run()` renders. The expected sentences are read from the dictionaries, never typed here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { fileToWebp, putLogo } from "@/lib/division-logo-upload";
import { settingsSaveErrorText } from "@/lib/config-issue-copy";
import type { MessageKey } from "@/lib/messages";

type Dict = Record<string, string>;
const LOCALES = [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const;
const KEYS = {
  badImage: "divset.logo.badImage",
  convertFailed: "divset.logo.convertFailed",
  uploadFailed: "divset.logo.uploadFailed",
} as const satisfies Record<string, MessageKey>;
const UNREACHABLE = "save.err.unreachable" as const satisfies MessageKey;
const reader = (dict: Dict) => (key: MessageKey) => dict[key]!;

/** One knob per browser API `fileToWebp` touches. */
const browser = { readFails: false, imageFails: false, blobFails: false, ctxFails: false, width: 1024, height: 512 };
const drawn: { w: number; h: number; type?: string; quality?: number }[] = [];

beforeEach(() => {
  Object.assign(browser, { readFails: false, imageFails: false, blobFails: false, ctxFails: false, width: 1024, height: 512 });
  drawn.length = 0;
  vi.stubGlobal(
    "FileReader",
    class {
      result: string | null = null;
      error: unknown = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => {
          if (browser.readFails) {
            this.error = new DOMException("The object can not be found here.", "NotFoundError");
            this.onerror?.();
          } else {
            this.result = "data:image/png;base64,AA==";
            this.onload?.();
          }
        });
      }
    },
  );
  vi.stubGlobal(
    "Image",
    class {
      width = browser.width;
      height = browser.height;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        queueMicrotask(() => (browser.imageFails ? this.onerror?.() : this.onload?.()));
      }
    },
  );
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => (browser.ctxFails ? null : { drawImage: () => undefined }),
        toBlob: (done: (b: Blob | null) => void, type?: string, quality?: number) => {
          drawn.push({ w: canvas.width, h: canvas.height, type, quality });
          done(browser.blobFails ? null : new Blob(["webp"], { type }));
        },
      };
      return canvas;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const file = () => ({ name: "logo.png" }) as unknown as File;
const caught = async (p: Promise<unknown>): Promise<unknown> => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e);

describe("the three logo-upload failures read in the organiser's language", () => {
  it("the three new sentences exist in all four locales, are not the browser's English, and the three locales are translated (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      for (const key of Object.values(KEYS)) {
        const copy = (dict as Dict)[key];
        expect(copy, `${loc} ${key}`).toBeTruthy();
        expect(copy, `${loc} ${key}: no placeholder to leave unfilled`).not.toMatch(/\{\w+\}/);
        expect(copy, `${loc} ${key}: not the old bare English`).not.toMatch(/^(bad image|image conversion failed|upload failed)/);
        if (loc !== "en") expect(copy, `${loc} ${key} is translated`).not.toBe((en as Dict)[key]);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * Object.keys(KEYS).length);
  });

  it("an image that will not decode, a file the reader cannot read, a failed conversion, a null canvas context and a refused PUT each say their own sentence, through settingsSaveErrorText, in every locale (counted)", async () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      const m = reader(dict as Dict);
      const unreachable = (dict as Dict)[UNREACHABLE]!;

      browser.imageFails = true;
      const badImage = await caught(fileToWebp(file(), 512, m));
      browser.imageFails = false;
      browser.readFails = true;
      const unreadable = await caught(fileToWebp(file(), 512, m));
      browser.readFails = false;
      browser.blobFails = true;
      const convert = await caught(fileToWebp(file(), 512, m));
      browser.blobFails = false;
      browser.ctxFails = true;
      const noCanvas = await caught(fileToWebp(file(), 512, m));
      browser.ctxFails = false;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
      const refused = await caught(putLogo("https://storage.invalid/put", new Blob(["x"]), m));

      for (const [what, err, key] of [
        ["bad image", badImage, KEYS.badImage],
        ["unreadable file", unreadable, KEYS.badImage],
        ["conversion", convert, KEYS.convertFailed],
        ["no 2d canvas context", noCanvas, KEYS.convertFailed],
        ["refused PUT", refused, KEYS.uploadFailed],
      ] as const) {
        expect(err, `${loc} ${what}`).toBeInstanceOf(Error);
        expect((err as Error).message, `${loc} ${what}: thrown in the reader's language`).toBe((dict as Dict)[key]);
        // What run() renders: the bare local Error keeps its message, and is NOT the "couldn't reach Seazn" copy.
        const shown = settingsSaveErrorText(err, m, "fallback");
        expect(shown, `${loc} ${what}: shown`).toBe((dict as Dict)[key]);
        expect(shown, `${loc} ${what}: not the unreachable copy`).not.toBe(unreachable);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * 5);
  });

  it("the positive pairs: a good file converts to a downscaled WebP, an ok PUT resolves, and a PUT that never reaches the server still reads 'unreachable'", async () => {
    const m = reader(nl as Dict);
    const blob = await fileToWebp(file(), 512, m);
    expect(blob.type).toBe("image/webp");
    // 1024x512 against max 512: the long side is scaled to 512, the other keeps the aspect.
    expect(drawn).toEqual([{ w: 512, h: 256, type: "image/webp", quality: 0.88 }]);
    browser.width = 100;
    browser.height = 40;
    await fileToWebp(file(), 512, m);
    expect(drawn[1]).toMatchObject({ w: 100, h: 40 }); // never upscaled

    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", put);
    await expect(putLogo("https://storage.invalid/put", blob, m)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledWith("https://storage.invalid/put", expect.objectContaining({ method: "PUT", headers: { "Content-Type": "image/webp" }, body: blob }));

    // Offline during the PUT: fetch itself rejects with its TypeError - that one IS the network, and says so.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const offline = await caught(putLogo("https://storage.invalid/put", blob, m));
    expect(offline).toBeInstanceOf(TypeError);
    expect(settingsSaveErrorText(offline, m, "fallback")).toBe((nl as Dict)[UNREACHABLE]);
  });

  it("sequence: a refusal, then a good upload, then a refusal again - no state carried between calls", async () => {
    const m = reader(fr as Dict);
    browser.imageFails = true;
    expect(((await caught(fileToWebp(file(), 512, m))) as Error).message).toBe((fr as Dict)[KEYS.badImage]);
    browser.imageFails = false;
    await expect(fileToWebp(file(), 512, m)).resolves.toBeInstanceOf(Blob);
    browser.blobFails = true;
    expect(((await caught(fileToWebp(file(), 512, m))) as Error).message).toBe((fr as Dict)[KEYS.convertFailed]);
  });
});
