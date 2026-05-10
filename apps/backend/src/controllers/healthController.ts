import type { RequestHandler } from "express";
import type { HealthResponse } from "@sarjy/shared-types";

export const getHealth: RequestHandler = (_req, res) => {
  const payload: HealthResponse = {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
  res.status(200).json(payload);
};
