import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import moment from "moment-timezone";
import { sendApiError } from "../utils/errorHandler.js";
import { JWT_SECRET } from "../config/jwt.js";

/**
 * Generates a secure, human-readable temporary password.
 *
 * SECURITY:
 * - Uses crypto.randomInt() (a CSPRNG) with NO modulo bias — every character is
 *   drawn from a uniform distribution (unlike `randomBytes[i] % len`, which
 *   over-weights the first (256 % len) characters of the set).
 * - Excludes ambiguous glyphs (0/O, 1/l/I) so the password is easy to read/type.
 * - Uses a CURATED special-character set that is safe to share via SMS/URL/shell
 *   and easy to type on mobile keyboards (avoids quotes, backslash, spaces,
 *   angle brackets, and other shell/URL-hostile symbols).
 * - Guarantees at least one uppercase, one lowercase, one digit, and one special
 *   character, then fills the rest randomly and shuffles, so it always satisfies
 *   a strong mixed-class policy.
 *
 * @param {number} length total length (default 12 → ~75 bits of entropy)
 * @returns {string}
 */
const generateTempPassword = (length = 12) => {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  // Curated, share-safe specials: no quotes/backslash/space/angle-brackets, and
  // nothing that commonly breaks URLs or shell commands when copy-pasted.
  const specials = "!@#$%*?-_+=";
  const all = upper + lower + digits + specials;

  const pick = (set) => set[crypto.randomInt(set.length)];

  // Guarantee one of each required class.
  const required = [pick(upper), pick(lower), pick(digits), pick(specials)];

  // Fill the remainder from the full set.
  const remainingCount = Math.max(0, length - required.length);
  const chars = [...required];
  for (let i = 0; i < remainingCount; i++) {
    chars.push(pick(all));
  }

  // Unbiased Fisher–Yates shuffle so the guaranteed chars aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
};

// ✅ Employee Login (supports phone or email)
export const loginEmployee = async (req, res) => {
  try {
    const { phone, email, password } = req.body;

    if ((!phone && !email) || !password) {
      return res.status(400).json({ error: "Phone or email, and password are required" });
    }

    const employee = await req.db.employee.findFirst({
      where: {
        OR: [
          phone ? { phone } : undefined,
          email ? { email } : undefined,
        ].filter(Boolean),
      },
    });
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    if (employee.status !== "ACTIVE") {
      return res.status(403).json({ error: "Employee login is not allowed" });
    }

    const isPasswordValid = await bcrypt.compare(password, employee.password);
    if (!isPasswordValid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: employee.id, email: employee.email, role: "employee" },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ message: "Employee login successful", token });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to login employee");
  }
};

