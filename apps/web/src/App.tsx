import { useState } from "react";
import { AuthForm } from "./components/AuthForm.js";
import { Calendar } from "./components/Calendar.js";
import { GroupEvents } from "./components/GroupEvents.js";
import { loadSession, saveSession, clearSession, type Session } from "./lib/session.js";

type Tab = "calendar" | "group";

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [tab, setTab] = useState<Tab>("calendar");

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
          <nav className="tab-bar" aria-label="Sections">
            <button
              type="button"
              className={tab === "calendar" ? "tab active" : "tab"}
              onClick={() => setTab("calendar")}
            >
              My Calendar
            </button>
            <button
              type="button"
              className={tab === "group" ? "tab active" : "tab"}
              onClick={() => setTab("group")}
            >
              Group Events
            </button>
          </nav>
          {tab === "calendar" ? (
            <Calendar session={session} onLogout={handleLogout} />
          ) : (
            <GroupEvents session={session} />
          )}
        </div>
      ) : (
        <AuthForm onAuthenticated={handleAuthenticated} />
      )}
    </main>
  );
}
