// The one "save this blob as a file" routine the console's fetch-driven
// downloads share (the documents menu, the scorer-sheets print control). No
// jsdom here, so the DOM it touches is injected.
import { describe, expect, it, vi } from "vitest";
import { downloadBlob } from "@/lib/download-blob";

describe("downloadBlob", () => {
  it("clicks an attached anchor carrying the filename, then revokes the object URL", () => {
    const order: string[] = [];
    const anchor = {
      click: vi.fn(() => order.push("click")),
      remove: vi.fn(() => order.push("remove")),
      href: "",
      download: "",
    };
    const append = vi.fn(() => order.push("append"));
    const revoke = vi.fn(() => order.push("revoke"));
    const blob = new Blob(["x"]);
    const create = vi.fn(() => "blob:1");
    downloadBlob(blob, "s.pdf", {
      createElement: () => anchor as unknown as HTMLAnchorElement,
      append,
      createObjectURL: create,
      revokeObjectURL: revoke,
    });
    expect(create).toHaveBeenCalledWith(blob);
    expect([anchor.href, anchor.download]).toEqual(["blob:1", "s.pdf"]);
    expect(append).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:1");
    expect(order).toEqual(["append", "click", "remove", "revoke"]);
  });
});