// ✅ Create Employee
export const createEmployee = async (req, res) => {
  try {
    const adminId = req.admin.id; // from adminAuth middleware
    const { name, phone, email, baseSalary, overtimeRate, officeId, joinedDate,accountNumber,ifscCode } = req.body;

    if (!name || !phone || !email || !baseSalary || !overtimeRate || !officeId || !adminId) {
      return res.status(400).json({ error: "All required fields must be provided" });
    }

    // SECURITY (C-03): Never use a predictable value (like the phone number) as
    // the initial password. Generate a cryptographically random temporary
    // password server-side and return it once so the admin can share it. The
    // employee changes it from their Profile screen after first login.
    const temporaryPassword = generateTempPassword(12);

    const existingPhone = await req.db.employee.findUnique({ where: { phone } });
    if (existingPhone) {
      return res.status(400).json({ error: "Employee with this phone number already exists" });
    }

    const existingEmail = await req.db.employee.findUnique({ where: { email } });
    if (existingEmail) {
      return res.status(400).json({ error: "Employee with this email already exists" });
    }

    // Verify office belongs to this admin
    const office = await req.db.office.findFirst({
      where: { id: Number(officeId), adminId: Number(adminId) }
    });
    if (!office) {
      return res.status(400).json({ error: "Office not found or does not belong to your organization" });
    }

    // hash the generated temporary password
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    // Get current UTC time and convert to IST to get today's date
    const nowUTC = new Date();
    const todayIST = moment.utc(nowUTC).tz("Asia/Kolkata").startOf('day');
    const todayUTC = todayIST.utc().toDate();


    // Get all holidays that are on or after TODAY (employee creation date) belonging to THIS admin
    const upcomingHolidays = await req.db.holiday.findMany({
      where: {
        date: {
          gte: todayUTC // Holidays on or after today
        },
        adminId: Number(adminId)
      },
      orderBy: {
        date: 'asc'
      }
    });


    // Use transaction to create employee and holiday attendance records atomically
    const result = await req.db.$transaction(async (tx) => {
      // Create the employee
      const employee = await tx.employee.create({
        data: {
          name,
          phone,
          email,
          password: hashedPassword,
          baseSalary: Number(baseSalary),
          overtimeRate: Number(overtimeRate),
          officeId: Number(officeId),
          adminId: Number(adminId),
          joinedDate: new Date(joinedDate),
          accountNumber,
          ifscCode
        },
      });


      // Create attendance records for all upcoming holidays
      let holidayAttendanceCount = 0;
      if (upcomingHolidays.length > 0) {
        const holidayAttendanceRecords = await tx.attendance.createMany({
          data: upcomingHolidays.map(holiday => ({
            empId: employee.id,
            date: holiday.date, // Use the same UTC date as holiday
            checkInTime: null,
            checkOutTime: null,
            overTime: 0,
            status: "HOLIDAY"
          })),
          skipDuplicates: true // Skip if attendance already exists (safety check)
        });

        holidayAttendanceCount = holidayAttendanceRecords.count;
      }

      return { employee, holidayAttendanceCount };
    });

    // Prepare holiday details for response
    const holidayDates = upcomingHolidays.map(h => 
      moment.utc(h.date).tz("Asia/Kolkata").format("YYYY-MM-DD")
    );

   // 1. Check if result exists before sending response
    if (!result || !result.employee) {
       throw new Error("Transaction completed but employee data is missing.");
    }

    res.status(201).json({
      message: "Employee created successfully", // Removed the variable from here to stop the Symbol error
      temporaryPassword, // C-03: returned once so admin can securely share it
      data: {
        id: result.employee.id,
        name: result.employee.name,
        phone: result.employee.phone,
        email: result.employee.email,
        baseSalary: result.employee.baseSalary,
        overtimeRate: result.employee.overtimeRate,
        joinedDate: result.employee.joinedDate,
        accountNumber: result.employee.accountNumber, 
        ifscCode: result.employee.ifscCode 
      },
      holidayAttendance: {
        created: result.holidayAttendanceCount,
        dates: holidayDates
      }
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to create employee");
  }
};

// ✅ Get all employees (excludes password hash, scoped by adminId)
export const getEmployees = async (req, res) => {
  try {
    const adminId = Number(req.admin?.id);
    if (!adminId) return res.status(401).json({ error: "Unauthorized: admin ID missing" });

    const employees = await req.db.employee.findMany({
      where: { adminId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        joinedDate: true,
        baseSalary: true,
        overtimeRate: true,
        leaveBalance: true,
        status: true,
        officeId: true,
        adminId: true,
        accountNumber: true,
        ifscCode: true,
        office: true,
      },
      orderBy: { id: "asc" },
    });
    res.json(employees);
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch employees");
  }
};

// ✅ Get single employee by ID
export const getEmployeeById = async (req, res) => {
  try {
    const { id } = req.params;
    const employee = await req.db.employee.findFirst({
      where: { id: Number(id), adminId: Number(req.admin.id) },
    });

    if (!employee) return res.status(404).json({ error: "Employee not found in your organization" });

    res.json({message: `Employee fetched successfully: ${employee.name}`, data: {
      id: employee.id,
      name: employee.name,
      phone: employee.phone,
      email: employee.email,
      baseSalary: employee.baseSalary,
      overtimeRate: employee.overtimeRate,
      leaveBalance:employee.leaveBalance,
      joinedDate:employee.joinedDate,
      accountNumber:employee.accountNumber,
      ifscCode:employee.ifscCode
    } });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch employee");
  }
};

// ✅ Update Employee
export const updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = Number(req.admin.id); // from adminAuth middleware
    const { name, phone, email, password, baseSalary, overtimeRate, officeId,accountNumber,ifscCode } = req.body;

    const existingEmployee = await req.db.employee.findFirst({
      where: { id: Number(id), adminId }
    });
    if (!existingEmployee) {
      return res.status(404).json({ error: "Employee not found in your organization" });
    }

    if (officeId) {
      const office = await req.db.office.findFirst({
        where: { id: Number(officeId), adminId }
      });
      if (!office) {
        return res.status(400).json({ error: "Office not found or does not belong to your organization" });
      }
    }

    // H-06: Build the update payload from only the fields that were actually
    // provided. Previously every field was assigned unconditionally, so a
    // partial update (e.g. sending only some fields) would coerce missing
    // numeric fields via Number(undefined) === NaN and could corrupt salary /
    // overtime data. We now update a field only when it is present.
    const updateData = { adminId };
    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (accountNumber !== undefined) updateData.accountNumber = accountNumber;
    if (ifscCode !== undefined) updateData.ifscCode = ifscCode;

    if (baseSalary !== undefined) {
      const parsedBaseSalary = Number(baseSalary);
      if (Number.isNaN(parsedBaseSalary)) {
        return res.status(400).json({ error: "Invalid base salary" });
      }
      updateData.baseSalary = parsedBaseSalary;
    }

    if (overtimeRate !== undefined) {
      const parsedOvertimeRate = Number(overtimeRate);
      if (Number.isNaN(parsedOvertimeRate)) {
        return res.status(400).json({ error: "Invalid overtime rate" });
      }
      updateData.overtimeRate = parsedOvertimeRate;
    }

    if (officeId !== undefined) {
      updateData.officeId = Number(officeId);
    }

    // If password provided, hash it
    if (password) {
      updateData.password = await bcrypt.hash(password, 10);
    }

    const updatedEmployee = await req.db.employee.update({
      where: { id: existingEmployee.id },
      data: updateData,
    });

    res.json({ message: `Employee updated successfully: ${updatedEmployee.name}`, data: {
      id: updatedEmployee.id,
      name: updatedEmployee.name,
      phone: updatedEmployee.phone,
      email: updatedEmployee.email,
      baseSalary: updatedEmployee.baseSalary,
      overtimeRate: updatedEmployee.overtimeRate,
      accountNumber:updatedEmployee.accountNumber,
      ifscCode:updatedEmployee.ifscCode
    } });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to update employee");
  }
};

