import type { DecryptedEvent } from "./api.js";

function cacheKey(userId: string): string {
  return `schedule-app:event-cache:${userId}`;
}

export function saveEventCache(userId: string, events: DecryptedEvent[]): void {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(events));
  } catch {
    // Storage can fail (quota, private browsing, etc.) -- caching is a nice-to-have,
    // never something that should break the app if it doesn't work.
  }
}

export function loadEventCache(userId: string): DecryptedEvent[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    return raw ? (JSON.parse(raw) as DecryptedEvent[]) : null;
  } catch {
    return null;
  }
}
