#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"] });

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import bcrypt from "bcrypt";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

// Parse CLI arguments (e.g. --name "Acme Corp" --email "admin@acme.com" -p "9876543210" --password "Secret123" -y)
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }

  // Normalize aliases
  return {
    name: parsed.name || parsed.n,
    email: parsed.email || parsed.e,
    phone: parsed.phone || parsed.p,
    password: parsed.password || parsed.pass,
    officeName: parsed["office-name"] || parsed.office,
    lat: parsed.lat,
    lng: parsed.lng,
    skipConfirm: parsed.yes || parsed.y || false,
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  return /^\+?[0-9]{7,15}$/.test(phone.replace(/[\s-]/g, ""));
}

async function promptField(rl, promptText, validator, errorMsg, defaultValue = null) {
  while (true) {
    const suffix = defaultValue ? ` [Default: ${defaultValue}]` : "";
    const rawAnswer = await rl.question(`${promptText}${suffix}: `);
    const answer = rawAnswer.trim() || defaultValue;

    if (!answer) {
      console.log("    ⚠️  This field cannot be empty. Please try again.\n");
      continue;
    }
    if (validator && !validator(answer)) {
      console.log(`    ⚠️  ${errorMsg}\n`);
      continue;
    }
    return answer;
  }
}

async function main() {
  console.log("\n========================================================");
  console.log("          WorkPay - Admin Creation Utility");
  console.log("========================================================\n");

  const flags = parseArgs();
  let name = flags.name;
  let email = flags.email;
  let phone = flags.phone;
  let password = flags.password;
  let officeName = flags.officeName;
  let latitude = flags.lat ? parseFloat(flags.lat) : null;
  let longitude = flags.lng ? parseFloat(flags.lng) : null;
  let wantsOffice = Boolean(officeName);

  // We need readline if any field is missing OR if we need user confirmation
  const needsPrompting = !name || !email || !phone || !password;
  const needsConfirmation = !flags.skipConfirm;

  let rl = null;
  if (needsPrompting || needsConfirmation) {
    rl = readline.createInterface({ input, output });
  }

  try {
    // ----------------------------------------------------
    // Step 1: Gather Admin Details (Interactive or Flag)
    // ----------------------------------------------------
    if (needsPrompting) {
      console.log("📝 Step 1: Admin Account Details");
      console.log("--------------------------------------------------------");

      if (!name) {
        name = await promptField(rl, "  [1/4] Admin Name (e.g. Acme Corp / John Doe)");
      } else {
        console.log(`  [1/4] Admin Name: ${name}`);
      }

      if (!email || !isValidEmail(email)) {
        email = await promptField(
          rl,
          "  [2/4] Admin Email",
          isValidEmail,
          "Invalid email format. Please enter a valid email address."
        );
      } else {
        console.log(`  [2/4] Admin Email: ${email}`);
      }

      if (!phone || !isValidPhone(phone)) {
        phone = await promptField(
          rl,
          "  [3/4] Admin Phone (7-15 digits)",
          isValidPhone,
          "Invalid phone format. Must be 7-15 digits."
        );
      } else {
        console.log(`  [3/4] Admin Phone: ${phone}`);
      }

      if (!password || password.length < 6) {
        password = await promptField(
          rl,
          "  [4/4] Admin Password (min 6 chars)",
          (p) => p.length >= 6,
          "Password must be at least 6 characters."
        );
      } else {
        console.log(`  [4/4] Admin Password: [Provided via flag]`);
      }
      console.log("");
    } else {
      // Validate flags if supplied non-interactively
      if (!isValidEmail(email)) {
        console.error("❌ Error: Invalid email format provided via --email.");
        process.exit(1);
      }
      if (!isValidPhone(phone)) {
        console.error("❌ Error: Invalid phone format provided via --phone.");
        process.exit(1);
      }
      if (password.length < 6) {
        console.error("❌ Error: Password provided via --password must be at least 6 characters.");
        process.exit(1);
      }
    }

    // ----------------------------------------------------
    // Step 2: Optional Office Setup
    // ----------------------------------------------------
    if (!flags.officeName && rl) {
      console.log("🏢 Step 2: Initial Branch Setup (Optional)");
      console.log("--------------------------------------------------------");
      const answer = (
        await rl.question("  Would you like to initialize a branch for this admin? (Y/n): ")
      ).trim().toLowerCase();

      wantsOffice = answer === "" || answer === "y" || answer === "yes";

      if (wantsOffice) {
        officeName = await promptField(rl, "    Branch Name", null, null, "Main Office");
        const latInput = await promptField(
          rl,
          "    Latitude",
          (v) => !isNaN(parseFloat(v)),
          "Must be a valid decimal number",
          "12.9716"
        );
        const lngInput = await promptField(
          rl,
          "    Longitude",
          (v) => !isNaN(parseFloat(v)),
          "Must be a valid decimal number",
          "77.5946"
        );
        latitude = parseFloat(latInput);
        longitude = parseFloat(lngInput);
      }
      console.log("");
    } else if (flags.officeName) {
      wantsOffice = true;
      officeName = typeof flags.officeName === "string" ? flags.officeName : "Main Office";
      latitude = latitude || 12.9716;
      longitude = longitude || 77.5946;
    }

    // ----------------------------------------------------
    // Step 3: Confirmation Screen
    // ----------------------------------------------------
    console.log("========================================================");
    console.log("          📋 Review Details Before Creation");
    console.log("========================================================");
    console.log(`  • Name:            ${name}`);
    console.log(`  • Email:           ${email}`);
    console.log(`  • Phone:           ${phone}`);
    console.log(`  • Password:        ${password} (${password.length} characters)`);
    if (wantsOffice) {
      console.log(`  • Initial Office:  ${officeName}`);
      console.log(`    - Coordinates:   Lat ${latitude}, Lng ${longitude}`);
      console.log(`    - Working Hours: 09:00 AM – 06:00 PM IST (Default)`);
    } else {
      console.log(`  • Initial Office:  None (can be created later in app)`);
    }
    console.log("========================================================\n");

    if (needsConfirmation && rl) {
      const confirm = (
        await rl.question("👉 Proceed to create this admin in database? (Y/n): ")
      ).trim().toLowerCase();

      if (confirm !== "" && confirm !== "y" && confirm !== "yes") {
        console.log("\n❌ Creation cancelled by user. No changes were made to the database.\n");
        process.exit(0);
      }
    }

    // ----------------------------------------------------
    // Step 4: Database Execution
    // ----------------------------------------------------
    console.log("\n🔄 Checking existing records in database...");

    const existingAdmin = await prisma.admin.findFirst({
      where: {
        OR: [{ email }, { phone }],
      },
    });

    if (existingAdmin) {
      if (existingAdmin.email === email) {
        console.error(`\n❌ Error: An admin with email "${email}" already exists (ID: ${existingAdmin.id}).`);
      } else {
        console.error(`\n❌ Error: An admin with phone "${phone}" already exists (ID: ${existingAdmin.id}).`);
      }
      process.exit(1);
    }

    console.log("🔄 Hashing password securely with bcrypt...");
    const hashedPassword = await bcrypt.hash(password, 10);

    console.log("🔄 Writing admin record to PostgreSQL...");
    const newAdmin = await prisma.admin.create({
      data: {
        name,
        email,
        phone,
        password: hashedPassword,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
      },
    });

    let createdOffice = null;
    if (wantsOffice) {
      console.log("🔄 Creating initial office branch...");
      const checkinTime = new Date("2025-01-01T03:30:00.000Z"); // 09:00 AM IST
      const checkoutTime = new Date("2025-01-01T12:30:00.000Z"); // 06:00 PM IST

      createdOffice = await prisma.office.create({
        data: {
          name: officeName,
          latitude,
          longitude,
          checkin: checkinTime,
          checkout: checkoutTime,
          breakTime: 60,
          range: 1000,
          adminId: newAdmin.id,
        },
      });
    }

    console.log("\n========================================================");
    console.log("  🎉 Admin Created Successfully!");
    console.log("========================================================");
    console.log(`  • Admin ID:   ${newAdmin.id}`);
    console.log(`  • Name:       ${newAdmin.name}`);
    console.log(`  • Email:      ${newAdmin.email}`);
    console.log(`  • Phone:      ${newAdmin.phone}`);
    if (createdOffice) {
      console.log(`  • Office ID:  ${createdOffice.id} (${createdOffice.name})`);
    }
    console.log("========================================================");
    console.log("\n✅ The admin can now log in to the WorkPay app.\n");
  } catch (err) {
    console.error("\n❌ An error occurred while creating admin:", err.message || err);
    process.exit(1);
  } finally {
    if (rl) rl.close();
    await prisma.$disconnect();
  }
}

main();
