// Deterministic integer seed for a given calendar day, salted per game so
// two daily games landing on the same date never draw the same index from
// their own content list (e.g. Daily Word's answer list). Pure: the hash
// itself only ever sees the (date, salt) strings it's called with — no
// Date.now()/Math.random() inside it. `date` defaults to the *local*
// calendar day (Daily Word's rule: "one puzzle per calendar day, local
// time"), but that default is resolved once, at the call site, via a plain
// `new Date()` — ordinary app code is free to do that; it's workflow/build
// scripts that must avoid real-time reads, not this.
//
// Callers should always pass their own `salt` (their game's slug is a good
// choice) — see the "different salts" test in daily-seed.test.ts for why.

function todayISO(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

// FNV-1a, 32-bit. Small, dependency-free, and stable across runs/platforms
// for the short ASCII strings (ISO dates + game slugs) this is ever fed.
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // unsigned 32-bit integer
}

export function dailySeed(date: string = todayISO(), salt: string): number {
  return hash32(`${date}:${salt}`);
}
