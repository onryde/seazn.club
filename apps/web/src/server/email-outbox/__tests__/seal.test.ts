// The outbox body at rest (spec "Credentials at rest"): the html + text of a sign-in or invite email hold a live
// credential, so they are stored only as an envelope sealed under the outbox's own key (EMAIL_OUTBOX_KEK, owner ruling
// R13; never the Lichess key) and the envelope is the repo's own (server/relay/crypto.ts), not a new one.
//
// The decision pinned here is the one the ledger flagged: when the KEK is unusable, a box that CAN send mail (a Resend
// key is set) must fail LOUD at enqueue, never queue a bodiless row that then dies quietly as 'body_missing'. A box
// that cannot send mail anyway (dev, CI: no Resend key) is allowed a null body.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealWith } from "@/server/relay/crypto";
import { OutboxKeyUnavailableError, assertOutboxCanQueue, openBody, sealBody, type EmailBody } from "../seal";

/** The key a developer's copy of apps/web/.env.example carries, read from the FILE (the rulebook for what is "published"),
 *  never from the constant seal.ts keeps. */
const EXAMPLE_FILE = path.resolve(__dirname, "../../../../.env.example");
const PUBLISHED_SAMPLE = /^EMAIL_OUTBOX_KEK=([0-9a-f]{64})$/m.exec(fs.readFileSync(EXAMPLE_FILE, "utf8"))?.[1] ?? "";

const KEK = "ab".repeat(32);
const OTHER_KEK = "cd".repeat(32);
const LINK = "https://seazn.club/api/auth/magic-link/verify?token=SECRET-TOKEN-9f2c71aa0b";
const BODY: EmailBody = {
  html: `<p>Hi</p><a href="${LINK}">Sign in</a>`,
  text: `Sign in: ${LINK}`,
};

beforeEach(() => {
  vi.stubEnv("EMAIL_OUTBOX_KEK", KEK);
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
    vi.stubEnv("EMAIL_OUTBOX_KEK", OTHER_KEK);
    expect(() => openBody(sealed)).toThrow();
  });

  it("an envelope that opens but is not an {html, text} pair throws", () => {
    const shapes = ["not json", JSON.stringify(null), JSON.stringify(7), JSON.stringify({ html: "<p>x</p>" }), JSON.stringify({ html: 1, text: "t" }), JSON.stringify(["a", "b"])];
    let checked = 0;
    for (const plain of shapes) {
      const forged = sealWith("EMAIL_OUTBOX_KEK", plain);
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
      vi.stubEnv("EMAIL_OUTBOX_KEK", kek);
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
      vi.stubEnv("EMAIL_OUTBOX_KEK", kek);
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
    vi.stubEnv("EMAIL_OUTBOX_KEK", "ab".repeat(32) + "zz");
    let caught: Error | undefined;
    try {
      sealBody(BODY);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(OutboxKeyUnavailableError);
    expect(caught!.message).toMatch(/EMAIL_OUTBOX_KEK/);
    for (const secret of ["ab".repeat(32), "SECRET-TOKEN-9f2c71aa0b", "re_test"]) {
      expect(caught!.message).not.toContain(secret);
    }
  });

  it("opening under an unusable KEK throws (the caller reads that as 'body_unreadable')", () => {
    const sealed = sealBody(BODY)!;
    vi.stubEnv("EMAIL_OUTBOX_KEK", "");
    expect(() => openBody(sealed)).toThrow();
  });
});

