import { createServer } from "http";
import { createApp } from "@/app";
import { createSocketServer } from "@/sockets";
import { env } from "@/config/env";
import { logger } from "@/utils/logger";

function bootstrap(): void {
  const app = createApp();
  const httpServer = createServer(app);
  const io = createSocketServer(httpServer);

  httpServer.listen(env.PORT, () => {
    logger.info("server started", {
      port: env.PORT,
      env: env.NODE_ENV,
      cors: env.CORS_ORIGIN,
    });
  });

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("shutting down", { signal });
    io.close(() => {
      httpServer.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap();
