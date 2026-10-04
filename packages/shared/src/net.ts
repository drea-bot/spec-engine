// packages/shared/src/net.ts
//
// Runtime-free network predicates shared by every write surface (engine
// `/api/*` and webapp `/editor/*`). Kept in @spec-engine/shared so the two
// packages enforce ONE contract — a rebinding hole patched in one surface but
// not the other would be worse than none.

/** The address `spec serve` binds when no --host is given. */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * Loopback names every server answers on. Bun's in-process
 * `app.request(path)` forward synthesizes `http://localhost/…`, so a forward
 * always carries one of these. `URL.hostname` returns the bracketed form for
 * IPv6, so both `::1` and `[::1]` are listed.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * True when `hostname` (a `URL.hostname`, port already stripped) is a name the
 * server bound to `bindHost` may answer on: a loopback name or `bindHost`
 * itself. Anything else is a DNS-rebinding attack — an attacker page whose
 * domain resolves to the bound address arrives carrying `Host: evil.example`.
 * Write routes require this in ADDITION to the Origin/Host same-origin check,
 * which compares two attacker-influenceable headers against each other and so
 * cannot catch a rebind where both agree.
 *
 * @spec SERV-024
 */
export function isServedHostname(hostname: string, bindHost: string = DEFAULT_BIND_HOST): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname === bindHost;
}
