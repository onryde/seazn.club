"use client";
// The pad's aggregate context (S10/#419 W8): everything a future renderer
// needs to know about ONE fixture's scoring surface, resolved once per
// mount rather than threaded through every pad/panel/action as separate
// props. Carries the PINNED module — never `latest` (module-client.ts's
// `resolveModuleClient` has no such fallback path at all; see its own
// header for why that is load-bearing, not incidental: a division pinned to
// an older module version must render THAT version's contract).
//
// Deliberately thin: `cfg` is handed in ALREADY resolved (base ⊕ variant
// preset ⊕ org overrides) — this file does no resolution of its own beyond
// the module pin. Same for entitlements/fidelityBand/recorderNames: all
// precomputed by whatever future server component mounts this provider.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AnySportModule, FidelityBand } from "@seazn/engine/sport";
import { resolveModuleClient } from "./module-client";
import type { PadAuthMode } from "./transport";

const EMPTY_RECORD = {};

export interface PadContextValue {
  fixtureId: string;
  sportKey: string;
  /** The PINNED version — equal to `module.version` by construction
   *  (resolveModuleClient throws rather than substitute), kept alongside it
   *  so a caller can read "what was requested" without reaching into the
   *  resolved module object for it. */
  moduleVersion: string;
  module: AnySportModule;
  cfg: unknown;
  auth: PadAuthMode;
  fidelityBand: FidelityBand;
  entitlements: Readonly<Record<string, boolean>>;
  /** recorded_by -> display name, e.g. for Activity attribution — same
   *  shape as fixture-console.tsx's own `recorderNames` prop. */
  recorderNames: Readonly<Record<string, string>>;
}

/** Exported for tests only (inspecting what a `<PadContextProvider>` renders
 *  — the repo's node-only hook harness has no real Provider/Consumer tree,
 *  see `_hook-harness.tsx`'s own `useContext` doc, so a consumer test reads
 *  the Provider element's `value` prop directly rather than a live
 *  subscription). Components should call `usePadContext()`, never this. */
export const PadContext = createContext<PadContextValue | null>(null);

export interface PadContextProviderProps {
  fixtureId: string;
  sportKey: string;
  moduleVersion: string;
  cfg: unknown;
  auth: PadAuthMode;
  fidelityBand: FidelityBand;
  entitlements?: Readonly<Record<string, boolean>>;
  recorderNames?: Readonly<Record<string, string>>;
  children: ReactNode;
}

export function PadContextProvider(props: PadContextProviderProps) {
  const sportModule = useMemo(
    () => resolveModuleClient(props.sportKey, props.moduleVersion),
    [props.sportKey, props.moduleVersion],
  );
  const entitlements = props.entitlements ?? EMPTY_RECORD;
  const recorderNames = props.recorderNames ?? EMPTY_RECORD;
  const value = useMemo<PadContextValue>(
    () => ({
      fixtureId: props.fixtureId,
      sportKey: props.sportKey,
      moduleVersion: props.moduleVersion,
      module: sportModule,
      cfg: props.cfg,
      auth: props.auth,
      fidelityBand: props.fidelityBand,
      entitlements,
      recorderNames,
    }),
    [
      props.fixtureId,
      props.sportKey,
      props.moduleVersion,
      sportModule,
      props.cfg,
      props.auth,
      props.fidelityBand,
      entitlements,
      recorderNames,
    ],
  );
  return <PadContext.Provider value={value}>{props.children}</PadContext.Provider>;
}

export function usePadContext(): PadContextValue {
  const ctx = useContext(PadContext);
  if (!ctx) throw new Error("usePadContext must be used within a PadContextProvider");
  return ctx;
}
