/**
 * Centralized JWT secret resolution and validation.
 *
 * SECURITY (SEC-005): Previously each file used
 *   const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
 * A hardcoded fallback means that if the env var is ever missing in
 * production, every token would be signed/verified with a publicly known
 * secret, allowing anyone to forge admin/employee tokens.
 *
 * This module fails fast in production when JWT_SECRET is unset, and only
 * permits an explicit, clearly-logged insecure fallback in non-production.
 */

const isProduction = process.env.NODE_ENV === "production";

const resolveJwtSecret = () => {
  const secret = process.env.JWT_SECRET;

  if (secret && secret.trim().length >= 16) {
    return secret;
  }

  if (isProduction) {
    // Do not start with a missing/weak secret in production.
    throw new Error(
      "FATAL: JWT_SECRET environment variable is missing or too short (min 16 chars). " +
        "Refusing to start in production with an insecure signing key."
    );
  }

  // Non-production only: allow a development fallback but make the risk loud.
  // eslint-disable-next-line no-console
  console.warn(
    "[SECURITY WARNING] JWT_SECRET is not set (or is too short). " +
      "Using an insecure development-only fallback. Set a strong JWT_SECRET before deploying."
  );
  return secret && secret.length > 0 ? secret : "dev-only-insecure-secret-change-me";
};

export const JWT_SECRET = resolveJwtSecret();
