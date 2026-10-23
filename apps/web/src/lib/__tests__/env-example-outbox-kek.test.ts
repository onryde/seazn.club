// R9 (email outbox, Task 6): a developer who copies apps/web/.env.example to .env.local must not meet
// `OutboxKeyUnavailableError` on every sign-in. The template carries a placeholder Resend key; with a Resend key set the
// outbox refuses to queue a message it cannot seal, so the same template must also carry a usable LICHESS_TOKEN_KEK.
// Read as a developer's copy would be read: the file's own assignments, loaded into the environment, then a real seal.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBody, sealBody } from "@/server/email-outbox/seal";

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
    vi.stubEnv("LICHESS_TOKEN_KEK", vars.get("LICHESS_TOKEN_KEK"));
    const body = { html: "<a href='https://x.test/magic-link?token=T'>Sign in</a>", text: "Sign in: https://x.test/magic-link?token=T" };
    const sealed = sealBody(body);
    expect(sealed, "a body was sealed, not dropped").not.toBeNull();
    expect(openBody(sealed!)).toEqual(body);
  });
});
