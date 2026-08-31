/**
 * Horizon View — pure logic for plural time (DESIGN.md: the unit and the
 * frame). The letter flow is the axis; frames are parallel lines flanking
 * it. Selecting lines brings the *intersection* forward and dims the rest.
 *
 * The classification contract:
 *   - no frame selected       → "none"   (nothing dims)
 *   - in ALL selected frames  → "full"   (the ∩ — foreground)
 *   - in SOME selected frames → "partial"
 *   - in none                 → "dim"
 */
import type { Letter } from "./api";

export interface FrameInfo {
  id: string;
  name: string;
  value: string;
}

export type HorizonClass = "none" | "full" | "partial" | "dim";

/** Is this letter inside the frame identified by `name:value`? */
export function letterInFrame(letter: Letter, name: string, value: string): boolean {
  return letter.time.frames.some((f) => f.frame === name && f.value === value);
}

/** Classify a letter against the set of active frame keys (`name:value`). */
export function classifyLetter(letter: Letter, active: ReadonlySet<string>): HorizonClass {
  if (active.size === 0) return "none";
  let inAny = false;
  let inAll = true;
  for (const key of active) {
    const [name, value] = key.split(":");
    if (!name || !value) continue;
    if (letterInFrame(letter, name, value)) inAny = true;
    else inAll = false;
  }
  if (inAll) return "full";
  if (inAny) return "partial";
  return "dim";
}

/**
 * Row positions (indexes into the displayed letter flow) where each frame
 * carries a letter — the ticks on the transit lines.
 */
export function railPositions(
  letters: Letter[],
  frames: FrameInfo[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const f of frames) {
    const positions: number[] = [];
    letters.forEach((l, i) => {
      if (letterInFrame(l, f.name, f.value)) positions.push(i);
    });
    map.set(f.id, positions);
  }
  return map;
}

/** Chronological flow — the archive's axis when browsing (newest first). */
export function byTimeDesc(a: Letter, b: Letter): number {
  return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
}

/**
 * A quiet surface for a contradiction, without picking a side (DESIGN.md
 * archive rule 4). Where letters in one frame also share a thread, more than
 * one account of that thread sits in the same frame — the reader is told the
 * accounts may not agree, and both are left at full weight. No ranking, no
 * verdict. Returns the set of thread ids that carry two or more letters in
 * the given frame.
 */
export function threadsWithMultipleAccounts(
  letters: Letter[],
  frameId: string,
): Set<string> {
  const perThread = new Map<string, number>();
  const [name, value] = frameId.split(":");
  for (const l of letters) {
    if (!name || !value) continue;
    if (!letterInFrame(l, name, value)) continue;
    perThread.set(l.envelope.thread, (perThread.get(l.envelope.thread) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [thread, count] of perThread) {
    if (count >= 2) out.add(thread);
  }
  return out;
}
