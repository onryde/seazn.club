// The receipt's rendered tree for the suites that drive it (receipt.test.tsx, package-host-camera.test.tsx): the hook harness's one-level walk, deepened
// through the Modal's `footer` prop and any hook-using child component, so a test can find a control by its testid and press it as a browser would.
import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { expandWithHooks } from "@/components/__tests__/_hook-harness";
import { Modal } from "@/components/modal";

/** Every element the receipt draws: the harness's one-level walk, plus the Modal's `footer` prop and any hook-using child component. */
export function expandAll(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) expandAll(n, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  const p = node.props as { children?: ReactNode; footer?: ReactNode };
  if (typeof node.type === "function" && node.type !== Modal) expandAll(expandWithHooks(node.type as (props: unknown) => ReactNode, node.props), out);
  expandAll(p.children, out);
  if (p.footer !== undefined) expandAll(p.footer, out);
  return out;
}
export const textOfAll = (els: ReactElement[]) => {
  const parts: string[] = [];
  const visit = (n: ReactNode) => {
    if (typeof n === "string" || typeof n === "number") parts.push(String(n));
    else if (Array.isArray(n)) n.forEach(visit);
    else if (isValidElement(n)) {
      const p = n.props as { children?: ReactNode; footer?: ReactNode };
      if (typeof n.type === "function" && n.type !== Modal) visit(expandWithHooks(n.type as (props: unknown) => ReactNode, n.props));
      visit(p.children);
      if (p.footer !== undefined) visit(p.footer);
    }
  };
  els.forEach(visit);
  return parts.join(" ").replace(/\s+/g, " ").trim();
};
