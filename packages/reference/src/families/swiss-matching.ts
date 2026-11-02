// The matching oracles behind the Swiss existence check (format-matrix W3, Task 19; rulebook-W3-swiss.md §2.3 item 3
// and its bound RB3-24). Written from the textbook algorithms (Edmonds 1965, "Paths, trees, and flowers"), never from
// engine code (R8): the engine's pairing is the thing these oracles judge.
//
// - `blossomMatching`: Edmonds' blossom algorithm, a maximum-cardinality matching on a general graph. Polynomial, so it
//   covers every harness field n <= 128 (RB3-24). Larger fields are refused, never answered.
// - `bruteForcePerfectMatching` / `bruteForceMaximumMatching`: exhaustive cross-checks of the oracle itself, n <= 12
//   (RB3-24).

/** RB3-24: the existence check covers every harness field up to this size. */
export const BLOSSOM_MAX_N = 128;
/** RB3-24: the brute-force cross-check of the oracle runs up to this size. */
export const BRUTE_FORCE_MAX_N = 12;

/** A question outside the reference's declared bound — refused by name, never answered (RB3-24). */
export class SwissOutOfScope extends Error {
  constructor(what: string) {
    super(`swiss reference: out of scope: ${what}`);
    this.name = "OutOfScope";
  }
}

/**
 * Edmonds' blossom: `mate[i]` is i's partner in a maximum-cardinality matching, or -1. Refuses n > 128 (RB3-24).
 *
 * From every free vertex in turn, grow an alternating tree by breadth-first search; an odd cycle (a blossom) is
 * contracted onto its base, and the search continues through it; reaching a free vertex is an augmenting path, which
 * flips the matching along it. A vertex whose search finds no augmenting path stays free in some maximum matching
 * (Edmonds), so the scan goes on to the next free vertex rather than stopping.
 */
export function blossomMatching(n: number, edges: readonly (readonly [number, number])[]): Int32Array {
  guardGraph("blossomMatching", n, edges, BLOSSOM_MAX_N);
  const adj = adjacency(n, edges);
  const mate = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n);
  const base = new Int32Array(n);
  const used = new Uint8Array(n);
  const inBlossom = new Uint8Array(n);
  const queue = new Int32Array(n);

  /** The base of the blossom where the alternating paths from a and b first meet. */
  const lowestCommonBase = (a0: number, b0: number): number => {
    const seen = new Uint8Array(n);
    let a = a0;
    for (;;) {
      a = at(base, a);
      seen[a] = 1;
      if (at(mate, a) === -1) break;
      a = at(parent, at(mate, a));
    }
    let b = b0;
    for (;;) {
      b = at(base, b);
      if (at(seen, b) === 1) return b;
      b = at(parent, at(mate, b));
    }
  };
  /** Marks the blossom's vertices on the path from v down to its base b, re-pointing parents through the cycle. */
  const markPath = (v0: number, b: number, child0: number): void => {
    let v = v0;
    let child = child0;
    while (at(base, v) !== b) {
      const m = at(mate, v);
      inBlossom[at(base, v)] = 1;
      inBlossom[at(base, m)] = 1;
      parent[v] = child;
      child = m;
      v = at(parent, m);
    }
  };
  /** The free vertex an augmenting path from root ends at, or -1. */
  const findAugmentingPath = (root: number): number => {
    used.fill(0);
    parent.fill(-1);
    for (let i = 0; i < n; i++) base[i] = i;
    used[root] = 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = root;
    while (head < tail) {
      const v = at(queue, head++);
      for (const to of at(adj, v)) {
        if (at(base, v) === at(base, to) || at(mate, v) === to) continue;
        const toMate = at(mate, to);
        if (to === root || (toMate !== -1 && at(parent, toMate) !== -1)) {
          // `to` is an outer vertex of the same tree: an odd cycle. Contract it onto its base.
          const cycleBase = lowestCommonBase(v, to);
          inBlossom.fill(0);
          markPath(v, cycleBase, to);
          markPath(to, cycleBase, v);
          for (let i = 0; i < n; i++) {
            if (at(inBlossom, at(base, i)) === 1) {
              base[i] = cycleBase;
              if (at(used, i) === 0) {
                used[i] = 1;
                queue[tail++] = i;
              }
            }
          }
        } else if (at(parent, to) === -1) {
          parent[to] = v;
          if (toMate === -1) return to;
          used[toMate] = 1;
          queue[tail++] = toMate;
        }
      }
    }
    return -1;
  };

  for (let root = 0; root < n; root++) {
    if (at(mate, root) !== -1) continue;
    // Flip the matching along the augmenting path, from its free end back to the root. No path: root stays free, and
    // the scan continues with the next vertex.
    let v = findAugmentingPath(root);
    // An augmenting path is simple, so the walk back flips at most n/2 pairs; a longer walk is a cycle in the parent
    // pointers — a broken search, refused rather than looped on forever.
    for (let flips = 0; v !== -1; flips++) {
      if (flips > n / 2) throw new Error(`blossomMatching: the augmenting walk from ${root} does not end — the search is broken`);
      const pv = at(parent, v);
      const next = at(mate, pv);
      mate[v] = pv;
      mate[pv] = v;
      v = next;
    }
  }
  return mate;
}

