import { resolve, sep } from 'node:path';

/**
 * Browser harnesses and benches each bind a fixed localhost port, and the pool is reused: 4176,
 * 4177, 4178, 4185, 4186, 4187, 4188 and 4198 each appear in more than one file. CI runs them one
 * at a time, so a shared port is invisible there. Parallel task worktrees run them at the same
 * time, where the collision is a hard failure that reads exactly like a real defect — and a bench
 * paired against a contended run reports a regression that is not real.
 *
 * The offset is derived from the checkout, not from an environment variable, so no runner has to
 * remember to set anything. A checkout outside `.worktrees/` resolves to the historical port, which
 * is what keeps CI bit-identical.
 */
const WORKTREE_DIRECTORY = '.worktrees';
const PORTS_PER_WORKTREE = 64;
const MAX_WORKTREE_SLOTS = 32;

/** Stable across runs so a port collision stays reproducible; FNV-1a over the worktree name. */
function worktreeSlot(name) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % MAX_WORKTREE_SLOTS) + 1;
}

/** The `.worktrees/<name>` segment of a path, or null when the path is a normal checkout. */
export function worktreeNameFor(directory) {
  const segments = resolve(directory).split(sep);
  const index = segments.lastIndexOf(WORKTREE_DIRECTORY);
  if (index === -1 || index + 1 >= segments.length) {
    return null;
  }
  return segments[index + 1];
}

/**
 * @param {number} basePort the port this harness has always used
 * @param {string} [directory] checkout to resolve for; defaults to the current working directory
 */
export function resolveHarnessPort(basePort, directory = process.cwd()) {
  const name = worktreeNameFor(directory);
  if (name === null) {
    return basePort;
  }
  return basePort + worktreeSlot(name) * PORTS_PER_WORKTREE;
}

export const HARNESS_PORT_SPAN = PORTS_PER_WORKTREE;
