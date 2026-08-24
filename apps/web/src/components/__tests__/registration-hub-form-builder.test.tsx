// RS004 W3c — the sign-up form builder, ported VERBATIM (per the task
// brief) from the pre-deletion apps/web/src/components/v2/registration-
// settings.tsx (git show 850cc6308^:...), :373-381 / :397-487. The FormField
// data shape is FROZEN (registrations-panel.tsx :26-32) — these tests pin
// the ported behaviour, not a redesign of it.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { FormBuilder, type FormField } from "@/components/registration-hub-form-builder";

type F = (arg: { target: { value: string } } | { target: { checked: boolean } }) => void;
type Click = () => void;

const ALL_KINDS: FormField[] = [
  { key: "shirt_size", label: "Shirt size", kind: "text", required: true },
  { key: "club", label: "Club", kind: "select", options: ["None", "Riverside"], required: false },
  { key: "waiver", label: "I agree to the waiver", kind: "checkbox", required: true },
];

describe("FormBuilder — rendering existing fields, byte-identical (round-trip)", () => {
  it("renders every field's label, kind and required flag unchanged", () => {
    const island = renderIsland(FormBuilder, { fields: ALL_KINDS, canEdit: true, onChange: vi.fn() });
    const tree = island.tree();
    const labels = new Set(ALL_KINDS.map((f) => f.label));
    const labelInputs = tree.filter((e) => e.type === "input" && labels.has(propsOf(e).value as string));
    const values = labelInputs.map((e) => propsOf(e).value);
    expect(values).toEqual(["Shirt size", "Club", "I agree to the waiver"]);

    const kindSelects = tree.filter((e) => e.type === "select");
    expect(kindSelects.map((e) => propsOf(e).value)).toEqual(["text", "select", "checkbox"]);

    const requiredCheckboxes = tree.filter((e) => e.type === "input" && propsOf(e).type === "checkbox");
    expect(requiredCheckboxes.map((e) => propsOf(e).checked)).toEqual([true, false, true]);
  });

  it("renders the select field's options joined by comma", () => {
    const island = renderIsland(FormBuilder, { fields: ALL_KINDS, canEdit: true, onChange: vi.fn() });
    const optionsInput = island.tree().find((e) => e.type === "input" && propsOf(e).value === "None, Riverside");
    expect(optionsInput).toBeTruthy();
  });

  it("renders no options input for text/checkbox fields", () => {
    const island = renderIsland(FormBuilder, {
      fields: [ALL_KINDS[0]!, ALL_KINDS[2]!],
      canEdit: true,
      onChange: vi.fn(),
    });
    const optionsInputs = island
      .tree()
      .filter((e) => e.type === "input" && typeof propsOf(e).value === "string" && (propsOf(e).value as string).includes(","));
    expect(optionsInputs).toHaveLength(0);
  });
});

describe("FormBuilder — empty state", () => {
  it("shows the examples hint when there are zero fields", () => {
    const island = renderIsland(FormBuilder, { fields: [], canEdit: true, onChange: vi.fn() });
    expect(island.text()).toContain("dietary needs");
  });

  it("omits the examples hint once at least one field exists", () => {
    const island = renderIsland(FormBuilder, { fields: [ALL_KINDS[0]!], canEdit: true, onChange: vi.fn() });
    expect(island.text()).not.toContain("dietary needs");
  });
});

describe("FormBuilder — adding a field", () => {
  it("appends a valid default field (never a blank label, which would block save)", () => {
    const onChange = vi.fn();
    const island = renderIsland(FormBuilder, { fields: [ALL_KINDS[0]!], canEdit: true, onChange });
    const addBtn = island.tree().find((e) => e.type === "button" && propsOf(e).onClick && !propsOf(e).className?.toString().includes("text-red-500"));
    (propsOf(addBtn!).onClick as Click)();
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as FormField[];
    expect(next).toHaveLength(2);
    expect(next[1]!.label.length).toBeGreaterThan(0);
    expect(next[1]!.kind).toBe("text");
    expect(next[1]!.required).toBe(false);
  });

  it("hides the add button at the 12-field cap", () => {
    const twelve: FormField[] = Array.from({ length: 12 }, (_, i) => ({
      key: `q${i}`,
      label: `Question ${i}`,
      kind: "text",
      required: false,
    }));
    const island = renderIsland(FormBuilder, { fields: twelve, canEdit: true, onChange: vi.fn() });
    const addBtn = island.tree().find((e) => e.type === "button" && !propsOf(e).className?.toString().includes("text-red-500"));
    expect(addBtn).toBeUndefined();
  });
});

