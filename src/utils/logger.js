import winston from "winston";
import chalk from "chalk";
import fs from "fs";
import path from "path";

const isServerless = Boolean(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

const isProduction = process.env.NODE_ENV === "production" || isServerless;

const colorizeJSON = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(
    /"([^"]+)":\s(".*?"|\d+|true|false|null|\{|\[|[\w.-]+)/g,
    (match, key, value) => {
      const coloredKey = chalk.green(`"${key}"`);
      const coloredValue = chalk.blue(value);
      return `${coloredKey}: ${coloredValue}`;
    }
  );
};

const buildLogEntry = ({ timestamp, level, message, metadata = {} }) => {
  const logEntry = {
    timestamp,
    level,
    apiName: metadata.apiName || "-",
    messageNumber: metadata.messageNumber || "-",
    txnId: metadata.txnId || "-",
    message,
  };

  if (metadata.method) logEntry.method = metadata.method;
  if (metadata.statusCode) logEntry.status_code = metadata.statusCode;
  if (metadata.duration_ms !== undefined) logEntry.duration_ms = metadata.duration_ms;
  if (metadata.ip) logEntry.ip = metadata.ip;
  if (metadata.req_header) logEntry.req_header = metadata.req_header;
  if (metadata.req_body) logEntry.req_body = metadata.req_body;
  if (metadata.res_body) logEntry.res_body = metadata.res_body;
  if (metadata.dbQuery) logEntry.db_query = metadata.dbQuery;
  if (metadata.dbParams) logEntry.db_params = metadata.dbParams;
  if (metadata.dbExecutionTimeMs !== undefined) logEntry.db_duration_ms = metadata.dbExecutionTimeMs;
  if (metadata.dbError) logEntry.db_error = metadata.dbError;
  if (metadata.error) logEntry.error = metadata.error;
  if (metadata.stack) logEntry.stack = metadata.stack;

  return logEntry;
};

// Colored multiline for local terminal debugging
const devConsoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf((info) => colorizeJSON(buildLogEntry(info)))
);

// Single-line clean JSON for production log aggregators (Vercel, CloudWatch, Datadog)
const prodConsoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf((info) => JSON.stringify(buildLogEntry(info)))
);

// File logging format (always clean single-line JSON)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf((info) => JSON.stringify(buildLogEntry(info)))
);

const transports = [
  new winston.transports.Console({
    format: isProduction ? prodConsoleFormat : devConsoleFormat,
    handleExceptions: true,
    handleRejections: true,
  }),
];

if (!isServerless) {
  const logsDir = path.resolve("logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      handleExceptions: true,
      handleRejections: true,
    })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "debug",
  transports,
  exitOnError: false, // Don't crash process on handled exception
});

export default logger;
