// W2a (preflight C7). The configs a sport DECLARES — never `configSchema.parse({})` blind: generic's resultMode and
// allowDraws have no default, so that throws and every sweep reds at generic. Pure: no node:fs, so it belongs in the
// published testkit barrel.

/** Every config a sport DECLARES: each `module.variants` entry parsed, plus the bare schema default only when the
 *  schema accepts `{}`. Throws when a sport declares none. */
export function declaredCfgs<Cfg>(m: {
  configSchema: { safeParse(v: unknown): { success: boolean; data?: unknown }; parse(v: unknown): unknown };
  variants: Record<string, Partial<Cfg>>;
}): { name: string; cfg: Cfg }[] {
  const out = Object.entries(m.variants).map(([name, v]) => ({ name, cfg: m.configSchema.parse(v) as Cfg }));
  const bare = m.configSchema.safeParse({});
  if (bare.success) out.unshift({ name: "(schema default)", cfg: bare.data as Cfg });
  if (out.length === 0) throw new Error("a sport declares no config: nothing to sweep");
  return out;
}
