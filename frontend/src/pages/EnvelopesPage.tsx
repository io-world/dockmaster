import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, ApiError, type EnvelopeSummary } from "../api";
import Layout from "../components/Layout";
import { Button, ConfirmDialog, ErrorBox, formatDate, Spinner, StatusBadge } from "../components/ui";
import { useRouter } from "../router";

// The pipeline runs synchronously (10–30s). The server sends no progress events, so the message
// follows elapsed time through the stages the backend actually runs, in order.
const STAGES: [number, string][] = [
  [0, "Uploading…"],
  [2, "Reading the document and finding blanks…"],
  [6, "Finding signers and fields with AI…"],
  [25, "Still working. Long documents take a little longer…"],
];

function UploadZone({ onUploaded }: { onUploaded: (id: number) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [hover, setHover] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - start) / 1000), 500);
    return () => clearInterval(t);
  }, [busy]);

  const upload = async (file: File | undefined) => {
    if (!file || busy) return; // no double submit
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please choose a PDF file.");
      return;
    }
    setError(null);
    setElapsed(0);
    setBusy(true);
    try {
      const env = await api.uploadEnvelope(file);
      onUploaded(env.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setHover(false);
    upload(e.dataTransfer.files[0]);
  };

  const stage = [...STAGES].reverse().find(([t]) => elapsed >= t)![1];

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-3 rounded border-2 border-dashed p-6 text-center ${
          hover ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-white"
        }`}
      >
        {busy ? (
          <div className="flex flex-col items-center gap-1">
            <Spinner label={stage} />
            <span className="text-xs text-gray-500">{Math.floor(elapsed)}s</span>
          </div>
        ) : (
          <>
            <Button onClick={() => input.current?.click()}>Upload new PDF</Button>
            <span className="text-sm text-gray-500">or drag and drop a PDF here</span>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => upload(e.target.files?.[0])}
        />
      </div>
      {error && <ErrorBox message={error} />}
    </div>
  );
}

export default function EnvelopesPage() {
  const { navigate } = useRouter();
  const [envelopes, setEnvelopes] = useState<EnvelopeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<EnvelopeSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .listEnvelopes()
      .then(setEnvelopes)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load your inbox."));
  }, []);

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteEnvelope(toDelete.id);
      setEnvelopes((list) => list?.filter((e) => e.id !== toDelete.id) ?? null);
      setToDelete(null);
    } catch (e) {
      setDeleteError(e instanceof ApiError ? e.message : "Couldn't delete. Please try again.");
      setToDelete(null);
    } finally {
      setDeleting(false);
    }
  };
  useEffect(load, [load]);

  const open = (e: EnvelopeSummary) => navigate(e.status === "draft" ? `/envelopes/${e.id}` : `/envelopes/${e.id}/status`);

  return (
    <Layout>
      <div className="space-y-6">
        <UploadZone onUploaded={(id) => navigate(`/envelopes/${id}`)} />

        {error && <ErrorBox message={error} onRetry={load} />}
        {!envelopes && !error && <Spinner label="Loading your inbox…" />}
        {deleteError && <ErrorBox message={deleteError} />}

        {envelopes && envelopes.length === 0 && (
          <p className="text-center text-gray-600">
            No envelopes yet. Upload a PDF: AI finds who needs to sign and where, you check it, then send it for signature.
          </p>
        )}

        {envelopes && envelopes.length > 0 && (
          <table className="w-full overflow-hidden rounded border bg-white text-sm">
            <thead className="bg-gray-50 text-left text-gray-600">
              <tr>
                <th className="px-3 py-2 font-medium">Document</th>
                <th className="px-3 py-2 font-medium">Uploaded</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Signers</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {envelopes.map((e) => (
                <tr key={e.id} onClick={() => open(e)} className="cursor-pointer border-t hover:bg-blue-50">
                  <td className="px-3 py-2 font-medium">{e.filename}</td>
                  <td className="px-3 py-2 text-gray-600">{formatDate(e.created_at)}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {e.status === "draft"
                      ? `${e.signer_count} signer${e.signer_count === 1 ? "" : "s"} proposed`
                      : `${e.signed_count} of ${e.signer_count} signed`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      data-testid="delete-envelope"
                      onClick={(ev) => {
                        ev.stopPropagation(); // don't open the envelope
                        setToDelete(e);
                      }}
                      className="rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                      title="Delete this PDF"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {toDelete && (
        <ConfirmDialog
          danger
          busy={deleting}
          confirm={deleting ? "Deleting…" : "Delete"}
          onCancel={() => setToDelete(null)}
          onConfirm={confirmDelete}
          text={
            <>
              <p>
                Delete <b>{toDelete.filename}</b>? The PDF, its fields and its notifications are removed. This can't be undone.
              </p>
              {toDelete.status !== "draft" && (
                <p className="mt-2 text-red-700">
                  This document has been sent: its signing links will stop working
                  {toDelete.status === "completed" ? ", and the signed PDF will no longer be downloadable" : ""}.
                </p>
              )}
            </>
          }
        />
      )}
    </Layout>
  );
}
