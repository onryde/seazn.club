// #858 — the page checks staff ITSELF, before any lookup, not only through
// `admin/layout.tsx`: a match link is built from public slugs and a sequential
// number, so it is guessable where a fixture uuid was not.
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireStaff = vi.fn();
const fixtureIdFromLink = vi.fn();
const fixtureConfigPanel = vi.fn();

vi.mock("@/lib/admin", () => ({ requireStaff: () => requireStaff() }));
vi.mock("@/server/usecases/admin-fixture-config", () => ({
  fixtureIdFromLink: (...a: unknown[]) => fixtureIdFromLink(...a),
  fixtureConfigPanel: (...a: unknown[]) => fixtureConfigPanel(...a),
}));

const { default: AdminFixtureConfigPage } = await import("../page");

const LINK = "/o/acme/c/summer-cup/d/open-1/f/12";
const UUID = "3f2a1c9e-0000-4000-8000-000000000000";

beforeEach(() => {
  vi.clearAllMocks();
  fixtureIdFromLink.mockResolvedValue(UUID);
  fixtureConfigPanel.mockResolvedValue(null);
});

describe("/admin/fixtures page", () => {
  it("refuses a non-staff caller before resolving a pasted link", async () => {
    requireStaff.mockRejectedValue(new Error("Staff access required"));
    await expect(
      AdminFixtureConfigPage({ searchParams: Promise.resolve({ id: LINK }) }),
    ).rejects.toThrow("Staff access required");
    expect(fixtureIdFromLink).not.toHaveBeenCalled();
    expect(fixtureConfigPanel).not.toHaveBeenCalled();
  });

  it("resolves a pasted link for staff", async () => {
    requireStaff.mockResolvedValue({ id: "staff" });
    await AdminFixtureConfigPage({ searchParams: Promise.resolve({ id: LINK }) });
    expect(fixtureIdFromLink).toHaveBeenCalledWith({
      orgSlug: "acme",
      compSlug: "summer-cup",
      divSlug: "open-1",
      fixtureNo: 12,
    });
    expect(fixtureConfigPanel).toHaveBeenCalledWith(UUID);
  });

  it("treats a repeated ?id= as no lookup instead of throwing", async () => {
    requireStaff.mockResolvedValue({ id: "staff" });
    await expect(
      AdminFixtureConfigPage({ searchParams: Promise.resolve({ id: [UUID, UUID] }) }),
    ).resolves.toBeTruthy();
    expect(fixtureConfigPanel).not.toHaveBeenCalled();
  });
});
