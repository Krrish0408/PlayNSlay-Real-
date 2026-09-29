try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile();
  }
} catch {
  // .env file not present or already loaded
}

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { seedTestUsers } from "./seed";
import net from "net";
import { validateStartupConfig, config } from "./config";
import { isDatabaseUnavailableError } from "./db-errors";

import {
  requestIdMiddleware,
  errorHandlerMiddleware,
  sanitizeForLogging,
} from "./error-handler";

function findAvailablePort(startPort: number, maxRetries = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    const checkPort = (port: number, retriesLeft: number) => {
      const server = net.createServer();
      server.unref();
      server.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          if (retriesLeft > 0) {
            log(`Port ${port} is in use, trying port ${port + 1}...`);
            checkPort(port + 1, retriesLeft - 1);
          } else {
            reject(new Error(`Could not find an available port after ${maxRetries} attempts.`));
          }
        } else {
          reject(err);
        }
      });
      server.listen({ port, host: "0.0.0.0" }, () => {
        server.close(() => {
          resolve(port);
        });
      });
    };

    checkPort(startPort, maxRetries);
  });
}

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Essential security headers (OWASP standard)
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Attach request correlation ID to every incoming request
app.use(requestIdMiddleware);

import {
  observabilityMiddleware,
  logger,
} from "./observability";

export function log(message: string, source = "express") {
  logger.info({ source }, message);
}

// Attach production structured observability & request logging
app.use(observabilityMiddleware);

(async () => {
  try {
    validateStartupConfig();
  } catch (configErr: any) {
    console.error("================================================================================");
    console.error("FATAL CONFIGURATION ERROR - STARTUP ABORTED");
    console.error(configErr.message);
    console.error("================================================================================");
    process.exit(1);
  }

  // Ensure database schema and tables are fully initialized before registering routes or seeding
  const { initDbSchema } = await import("./db");
  await initDbSchema();

  await registerRoutes(httpServer, app);

  // In production/staging, never seed default test user accounts!
  if (!config.isProduction && !config.isStaging) {
    await seedTestUsers();
  } else {
    // In production/staging, only ensure the games catalog is synchronized
    const { seedGamesCatalog } = await import("./seed");
    await seedGamesCatalog();
  }

  // Initialize secure initial-admin bootstrap token if bootstrap is available
  try {
    const { isBootstrapAvailable, initializeBootstrapToken } = await import("./admin-bootstrap");
    const bootstrapAvailable = await isBootstrapAvailable();
    if (bootstrapAvailable) {
      const bootstrapInfo = await initializeBootstrapToken();
      if (bootstrapInfo?.generatedToken && (config.isDevelopment || config.isTest)) {
        console.log(`[BOOTSTRAP] Initial admin bootstrap required. One-time setup token: ${bootstrapInfo.generatedToken}`);
      } else {
        console.log(`[BOOTSTRAP] Initial admin bootstrap available. Awaiting administrator setup via /api/bootstrap or CLI.`);
      }
    }
  } catch (bootstrapErr) {
    console.error("[BOOTSTRAP] Failed to initialize bootstrap status:", bootstrapErr);
  }

  // Centralized Express error handler (never leaks stack traces, SQL, connection strings, or secrets)
  app.use(errorHandlerMiddleware);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // Default to 5001 if not specified (macOS AirPlay receiver occupies 5000)
  const defaultPort = parseInt(process.env.PORT || "5001", 10);
  const port = await findAvailablePort(defaultPort);

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
      console.log(`\n  ➜  Local:   http://localhost:${port}/`);
      console.log(`  ➜  Network: http://0.0.0.0:${port}/\n`);
    },
  );

  let isShuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, `[SHUTDOWN] Received ${signal}. Initiating graceful shutdown...`);

    // Signal readiness checks to return 503 so upstream load balancers stop routing traffic
    const { setShuttingDown } = await import("./observability");
    setShuttingDown(true);

    // Hard cutoff timer (10 seconds)
    const forceExitTimer = setTimeout(() => {
      logger.error("[SHUTDOWN] Graceful shutdown deadline exceeded (10s). Forcing process exit.");
      process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    // Stop accepting new connections and drain inflight requests
    httpServer.close(async (err) => {
      if (err) {
        logger.error({ error: err.message }, "[SHUTDOWN] Error closing HTTP server");
      } else {
        logger.info("[SHUTDOWN] HTTP server closed to new connections.");
      }

      try {
        // Close PostgreSQL connection pool
        const { pool } = await import("./db");
        if (pool) {
          logger.info("[SHUTDOWN] Draining and closing PostgreSQL connection pool...");
          await pool.end();
          logger.info("[SHUTDOWN] PostgreSQL pool closed.");
        }

        // Close Redis client if connected
        try {
          const { closeRedisClient } = await import("./rate-limiter");
          await closeRedisClient();
          logger.info("[SHUTDOWN] Redis client disconnected.");
        } catch {}

        clearTimeout(forceExitTimer);
        logger.info("[SHUTDOWN] Graceful shutdown completed cleanly. Exiting.");
        process.exit(0);
      } catch (cleanupErr: any) {
        logger.error({ error: cleanupErr?.message }, "[SHUTDOWN] Error during resource cleanup");
        process.exit(1);
      }
    });
  };

  process.once("SIGINT", () => handleShutdown("SIGINT"));
  process.once("SIGTERM", () => handleShutdown("SIGTERM"));
})();
