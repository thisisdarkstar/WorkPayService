#!/usr/bin/env node

/**
 * WorkPay - Admin Reset Utility
 * ---------------------------------------------------------------------------
 * Resets a single admin back to a "clean" state by deleting ALL data that
 * belongs to that admin's organization:
 *   - Transactions, Attendance, Leaves of the admin's employees
 *   - The admin's Employees
 *   - The admin's Offices
 *   - The admin's Holidays
 * The Admin record itself is KEPT (so they can still log in). Optionally,
 * the admin's password can be updated in the same run.
 *
 * SAFETY:
 *   - Destructive. Runs in DRY-RUN by default (shows counts, deletes nothing).
 *   - Requires --confirm plus typing the exact admin email to actually delete.
 *   - Everything runs inside a single transaction (all-or-nothing).
 *
 * USAGE:
 *   node scripts/reset-admin.js --email admin@acme.com                                    # READ-ONLY preview (no password)
 *   node scripts/reset-admin.js --email admin@acme.com --verify-password "Secret123"       # real reset (password verified)
 *   node scripts/reset-admin.js --email admin@acme.com --verify-password "Secret123" --new-password "NewSecret123"
 *
 * MODEL:
 *   - NO password        -> READ-ONLY preview. Shows what would be deleted, deletes nothing.
 *   - Password supplied   -> REAL reset. The password is bcrypt-verified against the
 *                            stored hash; a wrong password aborts before any deletion.
 *   Providing valid credentials IS the confirmation — there is no separate --confirm flag.
 *
 * FLAGS:
 *   --email <email>        (REQUIRED) Identify the admin by email
 *   --verify-password <p>  Admin's CURRENT password. Supplying it switches from
 *                          read-only preview to a real, verified reset.
 *   --new-password <pass>  Also set a new password (min 8 chars, hashed with bcrypt)
 *   --yes / -y             Skip the typed-email safety prompt (password still required)
 */

import dotenv from "dotenv";
dotenv.config({ path: [".env.local", ".env"] });

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import bcrypt from "bcrypt";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

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
  return {
    email: parsed.email || parsed.e,
    verifyPassword: parsed["verify-password"] || parsed.verify,
    newPassword: parsed["new-password"] || parsed.password,
    skipPrompt: Boolean(parsed.yes || parsed.y),
  };
}