// update employee status (ACTIVE/INACTIVE)
export const updateEmployeeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!["ACTIVE", "INACTIVE"].includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const existingEmployee = await req.db.employee.findFirst({
      where: { id: Number(id), adminId: Number(req.admin.id) }
    });
    if (!existingEmployee) {
      return res.status(404).json({ error: "Employee not found in your organization" });
    }

    const updatedEmployee = await req.db.employee.update({
      where: { id: existingEmployee.id },
      data: { status },
    });
    res.json({ message: `Employee status updated to ${status} for: ${updatedEmployee.name}` });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to update employee status");
  }
};

// ✅ Delete Employee
export const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;

    const existingEmployee = await req.db.employee.findFirst({
      where: { id: Number(id), adminId: Number(req.admin.id) }
    });
    if (!existingEmployee) {
      return res.status(404).json({ error: "Employee not found in your organization" });
    }

    // CF-08: A hard delete would fail (FK constraint) or orphan payroll history
    // if the employee has any records. Block it and steer the admin to
    // deactivation, which preserves attendance/leave/transaction history.
    const [txnCount, attCount, leaveCount] = await Promise.all([
      req.db.transaction.count({ where: { empId: existingEmployee.id } }),
      req.db.attendance.count({ where: { empId: existingEmployee.id } }),
      req.db.leave.count({ where: { empId: existingEmployee.id } }),
    ]);

    if (txnCount > 0 || attCount > 0 || leaveCount > 0) {
      return res.status(400).json({
        error:
          "Cannot delete an employee who has attendance, leave, or transaction history. " +
          "Please deactivate the employee instead (this preserves their records).",
      });
    }

    await req.db.employee.delete({
      where: { id: existingEmployee.id },
    });

    res.json({ message: "Employee deleted successfully" });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to delete employee");
  }
};


