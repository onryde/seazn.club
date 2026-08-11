// Pure unit tests for the restMin/max-per-day draft-then-commit reducer
// (`DraftFieldState`/`draftFieldReducer`/`initDraftField` in
// constraints-panel.tsx). Tested standalone, the same way
// `readMaxFixturesPerDay`/`withMaxFixturesPerDay` are in
// constraints-panel-max-per-day.test.ts, since this workspace has no jsdom
// to drive the `<input>` itself — the wiring (onChange/onBlur/onKeyDown
// calling this reducer through a real render) is covered separately in
// constraints-panel-commit-semantics.test.tsx.
import { describe, expect, it } from "vitest";
import { draftFieldReducer, initDraftField, type DraftFieldState } from "../constraints-panel";

describe("initDraftField", () => {
  it("starts clean: text and seed both the committed value, not dirty", () => {
    expect(initDraftField("5")).toEqual<DraftFieldState>({ text: "5", seed: "5", dirty: false });
  });
});

describe("draftFieldReducer — type", () => {
  it("sets the typed text and marks dirty when it differs from the seed", () => {
    const state = draftFieldReducer(initDraftField("5"), { type: "type", text: "50" });
    expect(state).toEqual<DraftFieldState>({ text: "50", seed: "5", dirty: true });
  });

  it("typing back to exactly the seed's value clears dirty again (requirement 4's edge case)", () => {
    let state = initDraftField("5");
    state = draftFieldReducer(state, { type: "type", text: "50" });
    state = draftFieldReducer(state, { type: "type", text: "5" });
    expect(state).toEqual<DraftFieldState>({ text: "5", seed: "5", dirty: false });
  });

  it("typing the SAME text as the seed on the very first keystroke never goes dirty", () => {
    const state = draftFieldReducer(initDraftField("5"), { type: "type", text: "5" });
    expect(state.dirty).toBe(false);
  });
});

describe("draftFieldReducer — commit", () => {
  it("adopts the typed text as the new seed and clears dirty", () => {
    let state = initDraftField("5");
    state = draftFieldReducer(state, { type: "type", text: "12" });
    state = draftFieldReducer(state, { type: "commit" });
    expect(state).toEqual<DraftFieldState>({ text: "12", seed: "12", dirty: false });
  });
});

describe("draftFieldReducer — revert (Escape)", () => {
  it("restores the seed and discards the typed text", () => {
    let state = initDraftField("5");
    state = draftFieldReducer(state, { type: "type", text: "999" });
    state = draftFieldReducer(state, { type: "revert" });
    expect(state).toEqual<DraftFieldState>({ text: "5", seed: "5", dirty: false });
  });

  it("is a no-op on an already-clean draft", () => {
    const clean = initDraftField("7");
    expect(draftFieldReducer(clean, { type: "revert" })).toEqual(clean);
  });
});

describe("draftFieldReducer — committedChanged", () => {
  it("re-seeds a CLEAN draft to the new committed value outright", () => {
    const state = draftFieldReducer(initDraftField("5"), { type: "committedChanged", text: "9" });
    expect(state).toEqual<DraftFieldState>({ text: "9", seed: "9", dirty: false });
  });

  it("leaves a DIRTY draft's visible text alone — an unrelated update is no reason to yank a live edit", () => {
    let state = initDraftField("5");
    state = draftFieldReducer(state, { type: "type", text: "50" }); // organiser mid-edit
    state = draftFieldReducer(state, { type: "committedChanged", text: "9" }); // a save landed elsewhere
    expect(state.text).toBe("50"); // NOT clobbered
    expect(state.dirty).toBe(true);
  });

  it("still moves the seed under a dirty draft, so a SUBSEQUENT Escape reverts to the FRESH value", () => {
    let state = initDraftField("5");
    state = draftFieldReducer(state, { type: "type", text: "50" });
    state = draftFieldReducer(state, { type: "committedChanged", text: "9" });
    expect(state.seed).toBe("9"); // not the stale "5" that was current when the edit started
    const reverted = draftFieldReducer(state, { type: "revert" });
    expect(reverted).toEqual<DraftFieldState>({ text: "9", seed: "9", dirty: false });
  });

  it("a no-op change (same text) leaves a clean draft untouched", () => {
    const clean = initDraftField("5");
    const state = draftFieldReducer(clean, { type: "committedChanged", text: "5" });
    expect(state).toEqual(clean);
  });
});
