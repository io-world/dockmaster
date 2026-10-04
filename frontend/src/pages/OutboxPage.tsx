import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type OutboxEntry } from "../api";
import Layout from "../components/Layout";
import OutboxList from "../components/OutboxList";
import { ErrorBox, Spinner } from "../components/ui";

export default function OutboxPage() {
  const [entries, setEntries] = useState<OutboxEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    api
      .outbox()
      .then(setEntries)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load the outbox."));
  }, []);
  useEffect(load, [load]);

  return (
    <Layout>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Outbox</h1>
          <button className="ml-auto text-sm underline" onClick={load}>
            Refresh
          </button>
        </div>
        <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          No real email is sent. Every notification appears here instead. Use the <b>blue buttons</b> to open a signing
          page as that recipient (each opens in a new tab), then come back here to follow the next step.
        </div>
        {error && <ErrorBox message={error} onRetry={load} />}
        {!entries && !error && <Spinner label="Loading…" />}
        {entries && entries.length === 0 && <p className="text-gray-600">Nothing yet. Notifications appear here when you send an envelope.</p>}
        {entries && entries.length > 0 && <OutboxList entries={entries} onChanged={load} />}
      </div>
    </Layout>
  );
}
