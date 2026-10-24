// `externalPlayInviteEmail` (email outbox, Task 7): the chess round invite RENDERED, not sent. The invite is queued on the outbox
// in the open's transaction and sent after commit, so this is the one place that says what a player is mailed: the subject and
// the body in the recipient's language, with the player's own link in both parts. `sendExternalPlayInviteEmail` is gone: a second
// path that mails an invite straight to Resend would skip the outbox's replace rule, its retry and the seat release.
//
// Every expected string is read from the dictionaries (the copy a translator owns), never typed here, and every locale the
// product ships is checked.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { externalPlayInviteEmail } from "@/lib/email";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import enEmails from "@/dictionaries/en/emails.json";
import esEmails from "@/dictionaries/es/emails.json";
import frEmails from "@/dictionaries/fr/emails.json";
import nlEmails from "@/dictionaries/nl/emails.json";

const DICTS: Record<Locale, Record<string, string>> = { en: enEmails, es: esEmails, fr: frEmails, nl: nlEmails };

const ARGS = {
  orgName: "Chess & Co",
  opponentName: "Alice Opponent",
  roundNo: 3,
  deadlineLabel: "Wed 1 Oct, 12:30 UTC",
  fixtureUrl: "https://example.test/shared/org/comp/div/fixtures/abc/play?t=TOKEN-123_abc",
};
const OPENS = "Wed 1 Oct, 12:20 UTC";

/** `{name}` substitution exactly as a translator writes it. */
const fill = (template: string, vars: Record<string, string>): string =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), template);

afterEach(() => vi.unstubAllGlobals());

describe("externalPlayInviteEmail renders the round invite", () => {
  it("every shipped locale: the dictionary's subject and plain-text part, the player's link in both parts, nothing else returned", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const dict = DICTS[locale];
      const mail = await externalPlayInviteEmail("player@example.test", ARGS, locale);
      expect(Object.keys(mail).sort(), locale).toEqual(["html", "subject", "text"]);
      const vars = { roundNo: String(ARGS.roundNo), opponentName: ARGS.opponentName, deadline: ARGS.deadlineLabel, fixtureUrl: ARGS.fixtureUrl };
      expect(mail.subject, locale).toBe(fill(dict["externalPlayInvite.subject"]!, vars));
      expect(mail.text, locale).toBe(fill(dict["externalPlayInvite.text"]!, vars));
      expect(mail.html, locale).toContain("TOKEN-123_abc");
      expect(mail.html, locale).toContain(dict["externalPlayInvite.title"]!);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every locale rendered").toBe(LOCALES.length);
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("English by default, and a locale's copy differs from English (so a dropped locale argument is seen)", async () => {
    const mail = await externalPlayInviteEmail("player@example.test", ARGS);
    expect(mail.subject).toBe(fill(enEmails["externalPlayInvite.subject"], { roundNo: "3", opponentName: ARGS.opponentName }));
    const fr = await externalPlayInviteEmail("player@example.test", ARGS, "fr");
    expect(fr.subject).not.toBe(mail.subject);
  });

  it("a later batch names when its check-in opens, in the recipient's language; batch 0 does not", async () => {
    const later = await externalPlayInviteEmail("player@example.test", { ...ARGS, opensLabel: OPENS }, "fr");
    expect(later.text).toBe(
      fill(frEmails["externalPlayInvite.textLater"], {
        roundNo: "3",
        opponentName: ARGS.opponentName,
        opens: OPENS,
        deadline: ARGS.deadlineLabel,
        fixtureUrl: ARGS.fixtureUrl,
      }),
    );
    const now = await externalPlayInviteEmail("player@example.test", ARGS, "fr");
    expect(now.text).not.toContain(OPENS);
  });

  it("only renders: nothing is sent, whatever the environment holds", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_must_not_be_used");
    const fetchStub = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      await externalPlayInviteEmail("player@example.test", ARGS);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("there is no direct invite sender left", () => {
  it("lib/email exports no sendExternalPlayInviteEmail, and no source file refers to one", async () => {
    expect("sendExternalPlayInviteEmail" in (await import("@/lib/email"))).toBe(false);

    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !full.endsWith("external-play-invite-email.test.ts")) files.push(full);
      }
    };
    walk(root);
    // Anti-vacuity: a walk that found a handful of files would say "none" about a tree it never read.
    expect(files.length, "the walk read the source tree").toBeGreaterThan(500);
    const offenders = files.filter((f) => fs.readFileSync(f, "utf8").includes("sendExternalPlayInviteEmail"));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });
});
