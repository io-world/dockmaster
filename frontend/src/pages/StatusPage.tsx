import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type EnvelopeStatusView, type StatusSigner } from "../api";
import Layout from "../components/Layout";
import OutboxList from "../components/OutboxList";
import { ErrorBox, formatDate, Spinner, StatusBadge } from "../components/ui";
import { Link, useRouter } from "../router";

function signerState(s: StatusSigner) {
  if (s.status === "signed") return <span className="text-green-700">Signed {formatDate(s.signed_at)}</span>;
  if (s.status === "notified") return <span className="text-amber-700">Waiting for signature (link sent)</span>;
  return <span className="text-gray-600">Waiting for earlier signers</span>;
}

export default function StatusPage({ id }: { id: number }) {
  const { navigate } = useRouter();
  const [st, setSt] = useState<EnvelopeStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getStatus(id)
      .then((s) => {
        if (s.status === "draft") navigate(`/envelopes/${id}`, true);
        else {
          setSt(s);
          setError(null);
        }
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load this envelope."));
  }, [id, navigate]);

  useEffect(load, [load]);
  // Keep the page current while signers are working (cheap JSON poll; stops once completed).
  useEffect(() => {
    if (st?.status === "completed") return;
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [st?.status, load]);

  if (error && !st)
    return (
      <Layout>
        <ErrorBox message={error} onRetry={load} />
      </Layout>
    );
  if (!st)
    return (
      <Layout>
        <Spinner label="Loading…" />
      </Layout>
    );

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/" className="text-sm text-blue-700 underline">
            ← Inbox
          </Link>
          <h1 className="text-lg font-semibold">{st.filename}</h1>
          <StatusBadge status={st.status} />
          <span className="text-sm text-gray-600">
            {st.signed_count} of {st.signer_count} signed
          </span>
          {st.final_pdf_url && (
            <a href={st.final_pdf_url} className="ml-auto rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white" data-testid="download">
              Download signed PDF
            </a>
          )}
        </div>
        {error && <ErrorBox message={`Couldn't refresh: ${error}`} />}

        <section>
          <h2 className="mb-2 font-medium">Signers</h2>
          <table className="w-full rounded border bg-white text-sm" data-testid="signers">
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-3 py-2 font-medium">Signer</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {st.signers.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      {s.name}
                      {s.is_self && <span className="ml-1 text-xs text-gray-500">(you)</span>}
                    </div>
                    <div className="text-xs text-gray-500">{s.role || s.label}</div>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{s.email}</td>
                  <td className="px-3 py-2">{signerState(s)}</td>
                  <td className="px-3 py-2 text-right">
                    {s.sign_url && (
                      <Link to={s.sign_url} className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white">
                        Sign now
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h2 className="mb-2 font-medium">Notifications for this envelope</h2>
          {st.outbox.length === 0 ? <p className="text-sm text-gray-600">None yet.</p> : <OutboxList entries={[...st.outbox].reverse()} onChanged={load} />}
        </section>
      </div>
    </Layout>
  );
}
