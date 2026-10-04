// packages/engine/src/server/lan.ts
//
// The gate wraps Bun.serve's fetch, not the Hono app: the webapp's in-process
// `app.request` reads of its own /api/* must not need the token.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { isServedHostname } from "@spec-engine/shared";

export const TOKEN_COOKIE = "spec_token";
const MIN_PINNED_TOKEN_LENGTH = 16;

type Fetch = (req: Request) => Response | Promise<Response>;

export interface LanGateOptions {
  bindHost: string;
  token: string;
  allowWrites: boolean;
}

function ipv4Prefix(ip: string): [number, number] | null {
  const parts = ip.split(".");
  // Reject "010"-style octets: some resolvers read them as octal.
  if (parts.length !== 4 || parts.some((p) => String(Number(p)) !== p)) return null;
  return [Number(parts[0]), Number(parts[1])];
}

export function isLoopbackAddress(ip: string): boolean {
  if (ip === "::1") return true;
  return ipv4Prefix(ip)?.[0] === 127;
}

function isPrivateIPv4([a, b]: [number, number]): boolean {
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Null when `raw` may be bound, otherwise the refusal message.
 *
 * @spec SERV-020
 */
export function bindHostRefusal(raw: string): string | null {
  const kind = isIP(raw);
  if (kind === 0) return `--host must be a literal IP address, not "${raw}"`;
  if (kind === 6) {
    return raw === "::1" ? null : `--host ${raw}: the only IPv6 address accepted is ::1`;
  }
  const prefix = ipv4Prefix(raw);
  if (prefix === null || !isPrivateIPv4(prefix)) {
    return `--host ${raw} is not a loopback, RFC 1918, or 100.64.0.0/10 address`;
  }
  return null;
}

export function urlHost(ip: string, port: number): string {
  return `${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`;
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Null when a pinned token is usable, otherwise the refusal message. */
export function pinnedTokenRefusal(token: string): string | null {
  // The token travels verbatim in a cookie and a query string.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return "the access token may only contain A-Z a-z 0-9 _ -";
  if (token.length < MIN_PINNED_TOKEN_LENGTH) {
    return `the access token must be at least ${MIN_PINNED_TOKEN_LENGTH} characters`;
  }
  return null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokenMatches(candidate: string | null | undefined, token: string): boolean {
  if (!candidate) return false;
  // timingSafeEqual throws on unequal lengths; hashing equalizes them.
  return timingSafeEqual(digest(candidate), digest(token));
}

function cookieValue(header: string | null, name: string): string | null {
  for (const pair of (header ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq !== -1 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

function isWrite(req: Request, url: URL): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return true;
  // The provenance page resolves issues through the tracker, which writes the sidecar.
  if (url.pathname === "/provenance") return true;
  return url.pathname === "/api/provenance" && url.searchParams.has("resolve");
}

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/**
 * @spec SERV-021
 * @spec SERV-022
 * @spec SERV-024
 * @spec SERV-025
 */
export function lanGate(fetch: Fetch, { bindHost, token, allowWrites }: LanGateOptions): Fetch {
  return (req) => {
    const url = new URL(req.url);
    if (!isServedHostname(url.hostname, bindHost)) return plain(403, "host rejected");

    const queryToken = url.searchParams.get("token");
    if (queryToken !== null) {
      if (!tokenMatches(queryToken, token)) return plain(401, "invalid access token");
      url.searchParams.delete("token");
      return plain(302, "authenticated", {
        location: `${url.pathname}${url.search}`,
        "set-cookie": `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
      });
    }
    if (!tokenMatches(cookieValue(req.headers.get("cookie"), TOKEN_COOKIE), token)) {
      return plain(401, "access token required: open the tokenized URL spec serve printed");
    }

    if (!allowWrites && isWrite(req, url)) {
      return plain(403, "read-only: restart spec serve with --allow-writes to permit changes");
    }
    return fetch(req);
  };
}
