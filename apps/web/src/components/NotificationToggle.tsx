import { useEffect, useState } from "react";
import {
  isPushSupported,
  getExistingSubscription,
  enablePushNotifications,
  disablePushNotifications,
} from "../lib/push.js";
import type { Session } from "../lib/session.js";

interface NotificationToggleProps {
  session: Session;
}

export function NotificationToggle({ session }: NotificationToggleProps) {
  const [supported] = useState(() => isPushSupported());
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getExistingSubscription()
      .then((subscription) => {
        if (!cancelled) setEnabled(Boolean(subscription));
      })
      .catch(() => {
        // Not being able to read the existing subscription state isn't
        // worth surfacing -- the toggle just shows as off, and turning it
        // on will re-subscribe cleanly.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!supported) return null;

  async function handleToggle() {
    setError(null);
    setBusy(true);
    try {
      if (enabled) {
        await disablePushNotifications(session);
        setEnabled(false);
      } else {
        await enablePushNotifications(session);
        setEnabled(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change notification settings");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="notification-toggle">
      <button type="button" onClick={handleToggle} disabled={busy} className="notification-button">
        {busy
          ? "Working\u2026"
          : enabled
            ? "Turn off notifications"
            : "Turn on notifications"}
      </button>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
