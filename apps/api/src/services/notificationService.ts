import webpush from "web-push";
import type { PushSubscriptionRepository } from "../repositories/pushSubscriptionRepository.js";

export interface NotificationPayload {
  title: string;
  body: string;
}

export interface NotificationServiceOptions {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

/**
 * Sends Web Push notifications. Payloads must stay generic -- the server
 * never has access to event titles/content (they're end-to-end encrypted),
 * so a notification can say "You've been invited to a group event" but
 * never the event's actual title. This is a natural consequence of the
 * encryption model, not an extra restriction bolted on here.
 */
export function createNotificationService(
  pushSubscriptions: PushSubscriptionRepository,
  options: NotificationServiceOptions
) {
  webpush.setVapidDetails(options.vapidSubject, options.vapidPublicKey, options.vapidPrivateKey);

  return {
    /** Sends to every device the user has subscribed. Never throws for an
     * individual failed delivery -- a dead/expired subscription is pruned
     * instead, and one failure doesn't block others (this is called for
     * potentially many recipients, e.g. every invitee of a group event). */
    async notifyUser(userId: string, payload: NotificationPayload): Promise<void> {
      const subscriptions = await pushSubscriptions.listForUser(userId);
      await Promise.all(
        subscriptions.map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              JSON.stringify(payload)
            );
          } catch (err) {
            const statusCode = (err as { statusCode?: number }).statusCode;
            if (statusCode === 404 || statusCode === 410) {
              // Subscription is gone (browser unsubscribed, device reset,
              // etc.) -- prune it so we stop wasting time on it.
              await pushSubscriptions.deleteByEndpoint(sub.endpoint);
            }
            // Other failures (network blip, push service hiccup) are
            // swallowed rather than propagated: a notification failing to
            // send should never break the underlying action (creating/
            // resolving an event) that triggered it.
          }
        })
      );
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
