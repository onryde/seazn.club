// SECURITY (owner-approved 2026-11-07): the Team panel and the email-bound invite token. The invite list no longer carries
// an email-bound invite's token (it goes only into the invitee's email: it signs a new or unverified account in), so the
// panel must not offer to copy it, and must revoke by the invite's ID, the one handle it has. A shareable link keeps its
// token and its copy control (positive pair), and revokes by id too.
//
// The rows are the list route's real answer shape (`OrgInvite`, token null for an email-bound row). The fetch is stubbed;
// the server half (the list, the revoke route) is driven for real in
// app/api/orgs/[id]/invites/__tests__/invite-token-exposure.test.ts.
//
// Sport: not applicable (a team invite does not vary by sport).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { OrgTeam } from "@/components/org-team";
import type { OrgInvite } from "@/lib/types";
import en from "@/dictionaries/en/ui.json";

const net = vi.hoisted(() => ({
  invites: [] as unknown[],
  calls: [] as { url: string; method: string | undefined }[],
}));

vi.mock("@/lib/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: vi.fn(async (url: string, init?: { method?: string }) => {
    net.calls.push({ url, method: init?.method });
    if (url.endsWith("/invites")) return net.invites;
    if (url.endsWith("/revoke")) return { ok: true };
    return [];
  }),
}));

const AT = Date.parse("2026-11-07T12:00:00.000Z");
const DAY = 86_400_000;
const LINK_TOKEN = "Lk7mQ2pX9vR4tW1yZ3aB5cD8eF0gH6jK";

const base = {
  org_id: "org-1",
  role: "viewer" as const,
  expires_at: new Date(AT + DAY).toISOString(),
  used_count: 0,
  revoked: false,
  created_at: new Date(AT - 60_000).toISOString(),
};
const EMAIL_ROW: OrgInvite = { ...base, id: "inv-email", email: "zq-invitee@example.test", token: null, max_uses: 1 };
const LINK_ROW: OrgInvite = { ...base, id: "inv-link", email: null, token: LINK_TOKEN, max_uses: 0 };

const REVOKE = (en as Record<string, string>)["settings.team.revoke"]!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(AT);
  net.invites = [EMAIL_ROW, LINK_ROW];
  net.calls = [];
});
afterEach(() => {
  vi.useRealTimers();
});

async function mount() {
  const island = renderIsland(OrgTeam, { orgId: "org-1", role: "admin" as const, currentUserId: "u1" });
  await vi.advanceTimersByTimeAsync(0); // the mount effect's load resolves
  return island;
}

/** The invite's own list row (keyed by the invite id), and everything inside it. */
function rowOf(tree: ReactElement[], inviteId: string): ReactElement[] {
  const rows = tree.filter((e) => e.type === "li" && e.key === inviteId);
  expect(rows, `one row for ${inviteId}`).toHaveLength(1);
  return walk(propsOf(rows[0]!).children as ReactElement);
}

/** Every element in a row that is handed an invite token — a copy control, a link painter. */
const tokenHolders = (row: ReactElement[]) => row.filter((e) => "token" in propsOf(e));

function revokeButton(row: ReactElement[]): ReactElement {
  const buttons = row.filter((e) => e.type === "button" && textOf(propsOf(e).children as ReactElement) === REVOKE);
  expect(buttons, "one Revoke button in the row").toHaveLength(1);
  return buttons[0]!;
}

describe("the Team panel never needs an email-bound invite's token", () => {
  it("an email-bound row offers no copy-link control; a shareable link keeps its own", async () => {
    const island = await mount();
    expect(island.text(), "premise: the email invite is listed").toContain(EMAIL_ROW.email);

    const emailRow = rowOf(island.tree(), EMAIL_ROW.id);
    expect(tokenHolders(emailRow), "nothing in the email row is handed a token").toEqual([]);

    const linkRow = rowOf(island.tree(), LINK_ROW.id);
    expect(tokenHolders(linkRow).map((e) => propsOf(e).token), "the link row paints its own token").toEqual([LINK_TOKEN]);
  });

  it("revoke posts the invite's ID for both kinds: never a token, never 'null'", async () => {
    const island = await mount();

    for (const invite of [EMAIL_ROW, LINK_ROW]) {
      const before = net.calls.length;
      (propsOf(revokeButton(rowOf(island.tree(), invite.id))).onClick as () => void)();
      await vi.advanceTimersByTimeAsync(0);
      const posted = net.calls.slice(before).filter((c) => c.method === "POST");
      expect(posted, `${invite.id}: one POST`).toEqual([
        { url: `/api/orgs/org-1/invites/${invite.id}/revoke`, method: "POST" },
      ]);
    }
  });
});
