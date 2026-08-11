import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { urlBase64ToUint8Array, isPushSupported } from "../src/lib/push.js";
import { NotificationToggle } from "../src/components/NotificationToggle.js";
import type { Session } from "../src/lib/session.js";

const session: Session = {
  userId: "u1",
  username: "ada",
  token: "t",
  encryptionKey: "k",
  identityPublicKey: "pub",
  identitySecretKey: "sec",
};

/** Installs a fake serviceWorker/PushManager/Notification environment,
 * since jsdom has none of these. Returns handles so tests can assert on
 * what the code actually called. */
function stubPushEnvironment(options: {
  existingSubscription?: { endpoint: string; unsubscribe: () => Promise<boolean> } | null;
  permission?: NotificationPermission;
} = {}) {
  const subscribeMock = vi.fn().mockResolvedValue({
    endpoint: "https://push.example.com/new-device",
    toJSON: () => ({
      endpoint: "https://push.example.com/new-device",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    }),
  });
  const getSubscriptionMock = vi.fn().mockResolvedValue(options.existingSubscription ?? null);
  const requestPermissionMock = vi.fn().mockResolvedValue(options.permission ?? "granted");

  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: { subscribe: subscribeMock, getSubscription: getSubscriptionMock },
      }),
    },
  });
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { requestPermission: requestPermissionMock });

  return { subscribeMock, getSubscriptionMock, requestPermissionMock };
}

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url string with URL-safe characters", () => {
    // "-_" are the base64url substitutes for "+/" -- decoding must handle
    // them, since real VAPID keys routinely contain them.
    const decoded = urlBase64ToUint8Array("qUFTF3lXxouxuo_n0kPvwpMn2Ehl3W51M8Aw3vap5QQ");
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded.length).toBe(32); // VAPID private keys are 32 bytes
  });

  it("handles missing padding", () => {
    expect(() => urlBase64ToUint8Array("YWJj")).not.toThrow();
    expect(() => urlBase64ToUint8Array("YWJjZA")).not.toThrow();
  });
});

describe("isPushSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when the browser lacks push APIs (as jsdom does by default)", () => {
    expect(isPushSupported()).toBe(false);
  });

  it("returns true once the push APIs are present", () => {
    stubPushEnvironment();
    expect(isPushSupported()).toBe(true);
  });
});

describe("NotificationToggle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing at all when push isn't supported, rather than a broken button", () => {
    const { container } = render(<NotificationToggle session={session} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers to turn notifications on when there's no existing subscription", async () => {
    stubPushEnvironment({ existingSubscription: null });
    render(<NotificationToggle session={session} />);
    expect(await screen.findByRole("button", { name: /turn on notifications/i })).toBeInTheDocument();
  });

  it("shows the off-switch when a subscription already exists", async () => {
    stubPushEnvironment({
      existingSubscription: { endpoint: "https://push.example.com/x", unsubscribe: vi.fn() },
    });
    render(<NotificationToggle session={session} />);
    expect(await screen.findByRole("button", { name: /turn off notifications/i })).toBeInTheDocument();
  });

  it("subscribes and registers the subscription with the server when turned on", async () => {
    const { subscribeMock, requestPermissionMock } = stubPushEnvironment({ existingSubscription: null });
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === "/api/push/vapid-public-key") {
        return { ok: true, json: async () => ({ publicKey: "qUFTF3lXxouxuo_n0kPvwpMn2Ehl3W51M8Aw3vap5QQ" }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<NotificationToggle session={session} />);
    await user.click(await screen.findByRole("button", { name: /turn on notifications/i }));

    await waitFor(() => expect(subscribeMock).toHaveBeenCalled());
    expect(requestPermissionMock).toHaveBeenCalled();

    const postCall = fetchMock.mock.calls.find((c) => c[0] === "/api/push-subscriptions");
    expect(postCall).toBeDefined();
    const sent = JSON.parse(postCall![1].body);
    expect(sent.endpoint).toBe("https://push.example.com/new-device");
    expect(sent.keys).toEqual({ p256dh: "p256dh-value", auth: "auth-value" });

    expect(await screen.findByRole("button", { name: /turn off notifications/i })).toBeInTheDocument();
  });

  it("shows a friendly error instead of crashing when permission is denied", async () => {
    stubPushEnvironment({ existingSubscription: null, permission: "denied" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    const user = userEvent.setup();
    render(<NotificationToggle session={session} />);
    await user.click(await screen.findByRole("button", { name: /turn on notifications/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission was not granted/i);
    // Still offering to turn on -- the state didn't silently flip.
    expect(screen.getByRole("button", { name: /turn on notifications/i })).toBeInTheDocument();
  });

  it("unsubscribes and tells the server when turned off", async () => {
    const unsubscribeMock = vi.fn().mockResolvedValue(true);
    stubPushEnvironment({
      existingSubscription: { endpoint: "https://push.example.com/old-device", unsubscribe: unsubscribeMock },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<NotificationToggle session={session} />);
    await user.click(await screen.findByRole("button", { name: /turn off notifications/i }));

    await waitFor(() => expect(unsubscribeMock).toHaveBeenCalled());
    const deleteCall = fetchMock.mock.calls.find((c) => c[1]?.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(JSON.parse(deleteCall![1].body).endpoint).toBe("https://push.example.com/old-device");
  });
});
