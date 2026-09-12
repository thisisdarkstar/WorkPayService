import winston from "winston";
import chalk from "chalk";
import fs from "fs";
import path from "path";

const isServerless = Boolean(
  process.env.VERCEL ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

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
  if (metadata.ip) logEntry.ip = metadata.ip;
  if (metadata.req_header) logEntry.req_header = metadata.req_header;
  if (metadata.req_body) logEntry.req_body = metadata.req_body;
  if (metadata.res_body) logEntry.res_body = metadata.res_body;
  if (metadata.dbQuery) logEntry.db_query = metadata.dbQuery;
  if (metadata.dbParams) logEntry.db_params = metadata.dbParams;
  if (metadata.dbExecutionTimeMs) logEntry.db_duration_ms = metadata.dbExecutionTimeMs;
  if (metadata.error) logEntry.error = metadata.error;

  return logEntry;
};

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf((info) => colorizeJSON(buildLogEntry(info)))
);

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf((info) => JSON.stringify(buildLogEntry(info)))
);

const transports = [
  new winston.transports.Console({ format: consoleFormat }),
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
    })
  );
}

const logger = winston.createLogger({
  level: "debug",
  transports,
});

export default logger;
