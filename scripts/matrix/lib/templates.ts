// W1-driving Task 13 — RED stub: every export refuses until Step 3.
const notYet = (): never => { throw new Error("templates: not implemented (W1-driving Task 13 RED)"); };
export const TEMPLATE_ROW: Readonly<Record<string, string>> = Object.freeze({});
export class UnknownTemplate extends Error {}
export class TemplateShapeUnsupported extends Error {}
export class TemplateDrifted extends Error {}
export function templateField(_key: string, _dir?: string): { sport: string; variant: string; entrantKind: string; entrantCount: number; stageKinds: readonly string[] } { return notYet(); }
export function templateRow(_key: string, _dir?: string): string { return notYet(); }
export function templateFor(_row: string, _sport: string): string | null { return notYet(); }
export function templateBodies(_key: string, _dir?: string): { seq: number; kind: string; config: Record<string, unknown>; progression: unknown }[] { return notYet(); }
