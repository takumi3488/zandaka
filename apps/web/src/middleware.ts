import type { StartMiddleware } from "@solidjs/vite-plugin";
import { createAPIHandler } from "filesystem-routing/api";
import routes from "virtual:file-routes";

const handleAPI = createAPIHandler(routes);

export default (async (event, next) => {
  const response = await handleAPI(event.request, next);
  const pathname = new URL(event.request.url).pathname;
  if (
    pathname !== "/admin" &&
    !pathname.startsWith("/admin/") &&
    !pathname.startsWith("/f/") &&
    !pathname.startsWith("/rpc") &&
    !pathname.startsWith("/api/funds/")
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex,nofollow");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}) satisfies StartMiddleware;
