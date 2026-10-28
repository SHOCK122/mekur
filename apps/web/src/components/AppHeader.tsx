import { useEffect, useState } from "react";
import {
  getFriendCode,
  rotateFriendCode,
  readInbox,
  acceptInvitation,
  dismissInvitation,
  saveConnection,
  findConnection,
  type Invitation,
} from "../lib/social.js";
import { redeemShareCode } from "../lib/events.js";
import type { Session } from "../lib/session.js";
import { NotificationToggle } from "./NotificationToggle.js";

interface AppHeaderProps {
  session: Session;
  onLogout: () => void;
  /** Called after something was added to the schedule from here, so the
   * owner can reload it. */
  onEventsChanged: () => void;
}

/** Who an invitation is from, as this person should see it. A saved
 * connection's name wins over whatever name the sender put in the invite:
 * the key is verified, the name in the invite is only self-described. */
function senderLabel(session: Session, invitation: Invitation): string {
  if (invitation.payload.viaCode || !invitation.senderPublicKey) return "Someone";
  const known = findConnection(session.userId, invitation.senderPublicKey);
  if (known) return known.displayName;
  return invitation.payload.fromDisplayName ?? "Someone";
}

export function AppHeader({ session, onLogout, onEventsChanged }: AppHeaderProps) {
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
      const { invitations: found, unreadable } = await readInbox(session);
      // Blocking is enforced here, on the device: the server can't filter
      // without learning who contacts whom.
      const blocked = found.filter(
        (i) => findConnection(session.userId, i.senderPublicKey)?.state === "blocked"
      );
      setInvitations(found.filter((i) => !blocked.includes(i)));
      // Delete what will never be shown. Hidden messages still count toward
      // the server's inbox cap, so leaving them would let a blocked sender
      // (or garbage) push real invitations out of view.
      await Promise.allSettled(
        [...unreadable, ...blocked.map((i) => i.messageId)].map((id) => dismissInvitation(session, id))
      );
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
      onEventsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the invitation");
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(invitation: Invitation) {
    setBusy(true);
    setError(null);
    try {
      await dismissInvitation(session, invitation.messageId);
      await refreshInvitations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reject the invitation");
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect(invitation: Invitation, state: "connected" | "blocked") {
    if (!invitation.senderPublicKey) return;
    saveConnection(session.userId, {
      publicKey: invitation.senderPublicKey,
      displayName: invitation.payload.fromDisplayName ?? "Unknown",
      username: invitation.payload.fromUsername,
      state,
    });
    // A block also discards what they sent: refreshInvitations deletes
    // messages from blocked senders.
    await refreshInvitations();
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
      onEventsChanged();
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
        <NotificationToggle session={session} />
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
          Join event
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
                <span>{senderLabel(session, invitation)} invited you to an event</span>
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
                  {!invitation.payload.viaCode &&
                    invitation.senderPublicKey &&
                    !findConnection(session.userId, invitation.senderPublicKey) && (
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
