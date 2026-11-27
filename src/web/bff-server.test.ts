import { afterEach, describe, expect, it } from "vitest";
import { createBffHttpServer, type BffRouteHandlers } from "./bff-server.js";
import type { Server } from "node:http";

const servers: Server[] = [];

async function request(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string
) {
  const handlers: BffRouteHandlers = {
    startLogin: (_req, res) => { res.statusCode = 302; res.setHeader("Location", "https://idp.example.test/authorize"); res.end(); },
    handleCallback: (_req, res) => { res.statusCode = 204; res.end(); },
    getSession: (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ authenticated: false })); },
    logout: (_req, res) => { res.statusCode = 204; res.end(); }
  };
  const server = createBffHttpServer(handlers);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    redirect: "manual"
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  ));
});

describe("Node BFF HTTP transport", () => {
  it("routes login and applies no-store security headers", async () => {
    const response = await request("/auth/login");
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("routes session and callback endpoints", async () => {
    const session = await request("/api/session");
    expect(await session.json()).toEqual({ authenticated: false });
    const callback = await request("/auth/callback");
    expect(callback.status).toBe(204);
  });

  it("rejects unknown paths and unsupported methods", async () => {
    expect((await request("/unknown")).status).toBe(404);
    const wrongMethod = await request("/auth/login", "POST");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
  });

  it("rejects logout request bodies", async () => {
    const response = await request("/auth/logout", "POST", {}, "x");
    expect(response.status).toBe(400);
  });
});
