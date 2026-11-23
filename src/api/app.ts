import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import { errorHandler } from "../shared/http/error-handler.js";

export type ReadinessCheck = () => boolean;

/** Build an HTTP app whose readiness signal is tied to the owning runtime state. */
export function createApp(isReady: ReadinessCheck = () => false): Express {
  const application = express();

  application.disable("x-powered-by");
  application.use(express.json({ limit: "100kb" }));
  application.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false
  }));

  // Liveness only: confirms that the HTTP process can answer requests.
  application.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Readiness reflects Core lifecycle, not downstream dependency health.
  application.get("/ready", (_req, res) => {
    if (!isReady()) {
      res.status(503).json({ status: "not_ready" });
      return;
    }
    res.status(200).json({ status: "ready" });
  });

  application.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  application.use(errorHandler);
  return application;
}

// Compatibility app for isolated HTTP tests; production composition supplies Core state.
export const app = createApp();