async function main() {
  console.log("\n========================================================");
  console.log("          WorkPay - Admin Reset Utility");
  console.log("========================================================\n");

  const flags = parseArgs();

  if (!flags.email) {
    console.error("❌ Error: --email <email> is REQUIRED to identify the admin to reset.");
    console.error("   This is a destructive operation, so the admin must be identified by email.");
    console.error("   Example: node scripts/reset-admin.js --email admin@acme.com\n");
    process.exit(1);
  }

  if (flags.newPassword && (typeof flags.newPassword !== "string" || flags.newPassword.length < 8)) {
    console.error("❌ Error: --new-password must be at least 8 characters.\n");
    process.exit(1);
  }

  // Read-only vs destructive is determined SOLELY by whether an admin password
  // is supplied. No password  -> read-only preview (safe). Password supplied
  // (and verified) -> real reset. There is no separate --confirm flag; providing
  // valid credentials IS the confirmation.
  const isDryRun = !flags.verifyPassword;

  try {
    // 1. Locate the admin strictly by email.
    const admin = await prisma.admin.findUnique({
      where: { email: flags.email },
      select: { id: true, name: true, email: true, phone: true, password: true },
    });

    if (!admin) {
      console.error(`❌ Error: No admin found for email=${flags.email}.\n`);
      process.exit(1);
    }

    // Credential-based authorization (MANDATORY for a real reset):
    // If a password was supplied, verify it now against the stored hash. A wrong
    // password aborts before any deletion. Without a password we stay read-only.
    if (!isDryRun) {
      const ok = await bcrypt.compare(String(flags.verifyPassword), admin.password);
      if (!ok) {
        console.error("\n❌ Error: Password does not match this admin's current password. Aborting. No changes were made.\n");
        process.exit(1);
      }
      console.log("🔐 Admin credentials verified.\n");
    }

    // 2. Gather the admin's employees and count everything that will be deleted
    const employees = await prisma.employee.findMany({
      where: { adminId: admin.id },
      select: { id: true },
    });
    const employeeIds = employees.map((e) => e.id);

    const [transactionCount, attendanceCount, leaveCount, officeCount, holidayCount] = await Promise.all([
      employeeIds.length ? prisma.transaction.count({ where: { empId: { in: employeeIds } } }) : Promise.resolve(0),
      employeeIds.length ? prisma.attendance.count({ where: { empId: { in: employeeIds } } }) : Promise.resolve(0),
      employeeIds.length ? prisma.leave.count({ where: { empId: { in: employeeIds } } }) : Promise.resolve(0),
      prisma.office.count({ where: { adminId: admin.id } }),
      prisma.holiday.count({ where: { adminId: admin.id } }),
    ]);

    // 3. Show the plan
    console.log("👤 Target Admin");
    console.log("--------------------------------------------------------");
    console.log(`  • ID:    ${admin.id}`);
    console.log(`  • Name:  ${admin.name}`);
    console.log(`  • Email: ${admin.email}`);
    console.log(`  • Phone: ${admin.phone}`);
    console.log("");
    console.log(isDryRun
      ? "🗑️  Data that WOULD be deleted for this admin:"
      : "🗑️  Data that will be DELETED for this admin:");
    console.log("--------------------------------------------------------");
    console.log(`  • Transactions: ${transactionCount}`);
    console.log(`  • Attendance:   ${attendanceCount}`);
    console.log(`  • Leaves:       ${leaveCount}`);
    console.log(`  • Employees:    ${employeeIds.length}`);
    console.log(`  • Offices:      ${officeCount}`);
    console.log(`  • Holidays:     ${holidayCount}`);
    console.log("--------------------------------------------------------");
    console.log(`  The Admin record itself will be KEPT.`);
    if (flags.newPassword && !isDryRun) {
      console.log(`  The Admin password will be UPDATED (and all their sessions invalidated).`);
    }
    console.log("");

    if (isDryRun) {
      console.log("✅ READ-ONLY preview complete. No data was deleted.");
      console.log("   To actually perform the reset, re-run with the admin's password:");
      console.log(`   node scripts/reset-admin.js --email ${admin.email} --verify-password "<current password>"\n`);
      process.exit(0);
    }

    // 4. Extra safety: require typing the exact email (unless --yes)
    if (!flags.skipPrompt) {
      const rl = readline.createInterface({ input, output });
      try {
        console.log("⚠️  This is a DESTRUCTIVE, irreversible operation.");
        const typed = (await rl.question(`   To proceed, type the admin's email exactly (${admin.email}): `)).trim();
        if (typed !== admin.email) {
          console.log("\n❌ Confirmation text did not match. Aborting. No changes were made.\n");
          process.exit(0);
        }
      } finally {
        rl.close();
      }
    }

    // 5. Perform the reset atomically (respecting FK order:
    //    transactions/attendance/leaves -> employees -> offices -> holidays)
    console.log("\n🔄 Resetting admin data in a single transaction...");

    const hashedPassword = flags.newPassword ? await bcrypt.hash(flags.newPassword, 10) : null;

    const result = await prisma.$transaction(async (tx) => {
      let deleted = { transactions: 0, attendance: 0, leaves: 0, employees: 0, offices: 0, holidays: 0 };

      // ISOLATION SAFEGUARD: re-derive this admin's employee IDs INSIDE the
      // transaction and use ONLY those. Every child delete is additionally
      // constrained by the employee->adminId relation so it is impossible to
      // touch another admin's rows even if employeeIds were somehow stale.
      const ownedEmployees = await tx.employee.findMany({
        where: { adminId: admin.id },
        select: { id: true },
      });
      const ownedEmployeeIds = ownedEmployees.map((e) => e.id);

      if (ownedEmployeeIds.length) {
        deleted.transactions = (await tx.transaction.deleteMany({
          where: { empId: { in: ownedEmployeeIds }, employee: { adminId: admin.id } },
        })).count;
        deleted.attendance = (await tx.attendance.deleteMany({
          where: { empId: { in: ownedEmployeeIds }, employee: { adminId: admin.id } },
        })).count;
        deleted.leaves = (await tx.leave.deleteMany({
          where: { empId: { in: ownedEmployeeIds }, employee: { adminId: admin.id } },
        })).count;
        deleted.employees = (await tx.employee.deleteMany({
          where: { adminId: admin.id },
        })).count;
      }

      // Offices and holidays are scoped directly by adminId.
      deleted.offices = (await tx.office.deleteMany({ where: { adminId: admin.id } })).count;
      deleted.holidays = (await tx.holiday.deleteMany({ where: { adminId: admin.id } })).count;

      if (hashedPassword) {
        await tx.admin.update({
          where: { id: admin.id },
          data: { password: hashedPassword, passwordChangedAt: new Date() },
        });
      }

      return deleted;
    });

    console.log("\n========================================================");
    console.log("  🎉 Admin Reset Complete");
    console.log("========================================================");
    console.log(`  • Admin:        ${admin.name} (${admin.email}) — kept`);
    console.log(`  • Transactions: ${result.transactions} deleted`);
    console.log(`  • Attendance:   ${result.attendance} deleted`);
    console.log(`  • Leaves:       ${result.leaves} deleted`);
    console.log(`  • Employees:    ${result.employees} deleted`);
    console.log(`  • Offices:      ${result.offices} deleted`);
    console.log(`  • Holidays:     ${result.holidays} deleted`);
    if (flags.newPassword) {
      console.log(`  • Password:     updated (existing sessions invalidated)`);
    }
    console.log("========================================================\n");
  } catch (err) {
    console.error("\n❌ An error occurred during admin reset:", err.message || err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
