import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "./auth";
import Layout from "./components/Layout";
import { Spinner } from "./components/ui";
import AuthPage from "./pages/AuthPage";
import EnvelopesPage from "./pages/EnvelopesPage";
import OutboxPage from "./pages/OutboxPage";
import ReviewPage from "./pages/ReviewPage";
import SignPage from "./pages/SignPage";
import StatusPage from "./pages/StatusPage";
import { matchPath, RouterProvider, useRouter } from "./router";

function Routes(): ReactNode {
  const { path } = useRouter();
  const { user, loading } = useAuth();

  // Public: signers open their link without an account.
  const sign = matchPath("/sign/:token", path);
  if (sign) return <SignPage key={sign.token} token={sign.token} />;

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Loading…" />
      </div>
    );
  if (!user) return <AuthPage mode={path === "/signup" ? "signup" : "signin"} />;

  if (path === "/" || path === "/signin" || path === "/signup") return <EnvelopesPage />;
  if (path === "/outbox") return <OutboxPage />;
  const status = matchPath("/envelopes/:id/status", path);
  if (status) return <StatusPage key={status.id} id={Number(status.id)} />;
  const review = matchPath("/envelopes/:id", path);
  if (review) return <ReviewPage key={review.id} id={Number(review.id)} />;
  return (
    <Layout>
      <p className="text-gray-600">Page not found.</p>
    </Layout>
  );
}

export default function App() {
  return (
    <RouterProvider>
      <AuthProvider>
        <Routes />
      </AuthProvider>
    </RouterProvider>
  );
}
