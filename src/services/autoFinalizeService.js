import moment from "moment-timezone";

// Convert UTC date to IST string for display
const toISTString = (utcDate) =>
  moment.utc(utcDate).tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");

// Get current UTC time
const getCurrentUTC = () => new Date();

// Get start & end of today in IST, converted to UTC for querying
const getISTRangeUTC = (date = new Date()) => {
  const start = moment.tz(date, "Asia/Kolkata").startOf("day");
  const end = moment.tz(date, "Asia/Kolkata").endOf("day");
  return { startUTC: start.utc().toDate(), endUTC: end.utc().toDate() };
};

// Convert stored office time to today's UTC time
const getTodayOfficeTimeUTC = (storedOfficeTime) => {
  const officeTimeIST = moment.utc(storedOfficeTime).tz("Asia/Kolkata");
  return moment.tz("Asia/Kolkata")
    .startOf("day")
    .hours(officeTimeIST.hour())
    .minutes(officeTimeIST.minute())
    .utc()
    .toDate();
};

// Check if employee has approved leave for a specific date
const hasApprovedLeaveForDate = async (db, empId, targetDateUTC) => {
  const leave = await db.leave.findFirst({
    where: {
      empId: empId,
      status: "APPROVED",
      fromDate: { lte: targetDateUTC },
      toDate: { gte: targetDateUTC }
    }
  });
  return leave !== null;
};

/**
 * Finalize attendance for a specific office.
 * 1. Clocks out any active employees who checked in but haven't clocked out.
 * 2. Marks any active employees who didn't check in as ABSENT (with salary deduction) or LEAVE.
 * 3. Updates office.lastFinalized to current timestamp.
 */
export const finalizeOfficeAttendance = async (db, officeId) => {
  const nowUTC = getCurrentUTC();
  const { startUTC: todayStartUTC, endUTC: todayEndUTC } = getISTRangeUTC(nowUTC);
  const todayIST = moment.utc(nowUTC).tz("Asia/Kolkata").format("YYYY-MM-DD");

  const office = await db.office.findUnique({
    where: { id: Number(officeId) },
  });

  if (!office) {
    throw new Error(`Office with ID ${officeId} not found`);
  }

  // Check if today is a holiday
  const holidayToday = await db.holiday.findFirst({
    where: {
      date: {
        gte: todayStartUTC,
        lte: todayEndUTC,
      },
    },
  });

  if (holidayToday) {
    return {
      success: false,
      skipped: true,
      reason: `Today (${todayIST}) is a holiday: ${holidayToday.description}`,
      officeId: office.id,
      officeName: office.name,
    };
  }

  // Calculate office shift timings for today in UTC
  const officeCheckinUTC = getTodayOfficeTimeUTC(office.checkin);
  const officeCheckoutUTC = getTodayOfficeTimeUTC(office.checkout);

  // Get all active employees in this office
  const activeEmployees = await db.employee.findMany({
    where: {
      officeId: office.id,
      status: "ACTIVE",
    },
    select: {
      id: true,
      name: true,
      baseSalary: true,
    },
  });

  if (activeEmployees.length === 0) {
    await db.office.update({
      where: { id: office.id },
      data: { lastFinalized: nowUTC },
    });
    return {
      success: true,
      message: `No active employees in office ${office.name}. Marked as finalized.`,
      officeId: office.id,
      officeName: office.name,
      clockedOutCount: 0,
      absentCount: 0,
      leaveCount: 0,
    };
  }

  const employeeIds = activeEmployees.map((e) => e.id);
  const empMap = new Map(activeEmployees.map((e) => [e.id, e]));

  let clockedOutCount = 0;
  let absentCount = 0;
  let leaveCount = 0;

  // Execute in a transaction for atomicity
  await db.$transaction(async (tx) => {
    // 1. Find employees who checked in but did not check out (forgot to clock out)
    const pendingClockouts = await tx.attendance.findMany({
      where: {
        empId: { in: employeeIds },
        date: { gte: todayStartUTC, lt: todayEndUTC },
        checkInTime: { not: null },
        checkOutTime: null,
      },
    });

    for (const record of pendingClockouts) {
      // Determine clock-out time:
      // If finalizing after or at shift end, set checkout to shift end time (officeCheckoutUTC) so no false overtime is granted.
      // If finalizing before shift end, set checkout to nowUTC.
      const autoCheckOutTime = nowUTC >= officeCheckoutUTC ? officeCheckoutUTC : nowUTC;

      await tx.attendance.update({
        where: { id: record.id },
        data: {
          checkOutTime: autoCheckOutTime,
          overTime: 0, // No overtime awarded if employee forgot to clock out
        },
      });
      clockedOutCount++;
    }

    // 2. Find employees who have NO attendance record at all today
    const existingRecords = await tx.attendance.findMany({
      where: {
        empId: { in: employeeIds },
        date: { gte: todayStartUTC, lt: todayEndUTC },
      },
      select: { empId: true },
    });

    const recordedEmpIds = new Set(existingRecords.map((r) => r.empId));
    const employeesWithoutRecord = activeEmployees.filter((e) => !recordedEmpIds.has(e.id));

    // Calculate daily deduction amount based on days in current month
    const daysInMonth = moment.tz(nowUTC, "Asia/Kolkata").daysInMonth();

    for (const emp of employeesWithoutRecord) {
      const hasApprovedLeave = await hasApprovedLeaveForDate(tx, emp.id, todayStartUTC);

      if (hasApprovedLeave) {
        await tx.attendance.create({
          data: {
            empId: emp.id,
            date: todayStartUTC,
            checkInTime: null,
            checkOutTime: null,
            overTime: 0,
            status: "LEAVE",
          },
        });
        leaveCount++;
      } else {
        await tx.attendance.create({
          data: {
            empId: emp.id,
            date: todayStartUTC,
            checkInTime: null,
            checkOutTime: null,
            overTime: 0,
            status: "ABSENT",
          },
        });
        absentCount++;

        // Add daily salary deduction transaction
        const dailySalary = Math.round(emp.baseSalary / daysInMonth);
        if (dailySalary > 0) {
          await tx.transaction.create({
            data: {
              empId: emp.id,
              amount: dailySalary,
              payType: "DEDUCTION",
              description: `Salary deduction for absence on ${todayIST}`,
              date: nowUTC,
            },
          });
        }
      }
    }

    // 3. Update office lastFinalized timestamp
    await tx.office.update({
      where: { id: office.id },
      data: { lastFinalized: nowUTC },
    });
  });

  return {
    success: true,
    message: `Attendance finalized for ${office.name}. Clocked out ${clockedOutCount} employee(s), marked ${absentCount} absent, ${leaveCount} on leave.`,
    officeId: office.id,
    officeName: office.name,
    clockedOutCount,
    absentCount,
    leaveCount,
    date: todayIST,
  };
};

