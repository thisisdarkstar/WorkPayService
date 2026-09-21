// Quick redaction verification for F-1. Run: node scripts/verify-log-redaction.js
import { sanitizeForLog } from "../src/utils/httpLogger.js";

// Use realistic (non-trivially-substringable) secret values so we can grep them.
const cases = [
  { temporaryPassword: "Kt@9xR-4Zq!m", employee: { name: "N" } },
  { temp_password: "AAA111BBB222", inner: { generatedPassword: "SekretVal_777" } },
  { password: "PlainPass9!", currentPassword: "Curr3ntP", newPassword: "Nu_P4ss" },
  { authorization: "Bearer some.jwt.token", token: "abc.def.ghi" },
  { accountNumber: "1234567890", ifscCode: "HDFC0001234" },
];

const secrets = [
  "Kt@9xR-4Zq!m",
  "AAA111BBB222",
  "SekretVal_777",
  "PlainPass9!",
  "Curr3ntP",
  "Nu_P4ss",
  "Bearer some.jwt.token",
  "abc.def.ghi",
  "1234567890",
  "HDFC0001234",
];

let ok = true;
for (const c of cases) {
  const out = sanitizeForLog(c);
  const json = JSON.stringify(out);
  // Match the quoted JSON value form to avoid substring collisions with key names.
  const leaks = secrets.filter((v) => json.includes(`"${v}"`));
  if (leaks.length) {
    console.error("FAIL:", { input: c, output: out, leaked: leaks });
    ok = false;
  } else {
    console.log("OK  :", json);
  }
}

if (!ok) process.exit(1);
console.log("\nF-1 verification passed. No sensitive values survived sanitization.");