//  Reset password with JWT (employee logged in)
export const resetPasswordWithJWT = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Both current and new password required" });
    }

    // M-05: Enforce a minimum password strength on the backend so it cannot be
    // bypassed by direct API calls that skip the client-side check.
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: "New password cannot be the same as the current password" });
    }

    // req.employee comes from employeeAuth middleware
    const employee = await req.db.employee.findUnique({
      where: { id: req.employee.id },
    });

    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const isPasswordValid = await bcrypt.compare(currentPassword, employee.password);
    if (!isPasswordValid) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await req.db.employee.update({
      where: { id: employee.id },
      data: { password: hashedPassword, passwordChangedAt: new Date() },
    });

    res.json({ message: "Password updated successfully" });
  } catch (error) {
    return sendApiError(res, error, 500, "Something went wrong");
  }
};

// ✅ Admin Reset Employee Password (Generates secure random password & returns to Admin)
export const adminResetEmployeePassword = async (req, res) => {
  try {
    const adminId = req.admin?.id;
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "Employee ID is required" });
    }

    // Verify employee belongs to this admin's organization
    const employee = await req.db.employee.findFirst({
      where: {
        id: Number(id),
        adminId: Number(adminId),
      },
    });

    if (!employee) {
      return res.status(404).json({ error: "Employee not found in your organization" });
    }

    // Generate a secure, unbiased, class-guaranteed temporary password.
    const temporaryPassword = generateTempPassword(12);

    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    await req.db.employee.update({
      where: { id: employee.id },
      data: { password: hashedPassword, passwordChangedAt: new Date() },
    });

    res.json({
      message: `Password reset successfully for ${employee.name}`,
      temporaryPassword,
      employee: {
        id: employee.id,
        name: employee.name,
        phone: employee.phone,
        email: employee.email,
      },
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to reset employee password");
  }
};

// Disabled unauthenticated phone reset for security (admins now reset employee passwords)
export const resetPasswordWithPhone = async (req, res) => {
  return res.status(403).json({
    error: "Direct password reset by phone is disabled for security. Please request your administrator to reset your password.",
  });
};

//  Get Employee by Phone (check if exists)
export const getEmployeeByPhone = async (req, res) => {
  try {
    const { phone } = req.params;

    if (!phone) {
      return res.status(400).json({ error: "Phone number required" });
    }

    const employee = await req.db.employee.findUnique({ where: { phone } });

    res.json({ employeeFound: !!employee });
  } catch (error) {
    return sendApiError(res, error, 500, "Something went wrong");
  }
};




// ✅ Helper: format only time in IST from UTC datetime
const formatTimeOnlyIST = (datetime) => {
  if (!datetime) return null;
  return moment.utc(datetime).tz("Asia/Kolkata").format("hh:mm A");
};

// ✅ Helper: format full datetime in IST
const formatDateTimeIST = (datetime) => {
  if (!datetime) return null;
  return moment.utc(datetime).tz("Asia/Kolkata").format("YYYY-MM-DD hh:mm A");
};