/**
 * Check all offices and auto-finalize attendance if deadline has passed:
 * - If office has custom autoFinalizeTime configured: triggers at that time.
 * - Else: triggers at office.checkout + 3 hours (fallback safety feature).
 */
export const checkAndRunAutoFinalize = async (db) => {
  try {
    const nowUTC = getCurrentUTC();
    const nowIST = moment.tz(nowUTC, "Asia/Kolkata");
    const todayIST = nowIST.format("YYYY-MM-DD");

    const offices = await db.office.findMany({
      orderBy: { id: "asc" },
    });

    const results = [];

    for (const office of offices) {
      // Check if already finalized today in IST
      if (office.lastFinalized) {
        const lastFinalizedIST = moment.utc(office.lastFinalized).tz("Asia/Kolkata").format("YYYY-MM-DD");
        if (lastFinalizedIST === todayIST) {
          continue; // Already finalized for today
        }
      }

      // Determine target auto-finalize time for today in IST
      let targetIST;
      if (office.autoFinalizeTime) {
        const configuredIST = moment.utc(office.autoFinalizeTime).tz("Asia/Kolkata");
        targetIST = nowIST.clone().hour(configuredIST.hour()).minute(configuredIST.minute()).second(0);
      } else {
        // Fallback default: office shift end time + 3 hours
        const checkoutIST = moment.utc(office.checkout).tz("Asia/Kolkata");
        targetIST = nowIST.clone().hour(checkoutIST.hour()).minute(checkoutIST.minute()).second(0).add(3, "hours");
      }

      // If current time is equal to or past the target auto-finalize time, run finalization
      if (nowIST.isSameOrAfter(targetIST)) {
        console.log(`[AutoFinalize] Auto-finalizing attendance for office "${office.name}" (ID: ${office.id}) at ${nowIST.format("YYYY-MM-DD HH:mm:ss")}`);
        try {
          const res = await finalizeOfficeAttendance(db, office.id);
          results.push(res);
          console.log(`[AutoFinalize] Completed for "${office.name}":`, res.message);
        } catch (err) {
          console.error(`[AutoFinalize] Error auto-finalizing for office "${office.name}":`, err);
        }
      }
    }

    return results;
  } catch (error) {
    console.error("[AutoFinalize] Error running auto-finalize check:", error);
    return [];
  }
};
