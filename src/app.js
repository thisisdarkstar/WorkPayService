import express from "express";
import cors from "cors";
import adminRoutes from "./routes/adminRoutes.js";
import officeRoutes from "./routes/officeRoutes.js";
import employeeRoutes from "./routes/employeeRoutes.js";
import attendanceRoutes from "./routes/attendanceRoute.js";
import leaveRoutes from "./routes/leaveRoutes.js";
import transactionRouter from "./routes/transactionRoutes.js"
import holidayRoutes from "./routes/holidayRoutes.js";

// imports for logging
import logger from "./utils/logger.js"
import { httpLogger } from "./utils/httpLogger.js";
import { requestContext } from "./utils/requestContext.js";
import crypto from "crypto";
import { attachDbLogger } from "./Middleware/dbLoggerMiddleware.js";
import swaggerUi from "swagger-ui-express";
import { swaggerDocument } from "./swagger.js";

import helmet from "helmet";
import rateLimit from "express-rate-limit";

// 🛡️ Global Process-Level Crash Protection
process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled Rejection: ${reason?.message || reason}`, {
    metadata: {
      error: reason?.message || String(reason),
      stack: reason?.stack || null,
    },
  });
});

process.on("uncaughtException", (error) => {
  logger.error(`Uncaught Exception: ${error.message}`, {
    metadata: {
      error: error.message,
      stack: error.stack || null,
    },
  });
});

const app = express();

// Trust reverse proxy (Cloudflare, AWS ALB, Nginx, Render, Vercel, etc.) for rate limiting and IP tracking
app.set("trust proxy", 1);

// Security headers (keep CSP disabled for swagger-ui assets)
app.use(helmet({ contentSecurityPolicy: false }));

// M-01: Restrict CORS to explicitly allowed origins.
// Native mobile apps send no Origin header, so requests with no origin are
// allowed (this is the primary WorkPay client). Browser origins must be
// whitelisted via the ALLOWED_ORIGINS env var (comma-separated). If unset,
// only the production API host is permitted for browser-based access.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://work-pay-service.vercel.app")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser clients (mobile app, curl, server-to-server) that
      // send no Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "x-super-admin-key", "x-cron-secret", "x-transaction-id"],
  })
);

// 1️⃣ Initialize Request Context FIRST for every single hit & set X-Transaction-Id
app.use((req, res, next) => {
  const txnId = req.headers["x-transaction-id"] || crypto.randomUUID();
  const apiName = req.originalUrl || req.url;
  res.setHeader("X-Transaction-Id", txnId);
  requestContext.run({ txnId, apiName }, () => next());
});

// 2️⃣ Attach DB logging proxy
app.use(attachDbLogger);

// 3️⃣ Body parsing with safe JSON syntax error handling
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    const txnId = requestContext.getTxnId();
    logger.warn(`Malformed JSON in request body [${txnId}] - ${err.message}`, {
      metadata: {
        apiName: req.originalUrl || req.url,
        method: req.method,
        statusCode: 400,
        txnId,
        error: err.message,
      },
    });
    return res.status(400).json({ error: "Invalid JSON format in request body", txnId });
  }
  next(err);
});

// 4️⃣ Mount HTTP Logger (captures incoming hit immediately + outgoing on finish)
app.use(httpLogger);

// 5️⃣ Rate limiters (placed AFTER httpLogger so 429 rate-limited hits are logged with txnId)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again after 15 minutes." },
});

app.use("/api/admins/login", authLimiter);
app.use("/api/employees/login", authLimiter);
app.use("/api/admins/reset-password-phone", authLimiter);
app.use("/api/employees/reset-password", authLimiter);

// Swagger Documentation UI
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get("/", (req, res) => {
  const responsePayload = {
    version: "1.0.1",
    message: "Welcome to the WorkPay API",
    docs: "/api-docs",
  };
  res.send(responsePayload);
});

// Authorized Digital Sellers for Mobile Apps (IAB Tech Lab standard for Google AdMob)
app.get("/app-ads.txt", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send("google.com, pub-5483665722366697, DIRECT, f08c47fec0942fa0\n");
});

app.use("/api/admins", adminRoutes);
app.use("/api/offices", officeRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/attendances", attendanceRoutes);
app.use("/api/leaves", leaveRoutes);
app.use("/api/transactions", transactionRouter);
app.use("/api/holidays", holidayRoutes);

// 6️⃣ 404 handler for undefined endpoints
app.use((req, res) => {
  const txnId = requestContext.getTxnId();
  res.status(404).json({
    error: "Route Not Found",
    method: req.method,
    path: req.originalUrl,
    txnId,
  });
});

// 7️⃣ Global 500 error handler
app.use((err, req, res, next) => {
  const txnId = requestContext.getTxnId();
  const apiName = req.originalUrl || req.url;
  logger.error(`${req.method} ${apiName} [${txnId}] - ${err.message}`, {
    metadata: {
      apiName,
      method: req.method,
      statusCode: 500,
      txnId,
      error: err.message,
      stack: err.stack,
    },
  });
  // H-05: Never leak raw exception details (which can include Prisma error text
  // exposing table/column/constraint names) to clients in production.
  const isProduction = process.env.NODE_ENV === "production";
  res.status(500).json({
    error: "Internal Server Error",
    ...(isProduction ? {} : { message: err.message }),
    txnId,
  });
});

export default app;
