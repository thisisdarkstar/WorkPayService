/**
 * WorkPay Mobile App Version Policy Configuration
 *
 * Configurable via environment variables without requiring code changes or redeployments.
 * Version codes are positive integers (Android versionCode / iOS buildNumber).
 *
 * Android package: com.chiranjeebnayak.workPayApp
 * (Reverted version policy: minimum 16, forceUpdate false)
 */
export const getAppVersionPolicy = () => {
  const minAndroid = parseInt(process.env.MIN_SUPPORTED_VERSION_ANDROID || "16", 10);
  const latestAndroid = parseInt(process.env.LATEST_VERSION_ANDROID || "16", 10);
  const forceUpdateAndroid = process.env.FORCE_UPDATE_ANDROID === "true";

  const minIos = parseInt(process.env.MIN_SUPPORTED_VERSION_IOS || "16", 10);
  const latestIos = parseInt(process.env.LATEST_VERSION_IOS || "16", 10);
  const forceUpdateIos = process.env.FORCE_UPDATE_IOS === "true";

  return {
    android: {
      latestVersionCode: Number.isSafeInteger(latestAndroid) ? latestAndroid : 16,
      minimumSupportedVersionCode: Number.isSafeInteger(minAndroid) ? minAndroid : 16,
      forceUpdate: forceUpdateAndroid,
      storeUrl: "https://play.google.com/store/apps/details?id=com.chiranjeebnayak.workPayApp",
      marketUrl: "market://details?id=com.chiranjeebnayak.workPayApp",
      title: "Update Required",
      message: "A new version of WorkPay is available with important improvements and bug fixes. Please update to continue.",
    },
    ios: {
      latestVersionCode: Number.isSafeInteger(latestIos) ? latestIos : 16,
      minimumSupportedVersionCode: Number.isSafeInteger(minIos) ? minIos : 16,
      forceUpdate: forceUpdateIos,
      storeUrl: "https://apps.apple.com/app/workpay/idYOUR_APP_ID",
      marketUrl: "itms-apps://itunes.apple.com/app/idYOUR_APP_ID",
      title: "Update Required",
      message: "A new version of WorkPay is available with important improvements and bug fixes. Please update to continue.",
    },
  };
};
