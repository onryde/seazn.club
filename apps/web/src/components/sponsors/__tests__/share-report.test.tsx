// R4 sponsors on stream, S13 - the Share report panel (components/sponsors/share-report.tsx): create a link, see it ONCE, copy
// it, revoke a live one in two steps. Under the hook harness (no DOM; see overview-tab.test.tsx's header). `fetch` is stubbed
// and its REQUEST is read - "did Create send the dates on screen to the route that exists?" is a check on the request, not a
// fixture. The routes' own behaviour is app/api/v1/.../report-links/__tests__/route.test.ts's.
//
// The sequence (TEST-STRATEGY rule 1): create -> the url shown once -> Done hides it for good -> a second create shows a NEW url;
// revoke -> confirm -> the row goes; revoke -> cancel -> nothing sent; a refused write says so and changes nothing.
//
// Killers (one at a time, restore from a cp backup):
//   S1  body dates     send `defaults.from` instead of the edited `from`        -> "Create sends the dates on screen"
//   S2  range guard    drop the `to < from` disable                              -> "to before from"
//   S3  two-step       Revoke sends at once (skip `setConfirming`)               -> "Revoke asks first"
//   S4  once           Done keeps the url (skip `setCreated(null)`)              -> "the url is shown once"
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

import { ShareReport, type ShareReportProps } from "../share-report";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { fmtIsoDay, type ReportLinkSummary } from "@/lib/sponsor-report";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import uiEn from "@/dictionaries/en/ui.json";

const en = uiEn as unknown as Dict;
const msg = (key: MessageKey, vars?: Record<string, string | number>) => t(en, key, vars);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const ORIGIN = "https://app.seazn.test";
const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const LINKS: ReportLinkSummary[] = [
  { id: "l1", sponsorId: "s1", competitionId: null, competitionName: null, from: "2026-01-01", to: "2026-12-31", createdAt: "2026-06-01T10:00:00.000Z" },
  { id: "l2", sponsorId: "s1", competitionId: "c1", competitionName: "Spring Cup", from: "2026-03-01", to: "2026-04-30", createdAt: "2026-05-01T10:00:00.000Z" },
];
const base = (over: Partial<ShareReportProps> = {}): ShareReportProps => ({
  id: "sponsor-share-s1",
  orgId: "org-1",
  sponsor: { id: "s1", name: "Harbour Bank" },
  defaults: { from: "2026-01-01", to: "2026-12-31", competitionId: null },
  competitionName: null,
  links: LINKS,
  onClose: vi.fn(),
  ...over,
});

const fetchMock = vi.fn();
const clipboard = { writeText: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { origin: ORIGIN } });
  vi.stubGlobal("navigator", { clipboard });
  clipboard.writeText.mockResolvedValue(undefined);
});
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const created = (token: string, id = "new") => answer(201, { ok: true, data: { id, url: `/r/sponsor/${token}` } });

