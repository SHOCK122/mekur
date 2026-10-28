import { useState } from "react";
import { resolveTag, sendInvite, loadConnections } from "../lib/social.js";
import { createShareCode, type DecryptedEvent } from "../lib/events.js";
import { findEntry } from "../lib/keyring.js";
import type { Session } from "../lib/session.js";

interface ShareEventProps {
  session: Session;
  event: DecryptedEvent;
  onClose: () => void;
}

export function ShareEvent({ session, event, onClose }: ShareEventProps) {
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  // Saved connections become suggestions; they're the people you've chosen
  // to keep, so they're the likeliest to invite.
  const [suggestions] = useState(() =>
    loadConnections(session.userId).filter((c) => c.state === "connected" && c.username)
  );

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!tag.trim()) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const entry = await findEntry(session, event.id);
      if (!entry) throw new Error("You no longer have access to this event.");
      const target = await resolveTag(session, tag);
      // View access only: an invitee who should edit can be given an edit
      // capability later, but over-granting can't be taken back.
      await sendInvite(session, target, {
        eventId: event.id,
        viewToken: entry.viewToken,
        eventKey: entry.eventKey,
      });
      setStatus(
        target.viaCode
          ? "Invitation sent. Neither of you learns who the other is."
          : `Invitation sent to ${target.displayName}.`
      );
      setTag("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the invitation");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateCode() {
    setBusy(true);
    setError(null);
    try {
      setShareCode(await createShareCode(session, event.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="share-panel" aria-label={`Share ${event.title}`}>
      <h3>Share &ldquo;{event.title}&rdquo;</h3>

      <form onSubmit={handleInvite} className="share-form">
        <label className="inline-label">
          Username or one-time code
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="e.g. ada or ABCD2345"
            list={suggestions.length > 0 ? "share-suggestions" : undefined}
          />
        </label>
        {suggestions.length > 0 && (
          <datalist id="share-suggestions">
            {suggestions.map((c) => (
              <option key={c.publicKey} value={c.username}>
                {c.displayName}
              </option>
            ))}
          </datalist>
        )}
        <button type="submit" disabled={busy || !tag.trim()}>
          {busy ? "Working…" : "Send invitation"}
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
    </section>
  );
}
