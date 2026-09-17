"use client";
// The player card's not-found copy, handed from the card's `layout.tsx` to its
// `not-found.tsx` (a not-found page takes no props, and this ISR route cannot
// read the request to pick a language).
//
// A context of its OWN rather than `DictProvider`. A layout wraps its whole
// segment — the page and the not-found boundary alike — and Next has no slot
// that wraps the boundary alone, so whatever the layout provides, the card
// page sits inside it too. A `DictProvider` holding three keys there would be a
// trap: a later card island calling `useT()` would find a provider and render
// raw keys instead of failing loudly, and the provider would also rewrite
// `<html lang>` on the card itself. This context carries three strings that
// only `usePlayerNotFoundCopy` reads, and it throws when absent.
import { createContext, useContext, type ReactNode } from "react";

export interface PlayerNotFoundCopy {
  heading: string;
  body: string;
  cta: string;
}

const Copy = createContext<PlayerNotFoundCopy | null>(null);

export function PlayerNotFoundCopyProvider({ copy, children }: { copy: PlayerNotFoundCopy; children: ReactNode }) {
  return <Copy.Provider value={copy}>{children}</Copy.Provider>;
}

export function usePlayerNotFoundCopy(): PlayerNotFoundCopy {
  const copy = useContext(Copy);
  if (!copy) throw new Error("usePlayerNotFoundCopy must be used within <PlayerNotFoundCopyProvider>");
  return copy;
}
