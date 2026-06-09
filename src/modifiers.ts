/**
 * Read the modifier-key flags off a native DOM event (mouse/pointer/keyboard) as plain
 * booleans, for the `PointerEvent` the adapters forward. `undefined`/missing ⇒ all false.
 */
export function modifiers(
  e?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } | null,
): { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean } {
  return { ctrlKey: !!e?.ctrlKey, metaKey: !!e?.metaKey, shiftKey: !!e?.shiftKey, altKey: !!e?.altKey };
}
