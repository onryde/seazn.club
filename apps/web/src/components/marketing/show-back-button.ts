/**
 * Pure — kept in its own dependency-free module so it's unit-testable
 * without pulling in marketing-shell.tsx's next/font/google import (that
 * breaks outside a real Next.js runtime, e.g. under plain vitest).
 */
export function showBackButton(variant: "night-scroll" | "light", hideBackButton: boolean): boolean {
  return variant === "light" && !hideBackButton;
}
