import { parseJsonOrThrow } from "./http.js";
import type { Session } from "./session.js";

const API_BASE = "/api";

function authHeaders(session: Session) {
  return { authorization: `Bearer ${session.token}` };
}

/** Converts a base64url VAPID public key into the Uint8Array shape
 * PushManager.subscribe() requires for applicationServerKey. The explicit
 * ArrayBuffer backing matters: applicationServerKey is typed as
 * BufferSource, which excludes SharedArrayBuffer-backed views. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function fetchVapidPublicKey(): Promise<string> {
  const response = await fetch(`${API_BASE}/push/vapid-public-key`);
  const body = await parseJsonOrThrow(response);
  return body.publicKey;
}

/** Requests notification permission, subscribes via the browser's Push API,
 * and registers the subscription with the server. Throws if the person
 * denies permission or the browser doesn't support push -- callers should
 * catch and show a friendly message rather than letting this crash the UI. */
export async function enablePushNotifications(session: Session): Promise<void> {
  if (!isPushSupported()) {
    throw new Error("Push notifications aren't supported in this browser.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const vapidPublicKey = await fetchVapidPublicKey();
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const json = subscription.toJSON();
  const response = await fetch(`${API_BASE}/push-subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(session) },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    }),
  });
  if (!response.ok) {
    await parseJsonOrThrow(response);
  }
}

export async function disablePushNotifications(session: Session): Promise<void> {
  const subscription = await getExistingSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  const response = await fetch(`${API_BASE}/push-subscriptions`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...authHeaders(session) },
    body: JSON.stringify({ endpoint }),
  });
  // 404 is fine here: the server may have already pruned this subscription
  // (e.g. the push service reported it as gone), which isn't an error from
  // the person's point of view -- they wanted it off, and it's off.
  if (!response.ok && response.status !== 404) {
    await parseJsonOrThrow(response);
  }
}
