import { useState } from "react";
import { AuthForm } from "./components/AuthForm.js";
import { Calendar } from "./components/Calendar.js";
import { loadSession, saveSession, clearSession, type Session } from "./lib/session.js";

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  function handleAuthenticated(newSession: Session) {
    saveSession(newSession);
    setSession(newSession);
  }

  function handleLogout() {
    clearSession();
    setSession(null);
  }

  return (
    <main className="app-shell">
      {session ? (
        <Calendar session={session} onLogout={handleLogout} />
      ) : (
        <AuthForm onAuthenticated={handleAuthenticated} />
      )}
    </main>
  );
}
