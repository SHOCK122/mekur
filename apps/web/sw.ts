/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";
import { clientsClaim } from "workbox-core";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// Precaches the app shell -- same offline-first behavior as before.
// Switching from vite-plugin-pwa's generateSW mode to injectManifest
// mode was necessary to add the push/notificationclick listeners below
// (generateSW only configures caching, it can't run custom JS).
precacheAndRoute(self.__WB_MANIFEST);

self.skipWaiting();
clientsClaim();

interface PushPayload {
  title: string;
  body: string;
}

self.addEventListener("push", (event) => {
  let payload: PushPayload = { title: "Schedule App", body: "You have a new notification." };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // Malformed/empty payload: fall back to the generic message above
    // rather than failing to show anything at all.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/pwa-192x192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => "focus" in client);
      if (existing) return (existing as WindowClient).focus();
      return self.clients.openWindow("/");
    })
  );
});
