// packages/shared/src/net.ts
//
// Runtime-free network predicates shared by every write surface (engine
// `/api/*` and webapp `/editor/*`). Kept in @spec-engine/shared so the two
// packages enforce ONE contract — a rebinding hole patched in one surface but
// not the other would be worse than none.

export const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * Loopback names every server answers on. Bun's in-process
 * `app.request(path)` forward synthesizes `http://localhost/…`, so a forward
 * always carries one of these. `URL.hostname` returns the bracketed form for
 * IPv6, so both `::1` and `[::1]` are listed.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * `hostname` is a `URL.hostname` (port already stripped). The Origin/Host
 * same-origin check cannot replace this: a rebinding page's Origin and Host
 * agree.
 *
 * @spec SERV-024
 */
export function isServedHostname(hostname: string, bindHost: string = DEFAULT_BIND_HOST): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname === bindHost;
}
