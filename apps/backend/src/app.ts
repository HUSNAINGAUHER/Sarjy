import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import routes from "@/routes";
import { errorHandler } from "@/middleware/errorHandler";
import { notFound } from "@/middleware/notFound";
import { env } from "@/config/env";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));

  app.use("/", routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
