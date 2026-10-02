// Ask questions about the document. History lives only in this component (cleared on reload, by design).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, type ChatMessage } from "../api";

/** Inline formatting the model uses: **bold** and page references "(p. 3)" / "(pp. 2–3)" (the latter become links). */
function inline(text: string, onPage: (n: number) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\((pp?\.)\s*(\d+)(?:\s*[–-]\s*(\d+))?\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={out.length}>{m[1]}</strong>);
    else {
      const n = Number(m[3]);
      out.push(
        <button key={out.length} onClick={() => onPage(n)} className="text-blue-700 underline" title={`Show page ${n}`} data-testid="page-ref">
          ({m[2]} {m[3]}
          {m[4] ? `–${m[4]}` : ""})
        </button>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Paragraphs and "- " bullet lists. */
function Answer({ text, onPage }: { text: string; onPage: (n: number) => void }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length)
      blocks.push(
        <ul key={blocks.length} className="list-disc space-y-0.5 pl-5">
          {bullets.map((b, i) => (
            <li key={i}>{inline(b, onPage)}</li>
          ))}
        </ul>,
      );
    bullets = [];
  };
  for (const line of text.split("\n")) {
    const b = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (b) bullets.push(b[1]);
    else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ""), onPage)}</p>);
    }
  }
  flush();
  return <div className="space-y-1">{blocks}</div>;
}

export default function DocChat({
  ask,
  starters,
  onPage,
  placeholder = "Ask a question about this document…",
}: {
  ask: (question: string, history: ChatMessage[]) => Promise<{ answer: string }>;
  starters: string[];
  onPage: (n: number) => void;
  placeholder?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; question: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setError(null);
    setInput("");
    const history = messages;
    setMessages([...history, { role: "user", content: question }]);
    setBusy(true);
    try {
      const r = await ask(question, history);
      setMessages((m) => [...m, { role: "assistant", content: r.answer }]);
    } catch (e) {
      setMessages(history); // drop the unanswered question; it's offered again via Retry
      setError({ message: e instanceof ApiError ? e.message : "Couldn't get an answer. Please try again.", question });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="doc-chat">
      {messages.length > 0 && (
        <div ref={listRef} className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ml-auto w-fit max-w-[85%] rounded-lg bg-blue-600 px-3 py-1.5 text-white">
                {m.content}
              </div>
            ) : (
              <div key={i} data-testid="chat-answer" className="max-w-[95%] rounded-lg border bg-white px-3 py-2 text-gray-800">
                <Answer text={m.content} onPage={onPage} />
              </div>
            ),
          )}
          {busy && <div className="w-fit rounded-lg border bg-white px-3 py-1.5 text-gray-500">Thinking…</div>}
        </div>
      )}
      {messages.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {starters.map((s) => (
            <button
              key={s}
              data-testid="chat-starter"
              disabled={busy}
              onClick={() => send(s)}
              className="rounded-full border border-blue-200 bg-white px-2.5 py-1 text-xs text-blue-800 hover:bg-blue-50 disabled:opacity-50"
            >
              {s}
            </button>
          ))}
          {busy && <span className="text-xs text-gray-500">Thinking…</span>}
        </div>
      )}
      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">
          {error.message}{" "}
          <button className="underline" onClick={() => send(error.question)}>
            Retry
          </button>
        </div>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          data-testid="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={1}
          maxLength={1000}
          disabled={busy}
          placeholder={placeholder}
          className="min-h-[34px] flex-1 resize-none rounded border px-2 py-1.5 text-sm disabled:bg-gray-50"
        />
        <button
          type="submit"
          data-testid="chat-send"
          disabled={busy || !input.trim()}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          Ask
        </button>
      </form>
      <p className="text-[11px] text-gray-500">Answers come from this document only. Not legal advice.</p>
    </div>
  );
}
