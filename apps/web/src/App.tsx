import { useState } from "react";
import { AuthForm } from "./components/AuthForm.js";
import { AppHeader } from "./components/AppHeader.js";
import { Schedule } from "./components/Schedule.js";
import { useEvents } from "./hooks/useEvents.js";
import { clearKeyringCache } from "./lib/keyring.js";
import { loadSession, saveSession, clearSession, type Session } from "./lib/session.js";

function SignedIn({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const data = useEvents(session);
  return (
    <div className="app-authenticated">
      <AppHeader session={session} onLogout={onLogout} onEventsChanged={() => void data.refresh()} />
      <Schedule session={session} data={data} />
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());

  function handleAuthenticated(newSession: Session) {
    saveSession(newSession);
    setSession(newSession);
  }

  function handleLogout() {
    clearSession();
    clearKeyringCache();
    setSession(null);
  }

  return (
    <main className="app-shell">
      {session ? (
        <SignedIn key={session.userId} session={session} onLogout={handleLogout} />
      ) : (
        <AuthForm onAuthenticated={handleAuthenticated} />
      )}
    </main>
  );
}
