import { describe, expect, test } from "bun:test";
import {
  bindHostRefusal,
  generateToken,
  isLoopbackAddress,
  lanGate,
  pinnedTokenRefusal,
  TOKEN_COOKIE,
  urlHost,
} from "./lan";

const HOST = "192.168.0.10";
const TOKEN = "a".repeat(32);
const BASE = `http://${HOST}:4400`;

const upstream = (req: Request) => new Response(`ok ${req.method} ${new URL(req.url).pathname}`);
const gate = (allowWrites = false) =>
  lanGate(upstream, { bindHost: HOST, token: TOKEN, allowWrites });
const authed = (init: RequestInit = {}) => ({
  ...init,
  headers: { cookie: `other=1; ${TOKEN_COOKIE}=${TOKEN}` },
});

describe("bindHostRefusal", () => {
  test.each([
    "0.0.0.0",
    "::",
    "localhost",
    "example.com",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "010.0.0.1",
    "fe80::1",
  ])("refuses %s", (host) => {
    // @spec SERV-020 unit
    expect(bindHostRefusal(host)).not.toBeNull();
  });

  test.each([
    "127.0.0.1",
    "::1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.10",
    "100.64.0.1",
  ])("accepts %s", (host) => {
    // @spec SERV-020 unit
    expect(bindHostRefusal(host)).toBeNull();
  });
});

describe("address helpers", () => {
  test("loopback is 127/8 and ::1 only", () => {
    expect(isLoopbackAddress("127.0.0.2")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress(HOST)).toBe(false);
  });

  test("urlHost brackets IPv6", () => {
    expect(urlHost("::1", 80)).toBe("[::1]:80");
    expect(urlHost(HOST, 4400)).toBe(`${HOST}:4400`);
  });
});

describe("access tokens", () => {
  test("a generated token carries 256 random bits", () => {
    // @spec SERV-023 unit
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken()).not.toBe(token);
  });

  test("a pinned token must be cookie-safe and at least 16 characters", () => {
    // @spec SERV-023 unit
    expect(pinnedTokenRefusal("short")).not.toBeNull();
    expect(pinnedTokenRefusal(`${"x".repeat(16)};evil`)).not.toBeNull();
    expect(pinnedTokenRefusal("x".repeat(16))).toBeNull();
  });
});

describe("lanGate", () => {
  test("a request with no token or cookie is 401", async () => {
    // @spec SERV-021 unit
    expect((await gate()(new Request(`${BASE}/`))).status).toBe(401);
  });

  test("a wrong token, in the query or the cookie, is 401", async () => {
    // @spec SERV-021 unit
    expect((await gate()(new Request(`${BASE}/?token=nope`))).status).toBe(401);
    const badCookie = new Request(`${BASE}/`, { headers: { cookie: `${TOKEN_COOKIE}=nope` } });
    expect((await gate()(badCookie)).status).toBe(401);
  });

  test("the right query token is exchanged for a strict cookie and dropped from the URL", async () => {
    // @spec SERV-022 unit
    const res = await gate()(new Request(`${BASE}/requirements?all=1&token=${TOKEN}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/requirements?all=1");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${TOKEN_COOKIE}=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("the right cookie reaches the app", async () => {
    // @spec SERV-021 unit
    const res = await gate()(new Request(`${BASE}/api/coverage`, authed()));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok GET /api/coverage");
  });

  test("a Host other than loopback or the bound address is 403, token or not", async () => {
    // @spec SERV-024 unit
    const res = await gate()(new Request("http://evil.example:4400/", authed()));
    expect(res.status).toBe(403);
  });

  test("the bound address and loopback names pass the Host pin", async () => {
    // @spec SERV-024 unit
    expect((await gate()(new Request(`${BASE}/`, authed()))).status).toBe(200);
    expect((await gate()(new Request("http://localhost:4400/", authed()))).status).toBe(200);
  });

  test("writes are 403 without --allow-writes", async () => {
    // @spec SERV-025 unit
    const post = new Request(`${BASE}/editor/create`, authed({ method: "POST" }));
    expect((await gate()(post)).status).toBe(403);
    const resolve = new Request(`${BASE}/api/provenance?resolve=1`, authed());
    expect((await gate()(resolve)).status).toBe(403);
    expect((await gate()(new Request(`${BASE}/provenance`, authed()))).status).toBe(403);
  });

  test("writes pass with --allow-writes", async () => {
    // @spec SERV-025 unit
    const post = new Request(`${BASE}/editor/create`, authed({ method: "POST" }));
    expect((await gate(true)(post)).status).toBe(200);
  });
});