function mount(over: Partial<ShareReportProps> = {}) {
  const island = renderIsland(ShareReport, base(over));
  const byTestId = (id: string) => island.tree().filter((e) => propsOf(e)["data-testid"] === id);
  const find = (id: string): ReactElement => {
    const [el] = byTestId(id);
    if (!el) throw new Error(`no element with data-testid="${id}"`);
    return el;
  };
  const has = (id: string) => byTestId(id).length > 0;
  const text = (id: string) => flat(textOf(find(id)));
  const type = (id: string, value: string) => (propsOf(find(id)).onChange as (e: unknown) => void)({ target: { value } });
  const click = (id: string) => (propsOf(find(id)).onClick as () => void)();
  const submit = () => (propsOf(find("sponsor-share-form")).onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
  return { island, find, has, text, type, click, submit };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const requests = () => fetchMock.mock.calls.map(([url, init]) => ({ url: url as string, method: (init as RequestInit).method, body: (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : undefined }));

describe("create", () => {
  it("opens AT the period's defaults (the dates the organiser was looking at)", () => {
    const m = mount({ defaults: { from: "2026-05-17", to: "2026-06-15", competitionId: null } });
    expect(propsOf(m.find("sponsor-share-from")).value).toBe("2026-05-17");
    expect(propsOf(m.find("sponsor-share-to")).value).toBe("2026-06-15");
    expect(m.has("sponsor-share-competition")).toBe(false);
  });

  it("Create sends the dates on screen (edited) and the period's competition to the create route", async () => {
    fetchMock.mockResolvedValueOnce(created(TOKEN_A));
    const m = mount({ defaults: { from: "2026-03-01", to: "2026-06-15", competitionId: "c1" }, competitionName: "Spring Cup" });
    expect(m.text("sponsor-share-competition")).toBe(msg("sponsors.share.competition", { competition: "Spring Cup" }));
    m.type("sponsor-share-from", "2026-04-01");
    m.type("sponsor-share-to", "2026-04-30");
    await m.submit();
    await flush();
    expect(requests()).toEqual([{ url: "/api/v1/orgs/org-1/sponsors/s1/report-links", method: "POST", body: { competitionId: "c1", from: "2026-04-01", to: "2026-04-30" } }]);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("the url is shown once: absolute, read-only, copyable; Done hides it for good; a second create shows a NEW one", async () => {
    fetchMock.mockResolvedValueOnce(created(TOKEN_A, "n1")).mockResolvedValueOnce(created(TOKEN_B, "n2"));
    const m = mount();
    expect(m.has("sponsor-share-once"), "nothing shown before a create").toBe(false);
    await m.submit();
    await flush();
    expect(propsOf(m.find("sponsor-share-url"))).toMatchObject({ value: `${ORIGIN}/r/sponsor/${TOKEN_A}`, readOnly: true });
    expect(m.has("sponsor-share-form"), "the form steps aside while the url is up").toBe(false);
    expect(m.text("sponsor-share-once")).toContain(msg("sponsors.share.onceHelp"));

    m.click("sponsor-share-copy");
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith(`${ORIGIN}/r/sponsor/${TOKEN_A}`);
    expect(m.text("sponsor-share-copy")).toBe(msg("sponsors.share.copied"));

    m.click("sponsor-share-done");
    expect(m.has("sponsor-share-once")).toBe(false);
    expect(m.island.text().includes(TOKEN_A), "the token is gone from the panel").toBe(false);

    await m.submit();
    await flush();
    expect(propsOf(m.find("sponsor-share-url")).value).toBe(`${ORIGIN}/r/sponsor/${TOKEN_B}`);
    expect(m.text("sponsor-share-copy"), "a new url starts uncopied").toBe(msg("sponsors.share.copy"));
  });

  it("a copy the browser refuses says how to copy by hand", async () => {
    fetchMock.mockResolvedValueOnce(created(TOKEN_A));
    clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    const m = mount();
    await m.submit();
    await flush();
    m.click("sponsor-share-copy");
    await flush();
    expect(m.text("sponsor-share-copy-failed")).toBe(msg("sponsors.share.copyFailed"));
  });

  it("to before from: Create is disabled with the shared sentence, and nothing is sent; a malformed date disables it too; one day is fine", async () => {
    const m = mount();
    m.type("sponsor-share-from", "2026-06-02");
    m.type("sponsor-share-to", "2026-06-01");
    expect(propsOf(m.find("sponsor-share-create")).disabled).toBe(true);
    expect(m.text("sponsor-share-range")).toBe(msg("comp.validation.endsBeforeStarts"));
    await m.submit();
    expect(fetchMock).not.toHaveBeenCalled();
    m.type("sponsor-share-to", "");
    expect(propsOf(m.find("sponsor-share-create")).disabled).toBe(true);
    m.type("sponsor-share-to", "2026-06-02");
    expect(propsOf(m.find("sponsor-share-create")).disabled).toBe(false);
    expect(m.has("sponsor-share-range")).toBe(false);
  });

  it("a refused create shows the server's sentence and no url", async () => {
    fetchMock.mockResolvedValueOnce(answer(403, { ok: false, error: { code: "FORBIDDEN", message: "Insufficient permissions" } }));
    const m = mount();
    await m.submit();
    await flush();
    expect(m.text("sponsor-share-error")).toBe("Insufficient permissions");
    expect(m.has("sponsor-share-once")).toBe(false);
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});

describe("the active links", () => {
  it("lists this sponsor's live links with their dates, competition and creation day; none says so", () => {
    const m = mount();
    expect(m.text("sponsor-share-link-l1")).toContain(msg("sponsors.share.period", { from: fmtIsoDay("en", "2026-01-01"), to: fmtIsoDay("en", "2026-12-31") }));
    expect(m.text("sponsor-share-link-l2")).toContain("Spring Cup");
    expect(m.text("sponsor-share-link-l2")).toContain(msg("sponsors.share.created", { date: fmtIsoDay("en", "2026-05-01") }));
    expect(mount({ links: [] }).text("sponsor-share-none")).toBe(msg("sponsors.share.none"));
  });

  it("Revoke asks first; Cancel sends nothing; confirming sends DELETE to that link, refreshes, and the row goes until the server answers otherwise", async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: true, data: { revoked: true } }));
    const m = mount();
    m.click("sponsor-share-revoke-l2");
    expect(fetchMock, "asking is not sending").not.toHaveBeenCalled();
    expect(m.text("sponsor-share-link-l2")).toContain(msg("sponsors.share.revokeConfirm"));
    m.click("sponsor-share-revoke-cancel-l2");
    expect(m.text("sponsor-share-link-l2")).not.toContain(msg("sponsors.share.revokeConfirm"));
    expect(fetchMock).not.toHaveBeenCalled();

    m.click("sponsor-share-revoke-l2");
    m.click("sponsor-share-revoke-yes-l2");
    await flush();
    expect(requests()).toEqual([{ url: "/api/v1/orgs/org-1/sponsor-report-links/l2", method: "DELETE", body: undefined }]);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(m.has("sponsor-share-link-l2")).toBe(false);
    expect(m.has("sponsor-share-link-l1")).toBe(true);

    // The refreshed props are the truth from then on: a list that still has it (another tab re-made it?) shows it.
    m.island.rerender(base({ links: [...LINKS] }));
    expect(m.has("sponsor-share-link-l2")).toBe(true);
  });

  it("a refused revoke keeps the row and says why", async () => {
    fetchMock.mockResolvedValueOnce(answer(404, { ok: false, error: { code: "NOT_FOUND", message: "report link not found" } }));
    const m = mount();
    m.click("sponsor-share-revoke-l1");
    m.click("sponsor-share-revoke-yes-l1");
    await flush();
    expect(m.has("sponsor-share-link-l1")).toBe(true);
    expect(m.text("sponsor-share-error")).toBe("report link not found");
  });
});

it("Close calls onClose", () => {
  const onClose = vi.fn();
  const m = mount({ onClose });
  m.click("sponsor-share-close");
  expect(onClose).toHaveBeenCalledTimes(1);
});
