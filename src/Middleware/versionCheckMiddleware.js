import { getAppVersionPolicy } from "../config/appVersionConfig.js";

/**
 * Defense-in-depth API middleware.
 * Inspects `X-App-Version-Code` sent by the WorkPay mobile app.
 * If the client version is below the backend's minimumSupportedVersionCode,
 * it returns HTTP 426 (Upgrade Required) so obsolete app builds cannot
 * execute backend mutations or read deprecated schemas.
 */
export function requireSupportedAppVersion(req, res, next) {
  const rawVersion = req.header("x-app-version-code");
  const platform = (req.header("x-app-platform") || "android").toLowerCase();

  // Non-mobile clients (Swagger UI, browser dashboard, webhooks, crons) omit this header and pass through
  if (!rawVersion) {
    return next();
  }

  const versionCode = parseInt(rawVersion, 10);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    return next();
  }

  const policies = getAppVersionPolicy();
  const policy = platform === "ios" ? policies.ios : policies.android;

  if (versionCode < policy.minimumSupportedVersionCode) {
    return res.status(426).json({
      error: "APP_UPDATE_REQUIRED",
      message:
        policy.message ||
        "Your WorkPay app version is outdated and no longer supported. Please update to continue.",
      minimumSupportedVersionCode: policy.minimumSupportedVersionCode,
      latestVersionCode: policy.latestVersionCode,
      storeUrl: policy.storeUrl,
      marketUrl: policy.marketUrl,
    });
  }

  next();
}
