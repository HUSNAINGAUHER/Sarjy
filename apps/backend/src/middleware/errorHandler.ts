import type { ErrorRequestHandler } from "express";
import { logger } from "@/utils/logger";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error("Unhandled error", { message: err?.message, stack: err?.stack });
  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred.",
    },
  });
};
