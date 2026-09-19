import logger from "./logger.js";
import { requestContext } from "./requestContext.js";

/**
 * Standardized API Error Responder:
 * 1. Attaches error & stack to requestContext so httpLogger includes it in the final response log.
 * 2. Emits an immediate Winston error log with txnId, route, status code, and stack trace.
 * 3. Sends structured JSON response to client containing { error, txnId }.
 *
 * @param {import('express').Response} res
 * @param {Error|string} err
 * @param {number} [statusCode=500]
 * @param {string} [fallbackMessage="Internal Server Error"]
 */
export const sendApiError = (res, err, statusCode = 500, fallbackMessage = "Internal Server Error") => {
  const txnId = requestContext.getTxnId();
  const apiName = requestContext.getApiName();
  const method = res.req?.method || "-";

  const errorObj = err instanceof Error ? err : new Error(typeof err === "string" ? err : fallbackMessage);
  const errorMessage = errorObj.message || fallbackMessage;
  const stack = errorObj.stack || null;

  // 1. Store in requestContext so httpLogger's outgoing response log captures the error & stack
  requestContext.setError(errorObj);

  // 2. Explicit Winston error log
  logger.error(`${method} ${apiName} [${txnId}] - ${errorMessage}`, {
    metadata: {
      apiName,
      method,
      statusCode,
      txnId,
      error: errorMessage,
      stack,
    },
  });

  // 3. Return JSON to client with txnId for support/debugging reference
  // H-05: For server-side (5xx) errors in production, return the generic
  // fallback message instead of the raw exception text, which can leak Prisma /
  // database schema details. Intentional 4xx messages (validation, auth, etc.)
  // are safe to return as-is. Full detail is always preserved in the logs above.
  const isProduction = process.env.NODE_ENV === "production";
  const clientMessage =
    isProduction && statusCode >= 500 ? fallbackMessage : errorMessage;

  return res.status(statusCode).json({
    error: clientMessage,
    txnId,
  });
};