// R13 (owner, 2026-10-23): prod has no LICHESS_TOKEN_KEK, and rotating that key must never strand queued email. The outbox
// has a key of its own and NO fallback to any other.
describe("the outbox key is its own (no fallback to the Lichess key)", () => {
  const LICHESS = "ef".repeat(32);

  it("a Lichess key alone does not let a box with a Resend key queue an email (it throws, naming EMAIL_OUTBOX_KEK)", () => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", undefined);
    vi.stubEnv("LICHESS_TOKEN_KEK", LICHESS);
    expect(() => sealBody(BODY)).toThrow(OutboxKeyUnavailableError);
    expect(() => sealBody(BODY)).toThrow(/EMAIL_OUTBOX_KEK/);
  });

  it("a Lichess key alone, no Resend key: null, not a seal under the Lichess key", () => {
    vi.stubEnv("EMAIL_OUTBOX_KEK", undefined);
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("LICHESS_TOKEN_KEK", LICHESS);
    expect(sealBody(BODY)).toBeNull();
  });

  it("the sealed bytes open only under EMAIL_OUTBOX_KEK: not under the Lichess key, even when both are set", () => {
    vi.stubEnv("LICHESS_TOKEN_KEK", LICHESS);
    const sealed = sealBody(BODY)!;
    expect(openBody(sealed)).toEqual(BODY);
    // The same envelope, opened as if the outbox's key were the Lichess one, fails: it was not sealed under it.
    vi.stubEnv("EMAIL_OUTBOX_KEK", LICHESS);
    expect(() => openBody(sealed)).toThrow();
  });

  it("rotating the Lichess key between seal and open leaves a queued body readable (the point of a key of its own)", () => {
    vi.stubEnv("LICHESS_TOKEN_KEK", LICHESS);
    const sealed = sealBody(BODY)!;
    vi.stubEnv("LICHESS_TOKEN_KEK", "12".repeat(32));
    expect(openBody(sealed)).toEqual(BODY);
    vi.stubEnv("LICHESS_TOKEN_KEK", undefined);
    expect(openBody(sealed)).toEqual(BODY);
  });
});

// R13: the sample key in .env.example is public, so a production server holding it protects nothing.
describe("the published sample key under NODE_ENV=production", () => {
  it("premise: the example file does publish a 64-hex EMAIL_OUTBOX_KEK (a vacuous parse would refuse nothing below)", () => {
    expect(PUBLISHED_SAMPLE).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is refused: seal throws OutboxKeyUnavailableError naming the sample, never the key", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_OUTBOX_KEK", PUBLISHED_SAMPLE);
    let caught: unknown;
    try {
      sealBody(BODY);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutboxKeyUnavailableError);
    const err = caught as OutboxKeyUnavailableError;
    expect(err.code).toBe("EMAIL_OUTBOX_KEK_SAMPLE");
    expect(err.message).toMatch(/sample/i);
    expect(err.message).toMatch(/\.env\.example/);
    expect(err.message).not.toContain(PUBLISHED_SAMPLE);
  });

  it("is refused in upper case too (hex is case-insensitive to the key reader, so the refusal must be)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_OUTBOX_KEK", PUBLISHED_SAMPLE.toUpperCase());
    expect(PUBLISHED_SAMPLE.toUpperCase()).not.toBe(PUBLISHED_SAMPLE); // the control: the variant really differs
    expect(() => sealBody(BODY)).toThrow(OutboxKeyUnavailableError);
  });

  it("is refused with no Resend key as well: a public key seals nothing worth sealing, and the box is fixed before mail is", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("EMAIL_OUTBOX_KEK", PUBLISHED_SAMPLE);
    expect(() => sealBody(BODY)).toThrow(/sample/i);
  });

  it("is accepted outside production (dev and test: the template is meant to be copied) and the body round-trips", () => {
    let checked = 0;
    for (const env of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      vi.stubEnv("EMAIL_OUTBOX_KEK", PUBLISHED_SAMPLE);
      const sealed = sealBody(BODY);
      expect(sealed, env).not.toBeNull();
      expect(openBody(sealed!), env).toEqual(BODY);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a key of one's own is accepted in production, and a body already sealed under the sample still OPENS (no stranded mail)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("EMAIL_OUTBOX_KEK", PUBLISHED_SAMPLE);
    const sealedUnderSample = sealBody(BODY)!;
    vi.stubEnv("NODE_ENV", "production");
    // Opening is a read of what is already there; the refusal is about queueing new mail under a public key.
    expect(openBody(sealedUnderSample)).toEqual(BODY);
    vi.stubEnv("EMAIL_OUTBOX_KEK", KEK);
    const sealed = sealBody(BODY);
    expect(sealed).not.toBeNull();
    expect(openBody(sealed!)).toEqual(BODY);
  });

  it("an unset key and a sample key are told apart (two faults, two codes, two messages)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const seen = new Map<string, string>();
    for (const [label, kek] of [["unset", undefined], ["sample", PUBLISHED_SAMPLE]] as const) {
      vi.stubEnv("EMAIL_OUTBOX_KEK", kek);
      try {
        sealBody(BODY);
      } catch (e) {
        seen.set(label, `${(e as OutboxKeyUnavailableError).code}|${(e as Error).message}`);
      }
    }
    expect(seen.size).toBe(2);
    expect(seen.get("unset")).not.toBe(seen.get("sample"));
    expect(seen.get("unset")).toMatch(/^EMAIL_OUTBOX_KEK_MISSING\|/);
    expect(seen.get("sample")).toMatch(/^EMAIL_OUTBOX_KEK_SAMPLE\|/);
  });
});