// ✅ Get Employee Dashboard Details
export const getEmployeeDashboard = async (req, res) => {
  try {
    const employeeId = req.employee.id;

    // Fetch employee with office details
    const employee = await req.db.employee.findUnique({
      where: { id: employeeId },
      include: { office: true },
    });

    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    // ✅ Get IST start & end of today, convert to UTC for DB query
    const todayStartUTC = moment.tz("Asia/Kolkata").startOf("day").utc().toDate();
    const todayEndUTC = moment.tz("Asia/Kolkata").endOf("day").utc().toDate();

    // ✅ Find today's attendance in UTC
    const attendance = await req.db.attendance.findFirst({
      where: {
        empId: employeeId,
        date: { gte: todayStartUTC, lte: todayEndUTC },
      },
    });

    // Check if office is finalized for today in IST
    const isOfficeFinalizedToday = (lastFinalized) => {
      if (!lastFinalized) return false;
      const lastFinalizedIST = moment.tz(lastFinalized, "Asia/Kolkata").format("YYYY-MM-DD");
      const todayDateIST = moment.tz("Asia/Kolkata").format("YYYY-MM-DD");
      return lastFinalizedIST === todayDateIST;
    };
    const isFinalized = isOfficeFinalizedToday(employee?.office?.lastFinalized);

    // ✅ Build response with IST conversion
    const response = {
      employeeDetails: {
        id: employee.id,
        name: employee.name,
        phone: employee.phone,
        email: employee.email,
        leaveBalance: employee.leaveBalance,
        joinedDate: formatDateTimeIST(employee.joinedDate), // IST
        baseSalary: employee.baseSalary,
        overtimeRate: employee.overtimeRate,
        checkinTime: attendance ? formatTimeOnlyIST(attendance.checkInTime) : null,
        checkoutTime: attendance ? formatTimeOnlyIST(attendance.checkOutTime) : null,
        status: attendance ? attendance.status : null,
        overtime: attendance ? attendance.overTime : null,
        isFinalized,
        accountNumber:employee.accountNumber,
        ifscCode:employee.ifscCode
      },
      officeDetails: {
        latitude: employee.office.latitude,
        longitude: employee.office.longitude,
        checkin: formatTimeOnlyIST(employee.office.checkin),
        checkout: formatTimeOnlyIST(employee.office.checkout),
        breakTime: employee.office.breakTime, // in minutes
        range:employee.office.range,
        isFinalized
      },
    };

    res.json(response);
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch dashboard details");
  }
};




// ✅ Update Employee
export const updateBankDetails = async (req, res) => {
  try {

      const employeeId = req.employee.id;
    const { accountNumber,ifscCode } = req.body;

    // M-06: Validate bank details before persisting. Invalid values would
    // otherwise be stored and cause downstream payment failures.
    if (!accountNumber || !ifscCode) {
      return res.status(400).json({ error: "Account number and IFSC code are required" });
    }

    const normalizedAccount = String(accountNumber).trim();
    const normalizedIfsc = String(ifscCode).trim().toUpperCase();

    if (!/^\d{9,18}$/.test(normalizedAccount)) {
      return res.status(400).json({ error: "Invalid account number. It must be 9 to 18 digits." });
    }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(normalizedIfsc)) {
      return res.status(400).json({ error: "Invalid IFSC code format." });
    }

    const updateData = {
      accountNumber: normalizedAccount,
      ifscCode: normalizedIfsc
    };



    const updatedEmployee = await req.db.employee.update({
      where: { id: Number(employeeId) },
      data: updateData,
    });

    res.json({ message: `Employee updated successfully: ${updatedEmployee.name} Bank Details`, data: {
      accountNumber:updatedEmployee.accountNumber,
      ifscCode:updatedEmployee.ifscCode
    } });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to update bank details");
  }
};