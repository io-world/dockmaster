import type { ReactNode } from "react";
import type { EnvelopeStatus } from "../api";

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-gray-600">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function ErrorBox({ message, problems, onRetry }: { message: string; problems?: string[]; onRetry?: () => void }) {
  return (
    <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p>{message}</p>
      {problems && problems.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button className="mt-2 underline" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

const STATUS_STYLE: Record<EnvelopeStatus, string> = {
  draft: "bg-amber-100 text-amber-800",
  sent: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
};

export function StatusBadge({ status }: { status: EnvelopeStatus }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{status}</span>;
}

export function Button({
  children,
  onClick,
  disabled,
  kind = "primary",
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  title?: string;
}) {
  const styles = {
    primary: "bg-blue-600 text-white hover:bg-blue-700",
    secondary: "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50",
    danger: "bg-red-600 text-white hover:bg-red-700",
  }[kind];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ConfirmDialog({
  text,
  confirm,
  onConfirm,
  onCancel,
  danger = false,
  busy = false,
}: {
  text: ReactNode;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-96 space-y-3 rounded bg-white p-4 shadow-xl" role="dialog">
        <div className="text-sm">{text}</div>
        <div className="flex justify-end gap-2">
          <button className="rounded border px-3 py-1.5 text-sm" onClick={onCancel} disabled={busy}>
            Go back
          </button>
          <button
            className={`rounded px-3 py-1.5 text-sm text-white disabled:opacity-50 ${danger ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
