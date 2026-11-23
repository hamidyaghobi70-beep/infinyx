import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, createApp } from "../../src/api/app.js";

describe("HTTP foundation", () => {
  it("returns a minimal liveness response", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("reports not-ready until the Core lifecycle is running", async () => {
    let ready = false;
    const application = createApp(() => ready);

    const starting = await request(application).get("/ready");
    expect(starting.status).toBe(503);
    expect(starting.body).toEqual({ status: "not_ready" });

    ready = true;
    const running = await request(application).get("/ready");
    expect(running.status).toBe(200);
    expect(running.body).toEqual({ status: "ready" });

    ready = false;
    const stopping = await request(application).get("/ready");
    expect(stopping.status).toBe(503);
    expect(stopping.body).toEqual({ status: "not_ready" });
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const response = await request(app).get("/not-a-route");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found" });
  });
});
