import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, Link } from "@tanstack/react-router";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <nav style={{ marginBottom: 24, display: "flex", gap: 16 }}>
        <Link to="/">home</Link>
        <Link to="/checkout">checkout</Link>
      </nav>
      <Outlet />
    </div>
  );
}
