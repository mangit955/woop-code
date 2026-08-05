/**
 * How long ago something happened, in one short phrase.
 *
 * Coarse on purpose: a session row needs "when", not a timestamp, and the
 * picker has one narrow column for it. Its own module rather than a helper
 * inside the slash commands, so a TUI component can use it without pulling the
 * command registry in behind it.
 */
export function relativeTime(when: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000));
  if (seconds < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  return `${Math.round(days / 30)}mo ago`;
}
