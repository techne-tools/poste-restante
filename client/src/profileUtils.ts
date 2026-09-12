/**
 * The record's pure rules — small, so the safety they encode is testable.
 */

/** The password change is ready when the current key is present, a new key
 *  is typed, and both tellings agree. The house never resets anyone, so this
 *  agreement is the whole safety of the act — a mistyped new key would be a
 *  permanent lockout. */
export function passwordReady(current: string, next: string, again: string): boolean {
  return current.length > 0 && next.trim().length > 0 && next === again;
}
