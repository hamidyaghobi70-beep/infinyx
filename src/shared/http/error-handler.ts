import type { ErrorRequestHandler } from "express";
import { logger } from "../../core/logger.js";
import { HttpError } from "../errors/http-error.js";

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  logger.error({ err: error }, "Unhandled HTTP request error");
  res.status(500).json({ error: "Internal server error" });
};
