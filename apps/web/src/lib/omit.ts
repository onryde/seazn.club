/**
 * A shallow copy of `obj` without `keys` — exactly what the rest-destructure
 * omit (`const { secret: _secret, ...rest } = row`) produces, minus the binding
 * nothing reads. apps/web's eslint config has no `^_` ignore pattern, so that
 * destructure is a standing `no-unused-vars` warning; this is its replacement.
 *
 * Own enumerable keys (symbols included) are copied in their original order,
 * the named keys are REMOVED (not set to undefined), and the input is never
 * mutated. Pure and dependency-free, so it is safe on both sides of the wire.
 */
export function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const out: Partial<T> = { ...obj };
  for (const key of keys) delete out[key];
  return out as Omit<T, K>;
}
