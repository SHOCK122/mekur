export interface Session {
  userId: string;
  username: string;
  token: string;
  encryptionKey: string; // base64 — stored locally only, never sent to the server
}

const STORAGE_KEY = "schedule-app:session";

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