// Phase 3 wave 1 (plan P4): a caller that must refuse BEFORE its own transaction (the registration submit mints a Checkout
// session after the fact commits, so it cannot let the enqueue be the first to find out the box cannot queue) asks the same rule
// `sealBody` applies, without a body to seal.
describe("assertOutboxCanQueue", () => {
  it("throws OutboxKeyUnavailableError with EMAIL_OUTBOX_KEK_MISSING when a Resend key is set and the KEK is unusable, over every unusable shape", () => {
    let checked = 0;
    for (const [label, kek] of UNUSABLE_KEKS) {
      vi.stubEnv("EMAIL_OUTBOX_KEK", kek);
      let caught: unknown;
      try {
        assertOutboxCanQueue();
      } catch (e) {
        caught = e;
      }
      expect(caught, label).toBeInstanceOf(OutboxKeyUnavailableError);
      expect((caught as OutboxKeyUnavailableError).code, label).toBe("EMAIL_OUTBOX_KEK_MISSING");
      expect((caught as OutboxKeyUnavailableError).problem, label).toBe("unset");
      checked++;
    }
    expect(checked).toBe(UNUSABLE_KEKS.length);
  });

  it("returns when both the KEK and the Resend key are unset (dev, CI: nothing could send the row anyway), over every unusable shape", () => {
    vi.stubEnv("RESEND_API_KEY", undefined);
    let checked = 0;
    for (const [label, kek] of UNUSABLE_KEKS) {
      vi.stubEnv("EMAIL_OUTBOX_KEK", kek);
      expect(() => assertOutboxCanQueue(), label).not.toThrow();
      checked++;
    }
    expect(checked).toBe(UNUSABLE_KEKS.length);
  });

  it("returns for a key of one's own, with or without a Resend key (the positive pair of the refusals above)", () => {
    expect(() => assertOutboxCanQueue()).not.toThrow(); // the file's beforeEach: own KEK and a Resend key
    vi.stubEnv("RESEND_API_KEY", undefined);
    expect(() => assertOutboxCanQueue()).not.toThrow();
  });

  it("refuses the published sample key under NODE_ENV=production with EMAIL_OUTBOX_KEK_SAMPLE, and accepts it elsewhere", () => {
    expect(PUBLISHED_SAMPLE).toMatch(/^[0-9a-f]{64}$/); // a vacuous parse would refuse nothing
    vi.stubEnv("EMAIL_OUTBOX_KEK", PUBLISHED_SAMPLE);
    vi.stubEnv("NODE_ENV", "production");
    let caught: unknown;
    try {
      assertOutboxCanQueue();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutboxKeyUnavailableError);
    expect((caught as OutboxKeyUnavailableError).code).toBe("EMAIL_OUTBOX_KEK_SAMPLE");
    expect((caught as Error).message).not.toContain(PUBLISHED_SAMPLE);
    for (const env of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(() => assertOutboxCanQueue(), env).not.toThrow();
    }
  });

  it("agrees with sealBody on every environment (one rule, two callers): it throws exactly when sealing would", () => {
    const keks: Array<string | undefined> = [...UNUSABLE_KEKS.map(([, k]) => k), KEK, PUBLISHED_SAMPLE];
    let checked = 0;
    for (const resend of [true, false]) {
      for (const env of ["production", "test"]) {
        for (const kek of keks) {
          vi.stubEnv("RESEND_API_KEY", resend ? "re_test" : undefined);
          vi.stubEnv("NODE_ENV", env);
          vi.stubEnv("EMAIL_OUTBOX_KEK", kek);
          const sealThrows = (() => {
            try {
              sealBody(BODY);
              return false;
            } catch {
              return true;
            }
          })();
          const assertThrows = (() => {
            try {
              assertOutboxCanQueue();
              return false;
            } catch {
              return true;
            }
          })();
          expect(assertThrows, `resend=${resend} env=${env} kek=${kek}`).toBe(sealThrows);
          checked++;
        }
      }
    }
    expect(checked).toBe(2 * 2 * (UNUSABLE_KEKS.length + 2));
  });
});
