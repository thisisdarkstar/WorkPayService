import moment from "moment-timezone";

// Convert UTC date to IST string for display
const toISTString = (utcDate) =>
  moment.utc(utcDate).tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");

// Get current UTC time
const getCurrentUTC = () => new Date();

// Get start & end of a date in IST, converted to UTC for querying
const getISTRangeUTC = (date = new Date()) => {
  const start = moment.tz(date, "Asia/Kolkata").startOf("day");
  const end = moment.tz(date, "Asia/Kolkata").endOf("day");
  return { startUTC: start.utc().toDate(), endUTC: end.utc().toDate() };
};

// Calculate office checkin and checkout times for a specific date in IST, returned as UTC Date objects
const getOfficeShiftTimesUTC = (office, targetDateMomentIST) => {
  const checkinIST = moment.utc(office.checkin).tz("Asia/Kolkata");
  const checkoutIST = moment.utc(office.checkout).tz("Asia/Kolkata");

  const checkinTime = targetDateMomentIST
    .clone()
    .startOf("day")
    .hours(checkinIST.hour())
    .minutes(checkinIST.minute())
    .seconds(0);

  const checkoutTime = targetDateMomentIST
    .clone()
    .startOf("day")
    .hours(checkoutIST.hour())
    .minutes(checkoutIST.minute())
    .seconds(0);

  // If checkout is configured at an earlier hour than checkin (e.g. 20:00 to 04:00 overnight shift),
  // checkout is on the following day
  if (checkoutTime.isBefore(checkinTime)) {
    checkoutTime.add(1, "day");
  }

  return {
    checkinUTC: checkinTime.utc().toDate(),
    checkoutUTC: checkoutTime.utc().toDate(),
    checkinIST,
    checkoutIST,
  };
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
 * Smart Workday Windowing:
 * - If called between midnight (00:00) and office checkin time:
 *   - Detects that admin is finalizing yesterday's shift.
 *   - If yesterday is already finalized, informs admin that today's shift starts at hh:mm A.
 *   - If yesterday is not finalized, finalizes yesterday's shift without affecting today.
 * - If called after office checkin time:
 *   - Finalizes today's shift.
 * - Stores office.lastFinalized as the target shift date in IST (end of day UTC),
 *   ensuring today's morning shift remains completely open when yesterday is finalized overnight.
 */
export const finalizeOfficeAttendance = async (db, officeId, requestedDate = null) => {
  const nowUTC = getCurrentUTC();
  const nowIST = moment.tz(nowUTC, "Asia/Kolkata");
  const todayDateStr = nowIST.format("YYYY-MM-DD");

  const office = await db.office.findUnique({
    where: { id: Number(officeId) },
  });

  if (!office) {
    throw new Error(`Office with ID ${officeId} not found`);
  }

  // Get office shift timings for today in IST
  const todayShift = getOfficeShiftTimesUTC(office, nowIST);
  const shiftCheckinISTStr = todayShift.checkinIST.format("hh:mm A");

  let targetMomentIST;
  let isYesterdayFinalize = false;

  if (requestedDate) {
    targetMomentIST = moment.tz(requestedDate, "Asia/Kolkata");
    if (!targetMomentIST.isValid()) {
      return {
        success: false,
        skipped: true,
        reason: `Invalid requested date: ${requestedDate}. Expected format YYYY-MM-DD.`,
        officeId: office.id,
        officeName: office.name,
      };
    }
    // Prevent finalizing future dates
    if (targetMomentIST.clone().startOf("day").isAfter(nowIST.clone().startOf("day"))) {
      return {
        success: false,
        skipped: true,
        reason: `Cannot finalize attendance for a future date (${targetMomentIST.format("YYYY-MM-DD")}).`,
        officeId: office.id,
        officeName: office.name,
      };
    }
    // If requested date is today, check if shift has started
    if (targetMomentIST.format("YYYY-MM-DD") === todayDateStr && nowUTC < todayShift.checkinUTC) {
      return {
        success: false,
        skipped: true,
        reason: `Cannot finalize attendance before shift start time (${shiftCheckinISTStr} IST). The workday has not started yet.`,
        officeId: office.id,
        officeName: office.name,
      };
    }
  } else {
    // Smart Workday Windowing:
    // If current time is before today's shift check-in time (e.g. 00:00 to 08:00 AM IST):
    if (nowUTC < todayShift.checkinUTC) {
      const yesterdayMomentIST = nowIST.clone().subtract(1, "day");
      const yesterdayDateStr = yesterdayMomentIST.format("YYYY-MM-DD");

      const lastFinalizedIST = office.lastFinalized
        ? moment.tz(office.lastFinalized, "Asia/Kolkata").format("YYYY-MM-DD")
        : null;

      // If yesterday was ALREADY finalized, prevent early finalization of today
      if (lastFinalizedIST === yesterdayDateStr) {
        return {
          success: false,
          skipped: true,
          reason: `Yesterday (${yesterdayDateStr}) was already finalized, and today's shift starts at ${shiftCheckinISTStr} IST. Today's attendance cannot be finalized before shift starts.`,
          officeId: office.id,
          officeName: office.name,
        };
      }

      // Yesterday was NOT finalized! Finalize yesterday's shift
      targetMomentIST = yesterdayMomentIST;
      isYesterdayFinalize = true;
    } else {
      // Daytime / post-checkin finalization -> Target today
      targetMomentIST = nowIST;
    }
  }

  const targetDateISTStr = targetMomentIST.format("YYYY-MM-DD");

  // Check if target shift is already finalized
  if (office.lastFinalized) {
    const lastFinalizedIST = moment.tz(office.lastFinalized, "Asia/Kolkata").format("YYYY-MM-DD");
    if (lastFinalizedIST === targetDateISTStr) {
      return {
        success: false,
        skipped: true,
        reason: `Attendance for ${targetDateISTStr} has already been finalized.`,
        officeId: office.id,
        officeName: office.name,
      };
    }
  }

  const { startUTC: targetStartUTC, endUTC: targetEndUTC } = getISTRangeUTC(targetMomentIST.toDate());

  // Check if target date is a holiday
  const holidayOnTargetDate = await db.holiday.findFirst({
    where: {
      date: {
        gte: targetStartUTC,
        lte: targetEndUTC,
      },
    },
  });

  if (holidayOnTargetDate) {
    return {
      success: false,
      skipped: true,
      reason: `${targetDateISTStr} is a holiday: ${holidayOnTargetDate.description}`,
      officeId: office.id,
      officeName: office.name,
    };
  }

  // Calculate shift times for the target date
  const targetShift = getOfficeShiftTimesUTC(office, targetMomentIST);
  const officeCheckoutUTC = targetShift.checkoutUTC;

  // Timestamp to store as lastFinalized: end of target date in IST converted to UTC
  // This guarantees that in IST timezone, moment.tz(office.lastFinalized, "Asia/Kolkata").format("YYYY-MM-DD") === targetDateISTStr
  const targetFinalizedTimestamp = targetMomentIST.clone().endOf("day").utc().toDate();

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
      joinedDate: true,
    },
  });

  if (activeEmployees.length === 0) {
    await db.office.update({
      where: { id: office.id },
      data: { lastFinalized: targetFinalizedTimestamp },
    });
    return {
      success: true,
      message: `No active employees in office ${office.name}. Marked as finalized for ${targetDateISTStr}.`,
      officeId: office.id,
      officeName: office.name,
      clockedOutCount: 0,
      absentCount: 0,
      leaveCount: 0,
      date: targetDateISTStr,
    };
  }

  const employeeIds = activeEmployees.map((e) => e.id);

  let clockedOutCount = 0;
  let absentCount = 0;
  let leaveCount = 0;

  // Execute in a transaction for atomicity
  await db.$transaction(async (tx) => {
    // 1. Find employees who checked in on the target date but did not check out
    const pendingClockouts = await tx.attendance.findMany({
      where: {
        empId: { in: employeeIds },
        date: { gte: targetStartUTC, lt: targetEndUTC },
        checkInTime: { not: null },
        checkOutTime: null,
      },
    });

    for (const record of pendingClockouts) {
      // If finalizing after or at shift end, set checkout to shift end time (no false overtime)
      // If finalizing early during the shift, set checkout to nowUTC
      const autoCheckOutTime = nowUTC >= officeCheckoutUTC ? officeCheckoutUTC : nowUTC;

      await tx.attendance.update({
        where: { id: record.id },
        data: {
          checkOutTime: autoCheckOutTime,
          overTime: 0,
        },
      });
      clockedOutCount++;
    }

    // 2. Find employees who have NO attendance record at all on target date
    const existingRecords = await tx.attendance.findMany({
      where: {
        empId: { in: employeeIds },
        date: { gte: targetStartUTC, lt: targetEndUTC },
      },
      select: { empId: true },
    });

    const recordedEmpIds = new Set(existingRecords.map((r) => r.empId));
    const employeesWithoutRecord = activeEmployees.filter((e) => {
      if (recordedEmpIds.has(e.id)) return false;
      // Do not mark absent or penalize if employee's joined date is strictly after the target date
      if (e.joinedDate) {
        const empJoinedDay = moment.tz(e.joinedDate, "Asia/Kolkata").startOf("day");
        if (targetMomentIST.isBefore(empJoinedDay, "day")) return false;
      }
      return true;
    });

    // Calculate daily deduction amount based on days in target month
    const daysInMonth = targetMomentIST.daysInMonth();

    for (const emp of employeesWithoutRecord) {
      const hasApprovedLeave = await hasApprovedLeaveForDate(tx, emp.id, targetStartUTC);

      if (hasApprovedLeave) {
        await tx.attendance.create({
          data: {
            empId: emp.id,
            date: targetStartUTC,
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
            date: targetStartUTC,
            checkInTime: null,
            checkOutTime: null,
            overTime: 0,
            status: "ABSENT",
          },
        });
        absentCount++;

        // Add daily salary deduction transaction attributed to the target date
        const dailySalary = Math.round(emp.baseSalary / daysInMonth);
        if (dailySalary > 0) {
          await tx.transaction.create({
            data: {
              empId: emp.id,
              amount: dailySalary,
              payType: "DEDUCTION",
              description: `Salary deduction for absence on ${targetDateISTStr}`,
              date: targetStartUTC,
            },
          });
        }
      }
    }

    // 3. Update office lastFinalized timestamp to the target date's end-of-day
    await tx.office.update({
      where: { id: office.id },
      data: { lastFinalized: targetFinalizedTimestamp },
    });
  });

  const dateLabel = isYesterdayFinalize ? `yesterday (${targetDateISTStr})` : targetDateISTStr;

  return {
    success: true,
    message: `Attendance finalized for ${dateLabel} in ${office.name}. Clocked out ${clockedOutCount} employee(s), marked ${absentCount} absent, ${leaveCount} on leave.`,
    officeId: office.id,
    officeName: office.name,
    clockedOutCount,
    absentCount,
    leaveCount,
    date: targetDateISTStr,
    isYesterday: isYesterdayFinalize,
  };
};

