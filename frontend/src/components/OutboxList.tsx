import type { OutboxEntry } from "../api";
import { Link } from "../router";
import { formatDate } from "./ui";

const EVENT: Record<OutboxEntry["event"], { label: string; cls: string }> = {
  sent: { label: "sent", cls: "bg-gray-100 text-gray-700" },
  your_turn: { label: "your turn", cls: "bg-blue-100 text-blue-800" },
  signed: { label: "signed", cls: "bg-green-100 text-green-800" },
  completed: { label: "completed", cls: "bg-green-600 text-white" },
};

export default function OutboxList({ entries }: { entries: OutboxEntry[] }) {
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
            {o.link &&
              (isSign ? (
                // A new tab, so the tester can act as each recipient and come back to the outbox.
                <a
                  href={o.link}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="sign-link"
                  className="inline-block rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
                >
                  {o.event === "completed" ? "Open (download signed PDF) ↗" : "Open signing page as this recipient ↗"}
                </a>
              ) : (
                <Link to={o.link} className="inline-block text-xs text-blue-700 underline">
                  Open envelope
                </Link>
              ))}
          </li>
        );
      })}
    </ul>
  );
}
