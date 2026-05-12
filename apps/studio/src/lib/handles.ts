/**
 * Generic position-based handle IDs and helpers.
 *
 * Every node gets the same handle layout: 5 evenly-spaced positions on
 * each of the four sides. IDs are `top-0..4`, `right-0..4`, `bottom-0..4`,
 * `left-0..4`. With xyflow in `connectionMode: "loose"`, each handle accepts
 * either a source or a target endpoint, so 20 attach points per box without
 * needing source/target pairs.
 *
 * The named handles we used previously (`in`, `out`, `back-in`, `back-out`,
 * `mem-in`, `mem-out`, `write-in`, `read-out`) are mapped to the closest
 * positional ID via LEGACY_HANDLE_MAP so layouts saved before this change
 * keep working.
 */

export type HandleSide = "top" | "right" | "bottom" | "left";

/** Handles per side. 5 gives 20 attach points per node — fine-grained
 *  enough to feel continuous; few enough to render fast. */
export const HANDLES_PER_SIDE = 5;

export interface HandleSpec {
  id: string;
  side: HandleSide;
  /** 0..1 — where along the side, top→bottom (left/right) or left→right (top/bottom). */
  fraction: number;
}

/** All handle specs for one node, in render order. */
export const ALL_HANDLES: HandleSpec[] = (() => {
  const out: HandleSpec[] = [];
  for (const side of ["top", "right", "bottom", "left"] as const) {
    for (let i = 0; i < HANDLES_PER_SIDE; i++) {
      out.push({
        id: `${side}-${i}`,
        side,
        fraction: (i + 1) / (HANDLES_PER_SIDE + 1),
      });
    }
  }
  return out;
})();

/** Center handle on each side — the conventional default attach point. */
export const CENTER = {
  top: `top-${Math.floor(HANDLES_PER_SIDE / 2)}`,
  right: `right-${Math.floor(HANDLES_PER_SIDE / 2)}`,
  bottom: `bottom-${Math.floor(HANDLES_PER_SIDE / 2)}`,
  left: `left-${Math.floor(HANDLES_PER_SIDE / 2)}`,
} as const;

/** Map legacy named handles to the closest positional handle. */
export const LEGACY_HANDLE_MAP: Record<string, string> = {
  in: CENTER.left,
  out: CENTER.right,
  "back-in": "top-0",
  "back-out": "bottom-0",
  "mem-out": "bottom-3",
  "mem-in": "bottom-4",
  "write-in": "top-1",
  "read-out": "top-3",
};

export function migrateHandleId(id: string | null | undefined): string | null | undefined {
  if (!id) return id;
  return LEGACY_HANDLE_MAP[id] ?? id;
}
