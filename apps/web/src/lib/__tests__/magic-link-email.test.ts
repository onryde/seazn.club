// `magicLinkEmail` (email outbox, Task 6): the sign-in email RENDERED, not sent. The route queues what it returns, so this
// is the one place that says what a person is mailed: the subject and the body in the recipient's language, with the
// link in both the HTML and the text parts. `sendMagicLinkEmail` is gone: a second path that mails a sign-in link
// straight to Resend would skip the outbox's replace rule and its retry.
//
// Every expected string is read from the dictionaries (the copy a translator owns), never typed here.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { magicLinkEmail } from "@/lib/email";
import emailsEn from "@/dictionaries/en/emails.json";
import emailsFr from "@/dictionaries/fr/emails.json";

const LINK = "https://seazn.club/magic-link?token=TOKEN-123_abc&next=%2Fjoin%2Fx";
const en = emailsEn as Record<string, string>;
const fr = emailsFr as Record<string, string>;

afterEach(() => vi.unstubAllGlobals());

describe("magicLinkEmail renders the sign-in email", () => {
  it("English by default: the dictionary's subject, the link in the HTML (escaped as an href) and verbatim in the text", async () => {
    const mail = await magicLinkEmail("someone@example.test", LINK);
    expect(Object.keys(mail).sort()).toEqual(["html", "subject", "text"]);
    expect(mail.subject).toBe(en["magicLink.subject"]);
    expect(mail.text).toBe(en["magicLink.text"]!.replace("{link}", LINK));
    expect(mail.html).toContain("TOKEN-123_abc");
    expect(mail.html).toContain(en["magicLink.title"]!);
    expect(mail.text).toContain(LINK);
  });

  it("renders in the recipient's locale when one is given, and that locale's copy differs from English", async () => {
    // Anti-vacuity: a French string equal to the English one could not tell the locale argument from a dropped one.
    expect(fr["magicLink.subject"], "premise: fr has its own subject").toBeTruthy();
    expect(fr["magicLink.subject"]).not.toBe(en["magicLink.subject"]);
    const mail = await magicLinkEmail("someone@example.test", LINK, "fr");
    expect(mail.subject).toBe(fr["magicLink.subject"]);
    expect(mail.text).toBe(fr["magicLink.text"]!.replace("{link}", LINK));
  });

  it("only renders: nothing is sent, whatever the environment holds", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_must_not_be_used");
    const fetchStub = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      await magicLinkEmail("someone@example.test", LINK);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("there is no direct sign-in sender left", () => {
  it("lib/email exports no sendMagicLinkEmail, and no source file refers to one", async () => {
    expect("sendMagicLinkEmail" in (await import("@/lib/email"))).toBe(false);

    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !full.endsWith("magic-link-email.test.ts")) files.push(full);
      }
    };
    walk(root);
    // Anti-vacuity: a walk that found a handful of files would say "none" about a tree it never read.
    expect(files.length, "the walk read the source tree").toBeGreaterThan(500);
    const offenders = files.filter((f) => fs.readFileSync(f, "utf8").includes("sendMagicLinkEmail"));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
