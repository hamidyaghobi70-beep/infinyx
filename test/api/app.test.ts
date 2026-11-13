import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/api/app.js";

describe("HTTP foundation", () => {
  it("serves the INFINYX landing page", async () => {
    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.text).toContain("A universe of");
    expect(response.text).toContain("Project status");
  });

  it("serves the responsive site stylesheet", async () => {
    const response = await request(app).get("/styles.css");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/css");
    expect(response.text).toContain("@media(max-width:620px)");
  });

  it.each([
    { path: "/site.js", contentType: "javascript", marker: "aria-expanded" },
    { path: "/favicon.svg", contentType: "image/svg+xml", marker: "<svg" }
  ])("serves the static asset $path", async ({ path, contentType, marker }) => {
    const response = await request(app).get(path);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain(contentType);
    const body = response.text ?? response.body.toString("utf8");
    expect(body).toContain(marker);
  });

  it("sets baseline browser security headers", async () => {
    const response = await request(app).get("/");

    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(response.headers["permissions-policy"]).toContain("camera=()");
  });

  it("returns a minimal liveness response", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const response = await request(app).get("/not-a-route");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found" });
  });
});
