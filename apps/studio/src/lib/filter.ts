/**
 * Helpers for the FilterEntry shape (matches @cadmus/kernel's FilterEntry).
 *
 * A processor's filter is either a bare event-type string ("input") or a
 * {type, source} object that also constrains by attribution. Studio
 * needs to render these and decide which processor fires on a given event.
 */

import type { CadmusEvent, FilterEntry } from "./types";

/** Display label for a filter entry. */
export function filterEntryLabel(f: FilterEntry): string {
  if (typeof f === "string") return f;
  return f.source ? `${f.type} ← ${f.source}` : f.type;
}

/** Extract just the event types referenced by a filter. */
export function filterEventTypes(filter: FilterEntry[]): string[] {
  return filter.map((f) => (typeof f === "string" ? f : f.type));
}

/** Type-only match — for graph edge construction where source isn't known. */
export function filterMatchesType(filter: FilterEntry[], eventType: string): boolean {
  return filter.some((f) => (typeof f === "string" ? f === eventType : f.type === eventType));
}

/** Full match — type AND source. Use this for "did this event actually trigger this processor?". */
export function filterMatchesEvent(filter: FilterEntry[], event: CadmusEvent): boolean {
  return filter.some((f) => {
    if (typeof f === "string") return f === event.type;
    if (f.type !== event.type) return false;
    if (f.source !== undefined && f.source !== event.source) return false;
    return true;
  });
}
