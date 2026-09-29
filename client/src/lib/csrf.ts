/**
 * Client-Side CSRF Protection Helper
 * Manages synchronizer tokens and double-submit cookies for legitimate same-origin requests.
 */

export const CSRF_COOKIE_NAME = "pns_csrf";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

let cachedToken: string | null = null;
let tokenFetchPromise: Promise<string | null> | null = null;

/**
 * Reads the CSRF token directly from the document.cookie.
 */
export function getCsrfTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Fetches an authoritative CSRF token from the server.
 */
export async function fetchCsrfToken(): Promise<string | null> {
  if (tokenFetchPromise) {
    return tokenFetchPromise;
  }

  tokenFetchPromise = (async () => {
    try {
      const res = await fetch("/api/csrf-token", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        if (data?.csrfToken && typeof data.csrfToken === "string") {
          cachedToken = data.csrfToken;
          return data.csrfToken;
        }
      }
    } catch {
      // Ignore network errors during background token fetch
    } finally {
      tokenFetchPromise = null;
    }

    const cookieToken = getCsrfTokenFromCookie();
    if (cookieToken) {
      cachedToken = cookieToken;
    }
    return cachedToken;
  })();

  return tokenFetchPromise;
}

/**
 * Returns the currently available CSRF token.
 */
export function getCsrfToken(): string | null {
  return cachedToken || getCsrfTokenFromCookie();
}

/**
 * Updates the cached CSRF token.
 */
export function setCachedCsrfToken(token: string | null) {
  cachedToken = token;
}

/**
 * Global fetch interceptor ensuring all state-changing same-origin requests
 * automatically carry the CSRF token without breaking component code.
 */
export function initCsrfFetchInterceptor() {
  if (typeof window === "undefined" || (window as any).__pns_csrf_initialized) {
    return;
  }
  (window as any).__pns_csrf_initialized = true;

  const originalFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let method = "GET";
    if (init && init.method) {
      method = init.method.toUpperCase();
    } else if (typeof input === "object" && "method" in input && (input as Request).method) {
      method = (input as Request).method.toUpperCase();
    }

    const isStateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

    if (isStateChanging) {
      let token = getCsrfToken();
      if (!token) {
        token = await fetchCsrfToken();
      }

      if (token) {
        init = init || {};
        const headers = new Headers(
          init.headers ||
            (typeof input === "object" && "headers" in input
              ? (input as Request).headers
              : {})
        );

        if (!headers.has("X-CSRF-Token") && !headers.has("x-csrf-token")) {
          headers.set("X-CSRF-Token", token);
        }
        init.headers = headers;

        // Ensure session cookies are sent
        if (!init.credentials) {
          init.credentials = "include";
        }
      }
    }

    return originalFetch(input, init);
  };

  // Pre-fetch token on client application boot
  fetchCsrfToken().catch(() => {});
}
