import type { ReactNode } from "react";
import { useAuth } from "../auth";
import { Link, useRouter } from "../router";

export default function Layout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { user, logout } = useAuth();
  const { path, navigate } = useRouter();
  const nav = (to: string, label: string, active: boolean) => (
    <Link to={to} className={`rounded px-2 py-1 text-sm ${active ? "bg-gray-100 font-medium" : "text-gray-600 hover:text-gray-900"}`}>
      {label}
    </Link>
  );
  return (
    <div className="min-h-screen">
      <header className="border-b bg-white">
        <div className={`mx-auto flex h-12 items-center gap-4 px-4 ${wide ? "" : "max-w-5xl"}`}>
          <Link to="/" className="font-semibold">
            DockMaster
          </Link>
          {nav("/", "Envelopes", path === "/" || path.startsWith("/envelopes"))}
          {nav("/outbox", "Outbox", path === "/outbox")}
          <div className="ml-auto flex items-center gap-3 text-sm text-gray-600">
            <span>{user?.email}</span>
            <button
              className="underline"
              onClick={async () => {
                await logout();
                navigate("/", true);
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className={wide ? "" : "mx-auto max-w-5xl p-4"}>{children}</main>
    </div>
  );
}
