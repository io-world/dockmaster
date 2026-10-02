// Minimal history-API router (avoids adding a routing library). Routes are matched in App.tsx.
import { createContext, useCallback, useContext, useEffect, useState, type MouseEvent, type ReactNode } from "react";

const RouterContext = createContext<{ path: string; navigate: (to: string, replace?: boolean) => void }>({
  path: "/",
  navigate: () => {},
});

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string, replace = false) => {
    if (replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    setPath(new URL(to, window.location.origin).pathname);
    window.scrollTo(0, 0);
  }, []);
  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

export const useRouter = () => useContext(RouterContext);

/** Match "/envelopes/:id" against a path; returns params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const a = path.split("/").filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const { navigate } = useRouter();
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open new tabs
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
