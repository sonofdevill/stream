/**
 * Central URL configuration for REST API and Socket.io.
 *
 * REST  → https://stream.irjavid.org:2053/api   (Caddy strips /api → backend)
 * Socket → https://stream.irjavid.org:2053        (root — avoids /api/socket.io conflicts)
 *
 * RESOLUTION ORDER (both functions) — do not reorder, later steps exist
 * specifically to survive misconfiguration of the earlier ones:
 *   1. Explicit NEXT_PUBLIC_* env var — highest priority, set per environment
 *      (see .env.example). If this is set but missing a custom port, THIS is
 *      the value that ships — no fallback below can override it. Keep it in
 *      sync with the Caddyfile's listen address.
 *   2. Browser-derived from `window.location.origin` — the page was loaded
 *      through Caddy, so its own origin already has the correct host *and*
 *      port. This is what protects against port drift (e.g. :2053 changing
 *      again later) without needing a code change.
 *   3. Hardcoded PRODUCTION_ORIGIN — last-resort fallback for SSR / build
 *      time only, where `window` doesn't exist yet. Keep in sync with the
 *      Caddyfile manually since it can't be derived dynamically here.
 */

const PRODUCTION_ORIGIN = "https://stream.irjavid.org:2053";
const PRODUCTION_API_BASE = `${PRODUCTION_ORIGIN}/api`;

/** Strips a trailing slash and, if present, a trailing /api segment. */
function stripToOrigin(url: string): string {
  return url.replace(/\/api\/?$/, "").replace(/\/$/, "");
}

/** Axios base URL — must include the /api prefix when behind Caddy. */
export function getApiBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  // Browser fallback: reuse the origin the page actually loaded from.
  // Preserves whatever host+port Caddy is really serving on — including
  // custom ports — without hardcoding it twice.
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api`;
  }

  return PRODUCTION_API_BASE;
}

/**
 * Socket.io server origin — always the site root, never /api.
 * NEXT_PUBLIC_SOCKET_URL takes precedence; otherwise derived from API URL,
 * then from the browser's own origin, then the hardcoded production default.
 */
export function getSocketUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SOCKET_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (apiUrl) {
    return stripToOrigin(apiUrl);
  }

  // Browser fallback: derive from the page's own origin so the socket
  // always targets the same host+port the dashboard/overlay was loaded
  // from. This is what keeps a custom port (e.g. :2053) from silently
  // being dropped if env vars are ever left unset.
  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return PRODUCTION_ORIGIN;
}
