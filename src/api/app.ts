import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { errorHandler } from "../shared/http/error-handler.js";

export const app = express();
const publicDirectory = fileURLToPath(new URL("../../public", import.meta.url));

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

// Static product shell only; this does not add authentication or business APIs.
app.use(express.static(resolve(publicDirectory), {
  index: "index.html",
  fallthrough: true,
  etag: true,
  maxAge: "1h"
}));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(errorHandler);
