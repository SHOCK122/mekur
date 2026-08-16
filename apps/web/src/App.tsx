import { useState } from "react";
import { AuthForm } from "./components/AuthForm.js";
import { Calendar } from "./components/Calendar.js";
import { AppHeader } from "./components/AppHeader.js";
import { loadSession, saveSession, clearSession, type Session } from "./lib/session.js";

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [calendarKey, setCalendarKey] = useState(0);

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
        <div className="app-authenticated">
          <AppHeader
            session={session}
            onLogout={handleLogout}
            onInvitationAccepted={() => setCalendarKey((k) => k + 1)}
          />
          {/* Remounting is a blunt but honest way to pick up a newly
              accepted event; the timeline rewrite will replace it with
              proper shared state. */}
          <Calendar key={calendarKey} session={session} onLogout={handleLogout} />
        </div>
      ) : (
        <AuthForm onAuthenticated={handleAuthenticated} />
      )}
    </main>
  );
}
