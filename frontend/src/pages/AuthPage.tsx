import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Button, ErrorBox } from "../components/ui";
import { Link, useRouter } from "../router";

export default function AuthPage({ mode }: { mode: "signin" | "signup" }) {
  const { setUser } = useAuth();
  const { navigate } = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = mode === "signup" ? await api.signup(email, password) : await api.login(email, password);
      setUser(user);
      if (window.location.pathname === "/signup" || window.location.pathname === "/signin") navigate("/", true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded border bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">DockMaster</h1>
          <p className="text-sm text-gray-600">
            Upload a PDF; AI proposes who signs and where. You check it and send.
          </p>
        </div>
        <h2 className="font-medium">{mode === "signup" ? "Create an account" : "Sign in"}</h2>
        {error && <ErrorBox message={error} />}
        <label className="block text-sm">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border px-2 py-1.5"
          />
        </label>
        <label className="block text-sm">
          Password {mode === "signup" && <span className="text-gray-500">(at least 8 characters)</span>}
          <input
            type="password"
            required
            minLength={mode === "signup" ? 8 : undefined}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border px-2 py-1.5"
          />
        </label>
        <Button type="submit" disabled={busy}>
          {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
        </Button>
        <p className="text-sm text-gray-600">
          {mode === "signup" ? (
            <>
              Already have an account? <Link to="/signin" className="text-blue-700 underline">Sign in</Link>
            </>
          ) : (
            <>
              New here? <Link to="/signup" className="text-blue-700 underline">Create an account</Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
