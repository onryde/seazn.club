// The outbox body at rest (spec "Credentials at rest"): the html + text of a sign-in or invite email hold a live
// credential, so they are stored only as an envelope sealed under the application KEK (LICHESS_TOKEN_KEK, the one
// Lichess tokens use) and the envelope is the repo's own (server/relay/crypto.ts), not a new one.
//
// The decision pinned here is the one the ledger flagged: when the KEK is unusable, a box that CAN send mail (a Resend
// key is set) must fail LOUD at enqueue, never queue a bodiless row that then dies quietly as 'body_missing'. A box
// that cannot send mail anyway (dev, CI: no Resend key) is allowed a null body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealWith } from "@/server/relay/crypto";
import { OutboxKeyUnavailableError, openBody, sealBody, type EmailBody } from "../seal";

const KEK = "ab".repeat(32);
const OTHER_KEK = "cd".repeat(32);
const LINK = "https://seazn.club/api/auth/magic-link/verify?token=SECRET-TOKEN-9f2c71aa0b";
const BODY: EmailBody = {
  html: `<p>Hi</p><a href="${LINK}">Sign in</a>`,
  text: `Sign in: ${LINK}`,
};

beforeEach(() => {
  vi.stubEnv("LICHESS_TOKEN_KEK", KEK);
  vi.stubEnv("RESEND_API_KEY", "re_test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Every shape of "the KEK cannot be used": unset, empty, too short, too long, junk suffix, non-hex, trailing newline. */
const UNUSABLE_KEKS: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["empty", ""],
  ["short", "ab".repeat(31)],
  ["long (65 chars)", "ab".repeat(32) + "a"],
  ["junk suffix", "ab".repeat(32) + "zz"],
  ["non-hex", "zz".repeat(32)],
  ["trailing newline", "ab".repeat(32) + "\n"],
];

describe("sealBody / openBody", () => {
  it("round-trips html and text, including non-ASCII", () => {
    const body: EmailBody = { html: "<p>Café ☕ — 你好 🎾</p>", text: "Café ☕ — 你好 🎾\nline two" };
    const sealed = sealBody(body);
    expect(sealed).not.toBeNull();
    expect(openBody(sealed!)).toEqual(body);
  });

  it("the sealed bytes do not contain the link, the token, or any plaintext (control: the plaintext does)", () => {
    const plain = JSON.stringify(BODY);
    expect(plain).toContain("SECRET-TOKEN-9f2c71aa0b"); // the control: a vacuous probe would pass on anything
    const sealed = sealBody(BODY)!;
    for (const needle of [LINK, "SECRET-TOKEN-9f2c71aa0b", "Sign in", "<a href"]) {
      expect(sealed.includes(Buffer.from(needle, "utf8")), `utf8 ${needle}`).toBe(false);
      expect(sealed.toString("base64").includes(Buffer.from(needle).toString("base64")), `base64 ${needle}`).toBe(false);
    }
  });

  it("two seals of one body differ (a fresh data key and nonces each time)", () => {
    const a = sealBody(BODY)!;
    const b = sealBody(BODY)!;
    expect(a.equals(b)).toBe(false);
    expect(openBody(a)).toEqual(openBody(b));
  });

  it("opens from a plain Uint8Array (the shape a driver hands back), not only a Buffer", () => {
    const sealed = sealBody(BODY)!;
    expect(openBody(new Uint8Array(sealed))).toEqual(BODY);
  });

  it("a flipped byte anywhere throws rather than opening to a plausible wrong body", () => {
    const sealed = sealBody(BODY)!;
    let checked = 0;
    // The wrapped data key, a tag, and the ciphertext: one flip in each region of the envelope.
    for (const at of [20, 50, 65, 80, 90, sealed.length - 1]) {
      const damaged = Buffer.from(sealed);
      damaged[at] = damaged[at]! ^ 0xff;
      expect(() => openBody(damaged), `byte ${at}`).toThrow();
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("a truncated envelope and an empty one throw", () => {
    const sealed = sealBody(BODY)!;
    expect(() => openBody(sealed.subarray(0, 40))).toThrow();
    expect(() => openBody(new Uint8Array(0))).toThrow();
  });

  it("a body sealed under another KEK does not open (a rotated key is unreadable, not garbled)", () => {
    const sealed = sealBody(BODY)!;
    vi.stubEnv("LICHESS_TOKEN_KEK", OTHER_KEK);
    expect(() => openBody(sealed)).toThrow();
  });

  it("an envelope that opens but is not an {html, text} pair throws", () => {
    const shapes = ["not json", JSON.stringify(null), JSON.stringify(7), JSON.stringify({ html: "<p>x</p>" }), JSON.stringify({ html: 1, text: "t" }), JSON.stringify(["a", "b"])];
    let checked = 0;
    for (const plain of shapes) {
      const forged = sealWith("LICHESS_TOKEN_KEK", plain);
      expect(() => openBody(forged), plain).toThrow();
      checked++;
    }
    expect(checked).toBe(shapes.length);
  });
});

describe("an unusable KEK", () => {
  it("with a Resend key set, sealing throws OutboxKeyUnavailableError (loud), swept over every unusable shape", () => {
    let checked = 0;
    for (const [label, kek] of UNUSABLE_KEKS) {
      vi.stubEnv("LICHESS_TOKEN_KEK", kek);
      let caught: unknown;
      try {
        sealBody(BODY);
      } catch (e) {
        caught = e;
      }
      expect(caught, label).toBeInstanceOf(OutboxKeyUnavailableError);
      expect((caught as OutboxKeyUnavailableError).code, label).toBe("EMAIL_OUTBOX_KEK_MISSING");
      checked++;
    }
    expect(checked).toBe(UNUSABLE_KEKS.length);
  });

  it("with no Resend key (dev, CI), sealing returns null instead: nothing could send the row anyway", () => {
    let checked = 0;
    for (const [label, kek] of UNUSABLE_KEKS) {
      vi.stubEnv("LICHESS_TOKEN_KEK", kek);
      vi.stubEnv("RESEND_API_KEY", undefined);
      expect(sealBody(BODY), label).toBeNull();
      checked++;
    }
    expect(checked).toBe(UNUSABLE_KEKS.length);
  });

  it("with a usable KEK and no Resend key it still seals (a dev box that has a KEK keeps its rows sealed)", () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    const sealed = sealBody(BODY);
    expect(sealed).not.toBeNull();
    expect(openBody(sealed!)).toEqual(BODY);
  });

  it("the error names the missing KEK but never echoes a value or any of the body", () => {
    vi.stubEnv("LICHESS_TOKEN_KEK", "ab".repeat(32) + "zz");
    let caught: Error | undefined;
    try {
      sealBody(BODY);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(OutboxKeyUnavailableError);
    expect(caught!.message).toMatch(/LICHESS_TOKEN_KEK/);
    for (const secret of ["ab".repeat(32), "SECRET-TOKEN-9f2c71aa0b", "re_test"]) {
      expect(caught!.message).not.toContain(secret);
    }
  });

  it("opening under an unusable KEK throws (the caller reads that as 'body_unreadable')", () => {
    const sealed = sealBody(BODY)!;
    vi.stubEnv("LICHESS_TOKEN_KEK", "");
    expect(() => openBody(sealed)).toThrow();
  });
});
