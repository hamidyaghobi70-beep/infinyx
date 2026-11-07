import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/api/app.js";

describe("HTTP foundation", () => {
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
