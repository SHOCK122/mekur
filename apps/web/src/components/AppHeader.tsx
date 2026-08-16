import { useEffect, useState } from "react";
import {
  getFriendCode,
  rotateFriendCode,
  listInvitations,
  acceptInvitation,
  dismissInvitation,
  saveConnection,
  isBlocked,
  type Invitation,
} from "../lib/social.js";
import { redeemShareCode } from "../lib/events.js";
import type { Session } from "../lib/session.js";

interface AppHeaderProps {
  session: Session;
  onLogout: () => void;
  onInvitationAccepted: () => void;
}

export function AppHeader({ session, onLogout, onInvitationAccepted }: AppHeaderProps) {
  const [code, setCode] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinStatus, setJoinStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshCode() {
    try {
      setCode((await getFriendCode(session)).code);
    } catch {
      // A missing code shouldn't break the header; the button just won't
      // have anything to show yet.
    }
  }

  async function refreshInvitations() {
    try {
      // Sender public keys we might need to decrypt with. Own key included
      // because an invite can be self-addressed during testing.
      const found = await listInvitations(session, [session.identityPublicKey]);
      setInvitations(found.filter((i) => !isBlocked(session.userId, i.payload.fromFriendCode)));
    } catch {
      // Inbox unavailable (offline, most likely) -- not worth an alarm.
    }
  }

  useEffect(() => {
    refreshCode();
    refreshInvitations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRotate() {
    setBusy(true);
    setError(null);
    try {
      setCode((await rotateFriendCode(session)).code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rotate your code");
    } finally {
      setBusy(false);
    }
  }

  async function handleAccept(invitation: Invitation) {
    setBusy(true);
    setError(null);
    try {
      await acceptInvitation(session, invitation);
      await refreshInvitations();
      onInvitationAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the invitation");
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(invitation: Invitation) {
    setBusy(true);
    try {
      await dismissInvitation(session, invitation.messageId);
      await refreshInvitations();
    } finally {
      setBusy(false);
    }
  }

  function handleConnect(invitation: Invitation, state: "connected" | "blocked") {
    const from = invitation.payload.fromFriendCode;
    if (!from) return;
    saveConnection(session.userId, {
      friendCode: from,
      displayName: invitation.payload.fromDisplayName ?? "Unknown",
      username: invitation.payload.fromUsername,
      state,
    });
    refreshInvitations();
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!joinCode.trim()) return;
    setBusy(true);
    setError(null);
    setJoinStatus(null);
    try {
      await redeemShareCode(session, joinCode);
      setJoinCode("");
      setJoinStatus("Event added to your schedule.");
      onInvitationAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not use that code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="app-header">
      <div className="app-header-identity">
        <span className="app-header-brand">Schedule</span>
        <span className="app-header-user">
          Signed in as <strong>{session.username}</strong>
        </span>
      </div>

      <nav className="app-header-actions" aria-label="Account">
        <button
          type="button"
          className="header-link"
          aria-expanded={showCode}
          onClick={() => setShowCode((v) => !v)}
        >
          Invite code
        </button>
        <button type="button" className="header-link" onClick={onLogout}>
          Sign out
        </button>
      </nav>

      {showCode && (
        <div className="friend-code-panel">
          <p className="friend-code-value" aria-live="polite">
            {code ?? "Loading\u2026"}
          </p>
          <p className="friend-code-help">
            Single use, and anonymous. Whoever uses it can invite you to an event
            without learning who you are, and the code replaces itself immediately
            afterwards.
          </p>
          <button type="button" onClick={handleRotate} disabled={busy}>
            {busy ? "Working\u2026" : "Replace this code"}
          </button>
        </div>
      )}

      <form onSubmit={handleJoin} className="join-form">
        <label className="inline-label">
          Have an event code?
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            aria-label="Event code"
            placeholder="Paste an event code"
          />
        </label>
        <button type="submit" disabled={busy || !joinCode.trim()}>
          Add event
        </button>
      </form>
      {joinStatus && (
        <p className="share-status" role="status">
          {joinStatus}
        </p>
      )}

      {invitations.length > 0 && (
        <section className="invitations" aria-label="Invitations">
          <h2>
            {invitations.length} invitation{invitations.length === 1 ? "" : "s"}
          </h2>
          <ul>
            {invitations.map((invitation) => (
              <li key={invitation.messageId} className="invitation">
                <span>
                  {invitation.payload.viaCode
                    ? "Someone invited you to an event"
                    : `${invitation.payload.fromDisplayName ?? "Someone"} invited you to an event`}
                </span>
                <div className="invitation-actions">
                  <button type="button" onClick={() => handleAccept(invitation)} disabled={busy}>
                    Accept
                  </button>
                  <button type="button" onClick={() => handleReject(invitation)} disabled={busy}>
                    Reject
                  </button>
                  {/* No connect or block option for an anonymous invite: the
                      code existed so that no lasting identity was exchanged,
                      and there is nothing stable to connect to or block. */}
                  {!invitation.payload.viaCode && invitation.payload.fromFriendCode && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleConnect(invitation, "connected")}
                        disabled={busy}
                      >
                        Add connection
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConnect(invitation, "blocked")}
                        disabled={busy}
                      >
                        Block
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}