/** Does the graph have a perfect matching? Exhaustive backtracking: the lowest free vertex tries every free neighbour. Refuses n > 12. */
export function bruteForcePerfectMatching(n: number, edges: readonly (readonly [number, number])[]): boolean {
  guardGraph("bruteForcePerfectMatching", n, edges, BRUTE_FORCE_MAX_N);
  if (n % 2 === 1) return false;
  const adj = adjacencyMatrix(n, edges);
  const taken = new Array<boolean>(n).fill(false);
  const solve = (): boolean => {
    const i = taken.indexOf(false);
    if (i === -1) return true;
    taken[i] = true;
    for (let j = i + 1; j < n; j++) {
      if (taken[j] === true || at(adj, i)[j] !== true) continue;
      taken[j] = true;
      if (solve()) return true;
      taken[j] = false;
    }
    taken[i] = false;
    return false;
  };
  return solve();
}

/** The size of a maximum matching: exhaustive search over which vertices are still free (memoised by bitmask). Refuses n > 12. */
export function bruteForceMaximumMatching(n: number, edges: readonly (readonly [number, number])[]): number {
  guardGraph("bruteForceMaximumMatching", n, edges, BRUTE_FORCE_MAX_N);
  const adj = adjacencyMatrix(n, edges);
  const memo = new Map<number, number>();
  // best(free): the largest matching among the vertices whose bits are set in `free`.
  const best = (free: number): number => {
    if (free === 0) return 0;
    const known = memo.get(free);
    if (known !== undefined) return known;
    let i = 0;
    while ((free & (1 << i)) === 0) i++;
    const rest = free & ~(1 << i);
    let answer = best(rest); // i left unmatched
    for (let j = i + 1; j < n; j++) {
      if ((rest & (1 << j)) !== 0 && at(adj, i)[j] === true) answer = Math.max(answer, 1 + best(rest & ~(1 << j)));
    }
    memo.set(free, answer);
    return answer;
  };
  return best(n === 0 ? 0 : (1 << n) - 1);
}

function adjacency(n: number, edges: readonly (readonly [number, number])[]): number[][] {
  const adj = Array.from({ length: n }, (): number[] => []);
  for (const [u, v] of edges) {
    at(adj, u).push(v);
    at(adj, v).push(u);
  }
  return adj;
}

function adjacencyMatrix(n: number, edges: readonly (readonly [number, number])[]): boolean[][] {
  const m = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (const [u, v] of edges) {
    at(m, u)[v] = true;
    at(m, v)[u] = true;
  }
  return m;
}

/** An index read that cannot silently answer `undefined`: an out-of-range read is a broken oracle, refused. */
function at<T>(a: ArrayLike<T>, i: number): T {
  const x = a[i];
  if (x === undefined) throw new RangeError(`swiss-matching: index ${i} outside [0, ${a.length})`);
  return x;
}

/** The graph's own assumptions, as guards: a vertex count in [0, max], and edges between two distinct vertices of it. */
function guardGraph(who: string, n: number, edges: readonly (readonly [number, number])[], max: number): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${who}: n must be a non-negative integer, got ${n}`);
  if (n > max) throw new SwissOutOfScope(`${who} answers n <= ${max} (RB3-24), got n = ${n}`);
  for (const [u, v] of edges) {
    if (!Number.isInteger(u) || !Number.isInteger(v) || u < 0 || v < 0 || u >= n || v >= n) {
      throw new RangeError(`${who}: edge [${u}, ${v}] leaves the vertex range [0, ${n})`);
    }
    if (u === v) throw new RangeError(`${who}: edge [${u}, ${v}] is a self-loop`);
  }
}