describe("FormBuilder — editing a field", () => {
  it("relabelling recomputes the slugified key", () => {
    const onChange = vi.fn();
    const island = renderIsland(FormBuilder, { fields: [ALL_KINDS[0]!], canEdit: true, onChange });
    const labelInput = island.tree().find((e) => e.type === "input" && propsOf(e).value === "Shirt size")!;
    (propsOf(labelInput).onChange as F)({ target: { value: "T-Shirt Size!!" } });
    const next = onChange.mock.calls[0]![0] as FormField[];
    expect(next[0]!.label).toBe("T-Shirt Size!!");
    expect(next[0]!.key).toBe("t_shirt_size");
  });

  it("switching kind to select seeds an options array so the options input appears", () => {
    const onChange = vi.fn();
    const island = renderIsland(FormBuilder, { fields: [ALL_KINDS[0]!], canEdit: true, onChange });
    const kindSelect = island.tree().find((e) => e.type === "select")!;
    (propsOf(kindSelect).onChange as F)({ target: { value: "select" } });
    const next = onChange.mock.calls[0]![0] as FormField[];
    expect(next[0]!.kind).toBe("select");
    expect(next[0]!.options).toEqual([""]);
  });

  it("editing the options input splits on comma and trims, dropping blanks", () => {
    const onChange = vi.fn();
    const island = renderIsland(FormBuilder, { fields: [ALL_KINDS[1]!], canEdit: true, onChange });
    const optionsInput = island.tree().find((e) => e.type === "input" && propsOf(e).value === "None, Riverside")!;
    (propsOf(optionsInput).onChange as F)({ target: { value: "A, B ,, C " } });
    const next = onChange.mock.calls[0]![0] as FormField[];
    expect(next[0]!.options).toEqual(["A", "B", "C"]);
  });

  it("toggling required flips only that field's flag", () => {
    const onChange = vi.fn();
    const island = renderIsland(FormBuilder, { fields: ALL_KINDS, canEdit: true, onChange });
    const requiredCheckboxes = island.tree().filter((e) => e.type === "input" && propsOf(e).type === "checkbox");
    (propsOf(requiredCheckboxes[1]!).onChange as F)({ target: { checked: true } });
    const next = onChange.mock.calls[0]![0] as FormField[];
    expect(next.map((f) => f.required)).toEqual([true, true, true]);
  });

  it("remove drops exactly that field and keeps the others in order", () => {
    const onChange = vi.fn();
    const island = renderIsland(FormBuilder, { fields: ALL_KINDS, canEdit: true, onChange });
    const removeButtons = island.tree().filter((e) => e.type === "button" && propsOf(e).className?.toString().includes("text-red-500"));
    expect(removeButtons).toHaveLength(3);
    (propsOf(removeButtons[1]!).onClick as Click)();
    const next = onChange.mock.calls[0]![0] as FormField[];
    expect(next.map((f) => f.key)).toEqual(["shirt_size", "waiver"]);
  });
});

describe("FormBuilder — read-only (canEdit false)", () => {
  it("disables every input/select and hides add/remove controls", () => {
    const island = renderIsland(FormBuilder, { fields: ALL_KINDS, canEdit: false, onChange: vi.fn() });
    const tree = island.tree();
    const inputsAndSelects = tree.filter((e) => e.type === "input" || e.type === "select");
    expect(inputsAndSelects.length).toBeGreaterThan(0);
    for (const el of inputsAndSelects) expect(propsOf(el).disabled).toBe(true);
    const removeButtons = tree.filter((e) => e.type === "button" && propsOf(e).className?.toString().includes("text-red-500"));
    expect(removeButtons).toHaveLength(0);
    const addButtons = tree.filter((e) => e.type === "button" && !propsOf(e).className?.toString().includes("text-red-500"));
    expect(addButtons).toHaveLength(0);
  });
});
