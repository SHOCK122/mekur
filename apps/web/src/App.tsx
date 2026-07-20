import { useEffect, useState } from "react";

type ApiStatus = "checking" | "online" | "offline";

async function checkApiHealth(): Promise<ApiStatus> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return "offline";
    const body: unknown = await response.json();
    return body && typeof body === "object" && (body as { status?: string }).status === "ok"
      ? "online"
      : "offline";
  } catch {
    return "offline";
  }
}

export function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    checkApiHealth().then((status) => {
      if (!cancelled) setApiStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Schedule App</h1>
      <p>Open-source, end-to-end encrypted scheduling.</p>
      <p data-testid="api-status">
        API status: {apiStatus === "checking" ? "checking\u2026" : apiStatus}
      </p>
    </main>
  );
}
