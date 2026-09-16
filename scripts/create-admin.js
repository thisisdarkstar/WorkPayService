#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"] });

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import bcrypt from "bcrypt";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

// Parse CLI arguments (e.g. --name "Acme Corp" --email "admin@acme.com" --phone "9876543210" --password "Secret123")
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  return /^\+?[0-9]{7,15}$/.test(phone.replace(/[\s-]/g, ""));
}

async function promptField(rl, promptText, validator, errorMsg) {
  while (true) {
    const answer = (await rl.question(promptText)).trim();
    if (!answer) {
      console.log("  ⚠️  This field cannot be empty. Please try again.\n");
      continue;
    }
    if (validator && !validator(answer)) {
      console.log(`  ⚠️  ${errorMsg}\n`);
      continue;
    }
    return answer;
  }
}

async function main() {
  console.log("\n========================================================");
  console.log("          WorkPay - Admin Creation Utility");
  console.log("========================================================\n");

  const args = parseArgs();
  let name = args.name;
  let email = args.email;
  let phone = args.phone;
  let password = args.password;

  const isInteractive = !name || !email || !phone || !password;
  const rl = isInteractive ? readline.createInterface({ input, output }) : null;

  try {
    if (isInteractive) {
      console.log("Interactive Mode: Please provide details for the new Admin.\n");

      if (!name) {
        name = await promptField(rl, "  [1/4] Admin Name (e.g., Jane Doe / Acme Corp): ");
      }

      if (!email || !isValidEmail(email)) {
        email = await promptField(
          rl,
          "  [2/4] Admin Email: ",
          isValidEmail,
          "Invalid email format. Please enter a valid email address."
        );
      }

      if (!phone || !isValidPhone(phone)) {
        phone = await promptField(
          rl,
          "  [3/4] Admin Phone (digits only): ",
          isValidPhone,
          "Invalid phone format. Please enter a valid phone number (7-15 digits)."
        );
      }

      if (!password || password.length < 6) {
        password = await promptField(
          rl,
          "  [4/4] Admin Password (min 6 characters): ",
          (p) => p.length >= 6,
          "Password must be at least 6 characters long."
        );
      }
    } else {
      // Validate CLI arguments
      if (!isValidEmail(email)) {
        console.error("❌ Error: Invalid email format provided via --email.");
        process.exit(1);
      }
      if (!isValidPhone(phone)) {
        console.error("❌ Error: Invalid phone format provided via --phone.");
        process.exit(1);
      }
      if (password.length < 6) {
        console.error("❌ Error: Password provided via --password must be at least 6 characters long.");
        process.exit(1);
      }
    }

    console.log("\n🔄 Checking existing records in database...");

    // Check if admin with same email or phone already exists
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

    // Create the admin
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

    console.log("\n========================================================");
    console.log("  🎉 Admin Created Successfully!");
    console.log("========================================================");
    console.log(`  • ID:    ${newAdmin.id}`);
    console.log(`  • Name:  ${newAdmin.name}`);
    console.log(`  • Email: ${newAdmin.email}`);
    console.log(`  • Phone: ${newAdmin.phone}`);
    console.log("========================================================\n");

    // Optional: Ask to create an initial office/branch in interactive mode
    if (rl) {
      const createOfficeAnswer = (
        await rl.question("  Would you like to create an initial office branch for this admin? (y/N): ")
      ).trim().toLowerCase();

      if (createOfficeAnswer === "y" || createOfficeAnswer === "yes") {
        console.log("\n  Branch Configuration:");
        const officeName = (await rl.question("    Branch Name (default: 'Main Office'): ")).trim() || "Main Office";
        const latInput = (await rl.question("    Latitude (default: 12.9716): ")).trim();
        const lngInput = (await rl.question("    Longitude (default: 77.5946): ")).trim();
        const latitude = latInput ? parseFloat(latInput) : 12.9716;
        const longitude = lngInput ? parseFloat(lngInput) : 77.5946;

        const checkinTime = new Date("2025-01-01T03:30:00.000Z"); // 09:00 AM IST
        const checkoutTime = new Date("2025-01-01T12:30:00.000Z"); // 06:00 PM IST

        const newOffice = await prisma.office.create({
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

        console.log(`\n  🏢 Office "${newOffice.name}" created successfully (ID: ${newOffice.id}) for Admin ID ${newAdmin.id}!`);
      }
    }

    console.log("\n✅ All done! The admin can now log into the WorkPay app.\n");
  } catch (err) {
    console.error("\n❌ An error occurred while creating admin:", err.message || err);
    process.exit(1);
  } finally {
    if (rl) rl.close();
    await prisma.$disconnect();
  }
}

main();
