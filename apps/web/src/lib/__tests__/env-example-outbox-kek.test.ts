// R9 (email outbox, Task 6): a developer who copies apps/web/.env.example to .env.local must not meet
// `OutboxKeyUnavailableError` on every sign-in. The template carries a placeholder Resend key; with a Resend key set the
// outbox refuses to queue a message it cannot seal, so the same template must also carry a usable EMAIL_OUTBOX_KEK.
// Read as a developer's copy would be read: the file's own assignments, loaded into the environment, then a real seal.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboxKeyUnavailableError, openBody, sealBody } from "@/server/email-outbox/seal";

const EXAMPLE = path.resolve(__dirname, "../../../.env.example");

/** The uncommented `NAME=value` assignments of an env file, last one winning (dotenv's rule). */
function assignments(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

afterEach(() => vi.unstubAllEnvs());

describe("apps/web/.env.example, copied as it stands", () => {
  const vars = assignments(fs.readFileSync(EXAMPLE, "utf8"));

  it("premise: the template does set a Resend key (so the outbox will want to seal)", () => {
    expect(vars.get("RESEND_API_KEY"), "the template names a key").toBeTruthy();
    expect(vars.size, "the parse read the file's assignments").toBeGreaterThan(20);
  });

  it("seals and opens a sign-in body under the template's own environment (no OutboxKeyUnavailableError)", () => {
    vi.stubEnv("RESEND_API_KEY", vars.get("RESEND_API_KEY"));
    vi.stubEnv("EMAIL_OUTBOX_KEK", vars.get("EMAIL_OUTBOX_KEK"));
    const body = { html: "<a href='https://x.test/magic-link?token=T'>Sign in</a>", text: "Sign in: https://x.test/magic-link?token=T" };
    const sealed = sealBody(body);
    expect(sealed, "a body was sealed, not dropped").not.toBeNull();
    expect(openBody(sealed!)).toEqual(body);
  });

  // R13: the template's key is PUBLISHED, so it is for local dev only. A production server that kept it would seal every
  // sign-in link under a key anyone can read; the outbox refuses it there (and says so at boot).
  it("the same template environment is REFUSED under NODE_ENV=production (the published key protects nothing)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", vars.get("RESEND_API_KEY"));
    vi.stubEnv("EMAIL_OUTBOX_KEK", vars.get("EMAIL_OUTBOX_KEK"));
    expect(vars.get("EMAIL_OUTBOX_KEK"), "the template does publish a key").toMatch(/^[0-9a-f]{64}$/);
    let caught: unknown;
    try {
      sealBody({ html: "<a>x</a>", text: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OutboxKeyUnavailableError);
    expect((caught as OutboxKeyUnavailableError).code).toBe("EMAIL_OUTBOX_KEK_SAMPLE");
  });
});

// YouTube Connect: a connected channel's refresh token is sealed under YOUTUBE_TOKEN_KEK, a key of its own. Both templates
// must document it, and BLANK — unlike the outbox key there is no published sample (nothing refuses one in production, so
// a sample copied to stg would seal every channel's token under a key anyone can read).
describe("YOUTUBE_TOKEN_KEK in both .env.example files", () => {
  const FILES = { "apps/web/.env.example": EXAMPLE, ".env.example": path.resolve(__dirname, "../../../../../.env.example") };

  it("each template assigns it, blank, with the generate command beside it; and neither carries the outbox's published key", () => {
    const published = assignments(fs.readFileSync(EXAMPLE, "utf8")).get("EMAIL_OUTBOX_KEK");
    expect(published, "premise: the outbox sample exists, so 'not the sample' below can fail").toMatch(/^[0-9a-f]{64}$/);
    let checked = 0;
    for (const [name, file] of Object.entries(FILES)) {
      const text = fs.readFileSync(file, "utf8");
      const vars = assignments(text);
      expect(vars.has("YOUTUBE_TOKEN_KEK"), `${name} names YOUTUBE_TOKEN_KEK`).toBe(true);
      expect(vars.get("YOUTUBE_TOKEN_KEK"), `${name}: blank, never a sample`).toBe("");
      expect(vars.get("YOUTUBE_TOKEN_KEK")).not.toBe(published);
      const above = text.slice(0, text.indexOf("\nYOUTUBE_TOKEN_KEK=")).split("\n").slice(-4).join("\n");
      expect(above, `${name}: the comment above it says how to generate one`).toMatch(/openssl rand -hex 32/);
      checked++;
    }
    expect(checked, "the sweep read both files").toBe(2);
  });
});

// YouTube Connect: YOUTUBE_DRIVER picks the fake or the live Google driver. A template that carried `fake` would put a copy on
// stg or prod serving a fake channel, so both templates assign it BLANK and say what blank means.
describe("YOUTUBE_DRIVER in both .env.example files", () => {
  const FILES = { "apps/web/.env.example": EXAMPLE, ".env.example": path.resolve(__dirname, "../../../../../.env.example") };

  it("each template assigns it blank (never `fake`), and the comment above says blank is live in production and the fake is for local and ci only", () => {
    let checked = 0;
    for (const [name, file] of Object.entries(FILES)) {
      const text = fs.readFileSync(file, "utf8");
      const vars = assignments(text);
      expect(vars.has("YOUTUBE_DRIVER"), `${name} names YOUTUBE_DRIVER`).toBe(true);
      expect(vars.get("YOUTUBE_DRIVER"), `${name}: blank, so a copied template is live in production`).toBe("");
      const above = text.slice(0, text.indexOf("\nYOUTUBE_DRIVER=")).split("\n").slice(-4).join("\n");
      expect(above, `${name}: says blank means live in production`).toMatch(/LIVE in production/);
      expect(above, `${name}: says the fake is for local and ci`).toMatch(/ENV_NAME is local or ci/);
      checked++;
    }
    expect(checked, "the sweep read both files").toBe(2);
  });
});
