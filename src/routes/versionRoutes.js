import express from "express";
import { getAppVersionPolicy } from "../config/appVersionConfig.js";

const router = express.Router();

/**
 * @swagger
 * /api/app-version:
 *   get:
 *     summary: Verify client app version and check for mandatory or flexible updates
 *     parameters:
 *       - in: query
 *         name: platform
 *         schema:
 *           type: string
 *           enum: [android, ios]
 *         description: Client operating system
 *       - in: query
 *         name: versionCode
 *         schema:
 *           type: integer
 *         description: Integer build number / versionCode of the installed app
 *     responses:
 *       200:
 *         description: Version status and update requirements
 */
router.get("/app-version", (req, res) => {
  const platform = (req.query.platform || "android").toLowerCase();
  const rawVersion = req.query.versionCode;
  const versionCode = rawVersion != null ? parseInt(rawVersion, 10) : null;

  const policies = getAppVersionPolicy();
  const policy = platform === "ios" ? policies.ios : policies.android;

  if (versionCode != null && (!Number.isSafeInteger(versionCode) || versionCode < 1)) {
    return res.status(400).json({
      error: "Invalid versionCode. Must be a positive integer.",
    });
  }

  const isClientOutdated =
    versionCode != null &&
    (versionCode < policy.minimumSupportedVersionCode ||
      (policy.forceUpdate && versionCode < policy.latestVersionCode));

  const isUpdateAvailable =
    versionCode != null && versionCode < policy.latestVersionCode;

  return res.json({
    platform,
    clientVersionCode: versionCode,
    latestVersionCode: policy.latestVersionCode,
    minimumSupportedVersionCode: policy.minimumSupportedVersionCode,
    updateRequired: isClientOutdated,
    updateAvailable: isUpdateAvailable,
    storeUrl: policy.storeUrl,
    marketUrl: policy.marketUrl,
    title: policy.title,
    message: policy.message,
  });
});

export default router;
