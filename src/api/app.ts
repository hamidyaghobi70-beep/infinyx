import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import { errorHandler } from "../shared/http/error-handler.js";
import type { RequestHandler } from "express";
import { getAuthenticatedPrincipal } from "../core/authenticated-principal.js";

export type ReadinessCheck = () => boolean;

/** Build an HTTP app whose readiness signal is tied to the owning runtime state. */
export function createApp(isReady: ReadinessCheck = () => false, authenticate?: RequestHandler): Express {
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

  // Authenticated identity introspection is mounted only when a trusted verifier is configured.\n  if (authenticate) {\n    application.get("/v1/identity", authenticate, (request, response) => {\n      const principal = getAuthenticatedPrincipal(request);\n      if (!principal) { response.status(401).json({ error: "unauthorized" }); return; }\n      response.status(200).json({ subject: principal.subject, tenantId: principal.tenantId, issuer: principal.issuer, audience: principal.audience, expiresAt: principal.expiresAt });\n    });\n  }\n\n  // Readiness reflects Core lifecycle, not downstream dependency health.
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
