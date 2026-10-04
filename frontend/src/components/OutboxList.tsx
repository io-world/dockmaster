import { useState } from "react";
import { api, ApiError, type OutboxEntry } from "../api";
import { Link } from "../router";
import { formatDate } from "./ui";

const EVENT: Record<OutboxEntry["event"], { label: string; cls: string }> = {
  sent: { label: "sent", cls: "bg-gray-100 text-gray-700" },
  your_turn: { label: "your turn", cls: "bg-blue-100 text-blue-800" },
  signed: { label: "signed", cls: "bg-green-100 text-green-800" },
  completed: { label: "completed", cls: "bg-green-600 text-white" },
};

/** Fix a recipient's email and/or send their link again. A changed email gets a new link (the old one stops working). */
function Resend({ entry, onDone }: { entry: OutboxEntry; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(entry.to);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <button data-testid="resend-open" onClick={() => setOpen(true)} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
        Edit email / Resend
      </button>
    );
  const changed = email.trim().toLowerCase() !== entry.to.toLowerCase();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resendLink(entry.id, email);
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't resend. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded bg-gray-50 p-2 text-xs" data-testid="resend-form">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-label="Recipient email"
        className="min-w-[14rem] flex-1 rounded border px-2 py-1 text-sm"
        autoFocus
      />
      <button data-testid="resend-submit" onClick={submit} disabled={busy} className="rounded bg-blue-600 px-2 py-1 font-medium text-white disabled:opacity-50">
        {busy ? "Sending…" : changed ? "Save & send new link" : "Resend"}
      </button>
      <button onClick={() => setOpen(false)} className="underline">
        Cancel
      </button>
      {changed && <span className="w-full text-gray-600">The old link stops working; the new address gets a fresh one.</span>}
      {error && <span className="w-full text-red-700">{error}</span>}
    </div>
  );
}

export default function OutboxList({ entries, onChanged }: { entries: OutboxEntry[]; onChanged?: () => void }) {
  return (
    <ul className="divide-y rounded border bg-white" data-testid="outbox">
      {entries.map((o) => {
        const isSign = o.link?.startsWith("/sign/");
        return (
          <li key={o.id} className="space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${EVENT[o.event].cls}`}>{EVENT[o.event].label}</span>
              <span className="text-gray-600">To:</span> <span className="font-medium">{o.to}</span>
              <span className="ml-auto text-xs text-gray-500">{formatDate(o.created_at)}</span>
            </div>
            <div className="font-medium">{o.subject}</div>
            <div className="text-gray-700">{o.body}</div>
            {o.link_replaced ? (
              <div className="text-xs text-gray-500">This link was replaced by a newer one (the email was changed).</div>
            ) : (
              o.link &&
              (isSign ? (
                <div className="flex flex-wrap items-center gap-2">
                  {/* A new tab, so the tester can act as each recipient and come back to the outbox. */}
                  <a
                    href={o.link}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="sign-link"
                    className="inline-block rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    {o.event === "completed" ? "Open (download signed PDF) ↗" : "Open signing page as this recipient ↗"}
                  </a>
                  {o.can_resend && onChanged && <Resend entry={o} onDone={onChanged} />}
                </div>
              ) : (
                <Link to={o.link} className="inline-block text-xs text-blue-700 underline">
                  Open envelope
                </Link>
              ))
            )}
          </li>
        );
      })}
    </ul>
  );
}
