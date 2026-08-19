import { useState } from "react";
import { resolveTag, sendInvite, getFriendCode } from "../lib/social.js";
import { createShareCode } from "../lib/events.js";
import { loadKeyring } from "../lib/keyring.js";
import { getErrorMessage } from "../lib/http.js";
import type { Session } from "../lib/session.js";

interface ShareEventProps {
  session: Session;
  eventId: string;
  eventTitle: string;
  onClose: () => void;
}

export function ShareEvent({ session, eventId, eventTitle, onClose }: ShareEventProps) {
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!tag.trim()) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const target = await resolveTag(session, tag);
      const keyring = await loadKeyring(session);
      const entry = keyring.entries.find((k) => k.eventId === eventId);
      if (!entry) throw new Error("You no longer have access to this event.");

      // Include our own friend code only for named invites, so the
      // recipient has something durable to connect to. An anonymous
      // recipient gets nothing identifying -- sendInvite enforces that too.
      const myCode = target.viaCode ? undefined : (await getFriendCode(session)).code;

      await sendInvite(session, target, {
        eventId,
        viewToken: entry.viewToken,
        eventKey: entry.eventKey,
        fromDisplayName: session.username,
        fromUsername: session.username,
        fromFriendCode: myCode,
      });
      setStatus(
        target.viaCode
          ? "Invitation sent. They won't see who you are."
          : `Invitation sent to ${target.displayName}.`
      );
      setTag("");
    } catch (err) {
      setError(getErrorMessage(err, "Could not send the invitation"));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateCode() {
    setBusy(true);
    setError(null);
    try {
      setShareCode(await createShareCode(session, eventId));
    } catch (err) {
      setError(getErrorMessage(err, "Could not create a code"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="share-panel">
      <h3>Share &ldquo;{eventTitle}&rdquo;</h3>

      <form onSubmit={handleInvite} className="share-form">
        <label className="inline-label">
          Username or one-time code
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            aria-label="Username or one-time code"
            placeholder="e.g. ada or ABCD2345"
          />
        </label>
        <button type="submit" disabled={busy || !tag.trim()}>
          {busy ? "Working\u2026" : "Send invitation"}
        </button>
      </form>

      <div className="share-code-section">
        <button type="button" onClick={handleCreateCode} disabled={busy}>
          Create a shareable event code
        </button>
        {shareCode && (
          <div className="share-code-result">
            <p className="share-code-value" aria-live="polite">
              {shareCode}
            </p>
            <p className="share-code-warning">
              Treat this like a password. It contains the key to this event, so
              anyone you send it to &mdash; or anyone they forward it to &mdash;
              can read the event. Revoking it later stops new people using it,
              but cannot take back access from someone who already has it.
            </p>
          </div>
        )}
      </div>

      {status && (
        <p className="share-status" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}

      <button type="button" className="header-link" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