/**
 * Check all offices and auto-finalize attendance if deadline has passed:
 * - If office has custom autoFinalizeTime configured: triggers at that time.
 * - Else: triggers at office.checkout + 3 hours (fallback safety feature).
 * - During overnight window (midnight to shift checkin), will safely auto-finalize yesterday's shift if unfinalized.
 */
export const checkAndRunAutoFinalize = async (db) => {
  try {
    const nowUTC = getCurrentUTC();
    const nowIST = moment.tz(nowUTC, "Asia/Kolkata");
    const todayIST = nowIST.format("YYYY-MM-DD");
    const yesterdayIST = nowIST.clone().subtract(1, "day").format("YYYY-MM-DD");

    const offices = await db.office.findMany({
      orderBy: { id: "asc" },
    });

    const results = [];

    for (const office of offices) {
      const shiftTimesToday = getOfficeShiftTimesUTC(office, nowIST);
      const isBeforeShiftToday = nowUTC < shiftTimesToday.checkinUTC;

      // Overnight window (between midnight and today's shift start):
      // Check if yesterday's shift was missed and needs auto-finalization
      if (isBeforeShiftToday) {
        const lastFinalizedIST = office.lastFinalized
          ? moment.tz(office.lastFinalized, "Asia/Kolkata").format("YYYY-MM-DD")
          : null;

        if (lastFinalizedIST !== yesterdayIST) {
          console.log(`[AutoFinalize] Overnight auto-finalize: finalizing yesterday's shift (${yesterdayIST}) for office "${office.name}" (ID: ${office.id})`);
          try {
            const res = await finalizeOfficeAttendance(db, office.id, yesterdayIST);
            results.push(res);
            console.log(`[AutoFinalize] Completed yesterday's finalization for "${office.name}":`, res.message);
          } catch (err) {
            console.error(`[AutoFinalize] Error auto-finalizing yesterday for office "${office.name}":`, err);
          }
        }
        continue;
      }

      // Normal daytime / evening check for today's shift:
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
          const res = await finalizeOfficeAttendance(db, office.id, todayIST);
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
