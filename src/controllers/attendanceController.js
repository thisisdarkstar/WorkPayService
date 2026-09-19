import moment from "moment-timezone";
import { finalizeOfficeAttendance, checkAndRunAutoFinalize } from "../services/autoFinalizeService.js";
import { sendApiError } from "../utils/errorHandler.js";
import logger from "../utils/logger.js";

// Convert UTC date to IST string for response
const toISTString = (utcDate) =>
  moment.utc(utcDate).tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");

// Get current UTC time
const getCurrentUTC = () => new Date();

// Haversine distance (in meters) between two lat/lng coordinates.
// Used for SERVER-SIDE geofence enforcement so a spoofed/modified client
// cannot mark attendance from outside the office perimeter.
const distanceInMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// Validates the client-supplied location against the office geofence.
// Returns { ok: true } when inside range, or { ok: false, message } otherwise.
const validateGeofence = (location, office) => {
  const lat = Number(location?.latitude);
  const lon = Number(location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, message: "Location is required to mark attendance. Please enable location and try again." };
  }

  const range = Number(office?.range);
  if (!Number.isFinite(range) || range <= 0) {
    return { ok: false, message: "Office geofence is not configured. Please contact your administrator." };
  }

  const distance = distanceInMeters(lat, lon, office.latitude, office.longitude);
  if (distance > range) {
    return {
      ok: false,
      message: `You must be within ${range} meters of the office to mark attendance. You are approximately ${Math.round(distance)} meters away.`,
    };
  }

  return { ok: true };
};

// Get start & end of today in IST, converted to UTC for querying
const getISTRangeUTC = (date = new Date()) => {
  const start = moment.tz(date, "Asia/Kolkata").startOf("day");
  const end = moment.tz(date, "Asia/Kolkata").endOf("day");
  return { startUTC: start.utc().toDate(), endUTC: end.utc().toDate() };
};

// Helper: Convert stored office time to today's UTC time
const getTodayOfficeTimeUTC = (storedOfficeTime) => {
  // Extract IST hours and minutes from stored UTC time
  const officeTimeIST = moment.utc(storedOfficeTime).tz("Asia/Kolkata");
  
  // Create today's date with those hours/minutes in IST, then convert to UTC
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

// Attendance Check-In / Check-Out
export const handleAttendance = async (req, res) => {
  try {
    const employeeId = req.employee.id;
    const { type, location } = req.body;
    if (!employeeId || !type)
      return res.status(400).json({ error: "employeeId and type are required" });

    const nowUTC = getCurrentUTC();
    const { startUTC: todayStartUTC, endUTC: todayEndUTC } = getISTRangeUTC(nowUTC);

    const employee = await req.db.employee.findUnique({
      where: { id: Number(employeeId) },
      select: { id: true, name: true, status: true , officeId: true },
    });

    // Fetch office timings
    const office = await req.db.office.findFirst({
      where: { id: employee.officeId }
    });
    if (!office) return res.status(404).json({ error: "Office details not found" });

    // 🛡️ SERVER-SIDE GEOFENCE ENFORCEMENT (SEC-002)
    // The client also checks distance, but that is advisory only. A modified
    // client or spoofed GPS could bypass it, so we re-validate here against the
    // office's authoritative coordinates and radius before recording anything.
    const geofence = validateGeofence(location, office);
    if (!geofence.ok) {
      return res.status(403).json({ error: geofence.message });
    }

    // Convert stored office times to today's UTC times
    
    const officeCheckinUTC = getTodayOfficeTimeUTC(office.checkin);
    const officeCheckoutUTC = getTodayOfficeTimeUTC(office.checkout);

    // Debug logs to verify office times

    // Check if office attendance is already finalized for today in IST
    if (office.lastFinalized) {
      const lastFinalizedIST = moment.tz(office.lastFinalized, "Asia/Kolkata").format("YYYY-MM-DD");
      const todayDateIST = moment.tz("Asia/Kolkata").format("YYYY-MM-DD");
      if (lastFinalizedIST === todayDateIST) {
        return res.status(400).json({ message: "Attendance for today has already been finalized by office administration." });
      }
    }

    // Fetch today's attendance
    let attendance = await req.db.attendance.findFirst({
      where: {
        empId: Number(employeeId),
        date: { gte: todayStartUTC, lt: todayEndUTC },
      },
    });

    if (type === "checkin") {
      if (attendance) {
        if (attendance.status === "ABSENT") {
          return res.status(400).json({ message: "Attendance for today was already marked as absent." });
        }
        if (attendance.status === "LEAVE") {
          return res.status(400).json({ message: "You are on approved leave for today." });
        }
        return res.status(400).json({ message: `Employee already checked in today` });
      }

      // Calculate late threshold (30 minutes after office checkin)
      const lateThresholdUTC = new Date(officeCheckinUTC.getTime() + 30 * 60 * 1000);
      const status = nowUTC <= lateThresholdUTC ? "PRESENT" : "LATE";

      attendance = await req.db.attendance.create({
        data: {
          date: todayStartUTC,
          checkInTime: nowUTC,
          checkOutTime: null,
          overTime: 0,
          status,
          employee: { connect: { id: Number(employeeId) } },
        },
      });

      return res.status(200).json({
        message: `Check-in ${status} at ${toISTString(nowUTC)}`,
        attendance: {
          ...attendance,
          date: toISTString(attendance.date),
          checkInTime: toISTString(attendance.checkInTime),
        },
      });
    }

    if (type === "checkout") {
      if (!attendance || !attendance.checkInTime) {
        return res.status(400).json({ message: "No active check-in found for today" });
      }
      if (attendance.checkOutTime) {
        return res.status(400).json({ message: "Employee already checked out today", attendance });
      }

      const employee = await req.db.employee.findUnique({
        where: { id: Number(employeeId) },
        select: { overtimeRate: true },
      });
      if (!employee) return res.status(404).json({ error: "Employee not found" });

      // Calculate worked minutes
      const totalWorkedMinutes = Math.floor((nowUTC - attendance.checkInTime) / (1000 * 60));
      const totalOfficeMinutes = Math.floor((officeCheckoutUTC - officeCheckinUTC) / (1000 * 60));
      const overtimeMinutes = totalWorkedMinutes > totalOfficeMinutes ? totalWorkedMinutes - totalOfficeMinutes : 0;

      // H-03: Perform the checkout update and the overtime payout in a single
      // atomic transaction. Previously these were two separate writes, so a
      // crash between them could leave the shift closed with no overtime
      // transaction, silently losing the employee's earned overtime pay.
      const overtimeHours = overtimeMinutes / 60;
      const overtimePay = overtimeMinutes > 0 ? overtimeHours * employee.overtimeRate : 0;

      attendance = await req.db.$transaction(async (tx) => {
        const updated = await tx.attendance.update({
          where: { id: attendance.id },
          data: { checkOutTime: nowUTC, overTime: overtimeMinutes, employee: { connect: { id: Number(employeeId) } } },
        });

        if (overtimeMinutes > 0) {
          await tx.transaction.create({
            data: {
              empId: Number(employeeId),
              amount: overtimePay,
              payType: "OVERTIME",
              description: `Overtime payment for ${overtimeHours.toFixed(2)} hr(s) on ${toISTString(nowUTC).split(" ")[0]}`,
              date: nowUTC,
            },
          });
        }

        return updated;
      });

      return res.json({
        message: `Check-out done at ${toISTString(nowUTC)}`,
        attendance: {
          ...attendance,
          date: toISTString(attendance.date),
          checkInTime: toISTString(attendance.checkInTime),
          checkOutTime: toISTString(attendance.checkOutTime),
        },
      });
    }

    res.status(400).json({ error: "Invalid type. Use 'checkin' or 'checkout'." });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to handle attendance");
  }
};


// ✅ Get all attendance for an employee by month & year (IST-aware)
export const getEmployeeAttendanceByMonth = async (req, res) => {
  try {
    const empId = req.employee.id;
    const { month, year } = req.query;

    if (!empId || !month || !year) {
      return res.status(400).json({ error: "empId, month, and year are required" });
    }

    // Format month and year properly with padding
    const paddedMonth = month.toString().padStart(2, '0');
    
    // Create date string in ISO format
    const dateString = `${year}-${paddedMonth}-01T00:00:00+05:30`;

    // Get current date in IST
    const currentDateIST = moment.tz("Asia/Kolkata");
    const currentMonth = currentDateIST.month() + 1; // moment months are 0-indexed
    const currentYear = currentDateIST.year();

    // Check if requested month/year is current month/year
    const isCurrentMonth = (Number(month) === currentMonth && Number(year) === currentYear);

    // 1. Compute IST month start and end
    const monthStartIST = moment.tz(dateString, "Asia/Kolkata").startOf("month");
    let monthEndIST = monthStartIST.clone().endOf("month");

    // If it's current month, limit end date to today
    if (isCurrentMonth) {
      const todayEndIST = currentDateIST.clone().endOf("day");
      monthEndIST = todayEndIST; // Use today's end instead of month end
    }

    // 2. Convert to UTC for querying
    const monthStartUTC = monthStartIST.utc().toDate();
    const monthEndUTC = monthEndIST.utc().toDate();


    // 3. Fetch attendance records
    const attendanceRecords = await req.db.attendance.findMany({
      where: {
        empId: Number(empId),
        date: {
          gte: monthStartUTC,
          lte: monthEndUTC,
        },
      },
      orderBy: { date: "desc" },
    });

    // 4. Convert all dates to IST for response
    const attendanceRecordsIST = attendanceRecords.map((record) => ({
      ...record,
      date: toISTString(record.date),
      checkInTime: record.checkInTime ? toISTString(record.checkInTime) : null,
      checkOutTime: record.checkOutTime ? toISTString(record.checkOutTime) : null
    }));

    const responseMessage = isCurrentMonth 
      ? `Attendance for current month (${year}-${paddedMonth}) from start of month to today`
      : `Attendance for ${year}-${paddedMonth}`;

    res.json({ 
      month, 
      year, 
      isCurrentMonth,
      message: responseMessage,
      attendanceRecords: attendanceRecordsIST 
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch employee attendance");
  }
};




// ✅ Dashboard Attendance API (IST-aware with Office filtering and "all" support)
export const getTodayAttendanceDashboard = async (req, res) => {
  try {
    // Opportunistically run auto-finalize check in background if any office deadline passed.
    // M-13: Scope to the requesting admin's offices so one admin's dashboard visit
    // does not trigger finalization work across other admins' offices.
    checkAndRunAutoFinalize(req.db, req.admin?.id).catch(err => logger.error('[AutoFinalize Background Error]', { error: err?.message, stack: err?.stack }));

    let targetOfficeId;
    let isAllOffices = false;
    const { officeId } = req.params;
    
    // 1. Get current IST date and create UTC range for today IST
    const currentIST = moment.tz("Asia/Kolkata");
    const todayISTDateString = currentIST.format("YYYY-MM-DD");
    
    // Create today's IST day boundaries and convert to UTC for DB query
    const todayStartIST = moment.tz(todayISTDateString + " 00:00:00", "Asia/Kolkata");
    const todayEndIST = moment.tz(todayISTDateString + " 23:59:59", "Asia/Kolkata");
    
    const todayStartUTC = todayStartIST.utc().toDate();
    const todayEndUTC = todayEndIST.utc().toDate();
    
    console.log("Current IST:", currentIST.format("YYYY-MM-DD HH:mm:ss"));
    console.log("Today IST date:", todayISTDateString);
    console.log("IST Start:", todayStartIST.tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss"));
    console.log("IST End:", todayEndIST.tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss"));
    console.log("UTC Start:", todayStartUTC);
    console.log("UTC End:", todayEndUTC);
    console.log("Received officeId param:", officeId);

    // 2. Determine target office or all offices
    if (officeId === undefined) {
      return res.status(400).json({ error: "officeId parameter is required" });
    }
    
    if (officeId === "all") {
      // Handle "all" offices case
      isAllOffices = true;
    } else {
      // Use the provided officeId
      targetOfficeId = Number(officeId);
      
      // Verify office exists and belongs to this admin
      const officeExists = await req.db.office.findFirst({
        where: { id: targetOfficeId, adminId: Number(req.admin.id) },
      });
      
      if (!officeExists) {
        return res.status(404).json({ error: "Office not found or unauthorized" });
      }
    }

    // 3. Get employees based on office selection
    let employeeIds;
    let officeDetails;

    const adminId = Number(req.admin.id);

    if (isAllOffices) {
      // Get all active employees from all offices belonging to this admin
      const allEmployees = await req.db.employee.findMany({
        where: { 
          status: 'ACTIVE',
          adminId
        },
        select: { id: true }
      });
      
      employeeIds = allEmployees.map(emp => emp.id);
      officeDetails = { id: "all", name: "All Offices" };
    } else {
      // Get employees for specific office belonging to this admin
      const officeEmployees = await req.db.employee.findMany({
        where: { 
          officeId: targetOfficeId,
          status: 'ACTIVE',
          adminId
        },
        select: { id: true }
      });
      
      employeeIds = officeEmployees.map(emp => emp.id);
      
      // Get office details for response (already verified above)
      officeDetails = await req.db.office.findFirst({
        where: { id: targetOfficeId, adminId },
        select: { id: true, name: true }
      });
      
      if (!officeDetails) {
        return res.status(404).json({ error: "Office not found" });
      }
    }

    // ---- Total Employees ----
    const totalEmployees = employeeIds.length;

    // ---- Attendance Today (group by status) ----
    const attendanceToday = await req.db.attendance.groupBy({
      by: ["status"],
      where: {
        empId: { in: employeeIds },
        date: {
          gte: todayStartUTC,
          lte: todayEndUTC,
        },
      },
      _count: {
        status: true,
      },
    });

    // Convert groupBy result into {status: count}
    const counts = attendanceToday.reduce((acc, row) => {
      acc[row.status] = row._count.status;
      return acc;
    }, {});

    const totalLate = counts["LATE"] || 0;
    const totalPresent = counts["PRESENT"] || 0;
    const totalAbsent = counts["ABSENT"] || 0;
    // ATT-03: surface leave & holiday counts too, so the admin sees a complete
    // picture of where every employee is today (present/late/absent/leave/holiday).
    const totalLeave = counts["LEAVE"] || 0;
    const totalHoliday = counts["HOLIDAY"] || 0;

    // ---- Absent Employees List ----
    const absentees = await req.db.attendance.findMany({
      where: {
        status: "ABSENT",
        empId: { in: employeeIds },
        date: {
          gte: todayStartUTC,
          lte: todayEndUTC,
        },
      },
      select: {
        employee: {
          select: { id: true, name: true },
        },
      },
    });

    const absentList = absentees.map(a => ({
      id: a.employee.id,
      name: a.employee.name,
    }));

    // ---- Get all offices belonging to THIS admin ----
    const offices = await req.db.office.findMany({
      where: { adminId },
      orderBy: { id: "asc" }
    });

    // ---- Prepare response based on office selection ----
    const response = {
      date: todayISTDateString,
      office: officeDetails,
      totalEmployees,
      totalLate,
      totalPresent,
      totalAbsent,
      totalLeave,
      totalHoliday,
      absentList,
      offices
    };

    // ---- Pending Leaves (for all branches or selected office) ----
    const pendingLeaves = await req.db.leave.findMany({
      where: { 
        status: "PENDING",
        empId: { in: employeeIds }
      },
      orderBy: { applyDate: "desc" },
      take: 10,
      include: {
        employee: { select: { id: true, name: true } },
      },
    });

    response.pendingLeaves = pendingLeaves;

    // ---- Final Response ----
    res.json(response);
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch dashboard attendance");
  }
};
 

// ✅ Admin: Get all attendance for an employee by month & year (IST-aware)
export const getEmployeeAttendanceByMonthInAdmin = async (req, res) => {
  try {
    const { month, year, empId } = req.query;

    if (!empId || !month || !year) {
      return res.status(400).json({ error: "empId, month, and year are required" });
    }

    // Verify employee belongs to requesting admin
    const emp = await req.db.employee.findFirst({
      where: { id: Number(empId), adminId: Number(req.admin.id) }
    });
    if (!emp) {
      return res.status(404).json({ error: "Employee not found in your organization" });
    }

    // Format month and year properly with padding
    const paddedMonth = month.toString().padStart(2, '0');
    
    // Create date string in ISO format
    const dateString = `${year}-${paddedMonth}-01T00:00:00+05:30`;

    // Get current date in IST
    const currentDateIST = moment.tz("Asia/Kolkata");
    const currentMonth = currentDateIST.month() + 1; // moment months are 0-indexed
    const currentYear = currentDateIST.year();

    // Check if requested month/year is current month/year
    const isCurrentMonth = (Number(month) === currentMonth && Number(year) === currentYear);

    // 1. Compute IST month start and end
    const monthStartIST = moment.tz(dateString, "Asia/Kolkata").startOf("month");
    let monthEndIST = monthStartIST.clone().endOf("month");

    // If it's current month, limit end date to today
    if (isCurrentMonth) {
      const todayEndIST = currentDateIST.clone().endOf("day");
      monthEndIST = todayEndIST; // Use today's end instead of month end
    }

    // 2. Convert to UTC for querying
    const monthStartUTC = monthStartIST.utc().toDate();
    const monthEndUTC = monthEndIST.utc().toDate();

    // 3. Fetch attendance records
    const attendanceRecords = await req.db.attendance.findMany({
      where: {
        empId: Number(empId),
        date: {
          gte: monthStartUTC,
          lte: monthEndUTC,
        },
      },
      orderBy: { date: "desc" },
    });

    // 4. Convert all dates to IST for response
    const attendanceRecordsIST = attendanceRecords.map((record) => ({
      ...record,
      date: toISTString(record.date),
      checkInTime: record.checkInTime ? toISTString(record.checkInTime) : null,
      checkOutTime: record.checkOutTime ? toISTString(record.checkOutTime) : null
    }));

    res.json({ month, year, attendanceRecords: attendanceRecordsIST });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch employee attendance");
  }
};



// Main controller: Mark attendance for absent employees / Finalize attendance (Office-specific)
// - Clocks out employees who checked in but haven't clocked out yet
// - Marks unclocked employees as ABSENT (with salary deduction) or LEAVE
// - Updates office.lastFinalized
export const markAttendanceForAbsentEmployees = async (req, res) => {
  try {
    let targetOfficeId;
    const { officeId } = req.params;

    if (officeId !== undefined) {
      targetOfficeId = Number(officeId);
      const officeExists = await req.db.office.findFirst({
        where: { id: targetOfficeId, adminId: Number(req.admin.id) },
        select: { id: true, name: true }
      });
      if (!officeExists) {
        return res.status(404).json({ error: "Office not found or unauthorized" });
      }
    } else {
      const firstOffice = await req.db.office.findFirst({
        where: { adminId: Number(req.admin.id) },
        orderBy: { id: 'asc' },
        select: { id: true, name: true }
      });
      if (!firstOffice) {
        return res.status(404).json({ error: "No offices found for your account" });
      }
      targetOfficeId = firstOffice.id;
    }

    const targetDate = req.body?.date || req.query?.date || null;
    const result = await finalizeOfficeAttendance(req.db, targetOfficeId, targetDate);

    if (result.skipped) {
      return res.status(400).json({
        error: result.reason,
        message: result.reason,
        officeId: targetOfficeId
      });
    }

    res.json({
      message: result.message,
      date: result.date,
      officeId: result.officeId,
      clockedOutCount: result.clockedOutCount,
      absentCount: result.absentCount,
      leaveCount: result.leaveCount,
      attendanceComplete: true
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to finalize attendance");
  }
};



// Check if bulk attendance marking is already done for today (Office-specific for UI button state)
export const checkBulkAttendanceStatus = async (req, res) => {
  try {
    const nowUTC = getCurrentUTC();
    const { startUTC: todayStartUTC, endUTC: todayEndUTC } = getISTRangeUTC(nowUTC);
    const todayIST = moment.utc(nowUTC).tz("Asia/Kolkata").format("YYYY-MM-DD");

    let targetOfficeId;
    const { officeId } = req.params;
    
    if (officeId !== undefined) {
      targetOfficeId = Number(officeId);
      const officeExists = await req.db.office.findFirst({
        where: { id: targetOfficeId, adminId: Number(req.admin.id) },
        select: { id: true, name: true }
      });
      if (!officeExists) {
        return res.status(404).json({ error: "Office not found or unauthorized" });
      }
    } else {
      const firstOffice = await req.db.office.findFirst({
        where: { adminId: Number(req.admin.id) },
        orderBy: { id: 'asc' },
        select: { id: true, name: true }
      });
      if (!firstOffice) {
        return res.status(404).json({ error: "No offices found for your account" });
      }
      targetOfficeId = firstOffice.id;
    }

    // Get office details
    const officeDetails = await req.db.office.findFirst({
      where: { id: targetOfficeId, adminId: Number(req.admin.id) },
      select: { 
        id: true, 
        name: true,
        checkin: true,
        checkout: true,
        autoFinalizeTime: true,
        lastFinalized: true
      }
    });

    // Get all active employees for the target office belonging to this admin
    const officeEmployees = await req.db.employee.findMany({
      where: { 
        officeId: targetOfficeId,
        adminId: Number(req.admin.id),
        status: 'ACTIVE'
      },
      select: { id: true }
    });

    const employeeIds = officeEmployees.map(emp => emp.id);
    const totalEmployeesInOffice = employeeIds.length;

    // Check if attendance is finalized for today (based on lastFinalized date in IST)
    let isCompleted = false;
    if (officeDetails?.lastFinalized) {
      const lastFinalizedIST = moment.utc(officeDetails.lastFinalized).tz("Asia/Kolkata").format("YYYY-MM-DD");
      if (lastFinalizedIST === todayIST) {
        isCompleted = true;
      }
    }

    if (employeeIds.length === 0) {
      return res.json({
        date: todayIST,
        office: officeDetails,
        isBulkMarkingCompleted: isCompleted,
        totalEmployees: 0,
        totalAttendanceToday: 0,
        remainingEmployees: 0,
        pendingClockouts: 0,
        message: "No active employees in this office"
      });
    }

    // Attendance stats
    const attendanceStats = await req.db.attendance.groupBy({
      by: ["status"],
      where: {
        empId: { in: employeeIds },
        date: {
          gte: todayStartUTC,
          lt: todayEndUTC,
        },
      },
      _count: {
        status: true,
      },
    });

    const stats = {
      PRESENT: 0,
      ABSENT: 0,
      LATE: 0,
      LEAVE: 0,
      HOLIDAY: 0
    };

    attendanceStats.forEach(stat => {
      stats[stat.status] = stat._count.status;
    });

    // ATT-05: include HOLIDAY so employees with a holiday record are counted as
    // "recorded" and don't inflate the pending/remaining count on holidays.
    const totalRecorded = stats.PRESENT + stats.ABSENT + stats.LATE + stats.LEAVE + stats.HOLIDAY;
    const remainingEmployees = totalEmployeesInOffice - totalRecorded;

    // Count pending clockouts
    const pendingClockouts = await req.db.attendance.count({
      where: {
        empId: { in: employeeIds },
        date: { gte: todayStartUTC, lt: todayEndUTC },
        checkInTime: { not: null },
        checkOutTime: null
      }
    });

    const autoFinalizeDisplay = officeDetails.autoFinalizeTime
      ? moment.utc(officeDetails.autoFinalizeTime).tz("Asia/Kolkata").format("hh:mm A")
      : moment.utc(officeDetails.checkout).tz("Asia/Kolkata").add(3, "hours").format("hh:mm A") + " (Shift End + 3h)";

    res.json({
      date: todayIST,
      office: officeDetails,
      isBulkMarkingCompleted: isCompleted,
      totalEmployees: totalEmployeesInOffice,
      totalAttendanceToday: totalRecorded,
      remainingEmployees: remainingEmployees,
      pendingClockouts: pendingClockouts,
      autoFinalizeTime: officeDetails.autoFinalizeTime,
      autoFinalizeDisplay: autoFinalizeDisplay,
      message: isCompleted 
        ? `Attendance already finalized for ${officeDetails.name}`
        : `${remainingEmployees} pending check-in, ${pendingClockouts} pending clock-out in ${officeDetails.name}`
    });

  } catch (error) {
    return sendApiError(res, error, 500, "Failed to check bulk attendance status");
  }
};

// Cron auto-finalize handler (invoked by scheduler or Vercel Cron)
// SECURITY (C-01): This endpoint triggers bulk attendance finalization across
// all offices, which creates ABSENT records and salary DEDUCTION transactions.
// It must never be publicly callable. Vercel Cron sends the configured
// CRON_SECRET as a Bearer token; we require it (and also accept the same value
// via an x-cron-secret header for non-Vercel schedulers).
export const cronAutoFinalize = async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      // Fail closed: without a configured secret we refuse to run rather than
      // leaving the endpoint open to anonymous callers.
      return res.status(503).json({ error: "Cron secret is not configured on the server." });
    }

    const authHeader = req.headers["authorization"] || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const headerSecret = req.headers["x-cron-secret"];
    const providedSecret = bearerToken || headerSecret;

    if (providedSecret !== cronSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const results = await checkAndRunAutoFinalize(req.db);
    res.json({
      message: "Auto-finalize check completed",
      processedCount: results.length,
      results
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to execute auto-finalize check");
  }
};



// ✅ Get Employees by Attendance Status for Today
export const getEmployeesByAttendanceStatus = async (req, res) => {
  try {
    const { officeId, status } = req.params;

    console.log(officeId,status)

    // Validate status parameter
    // ATT-04: allow drilling into LEAVE and HOLIDAY cohorts too, not just
    // PRESENT/ABSENT/LATE, so the admin can list every status shown on the dashboard.
    const validStatuses = ["PRESENT", "ABSENT", "LATE", "LEAVE", "HOLIDAY"];
    if (!status || !validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ 
        error: "Invalid status. Must be one of: PRESENT, ABSENT, LATE, LEAVE, HOLIDAY" 
      });
    }

    const attendanceStatus = status.toUpperCase();

    // Validate officeId parameter
    if (!officeId) {
      return res.status(400).json({ error: "officeId parameter is required" });
    }

    // 1. Get current IST date and create UTC range for today IST
    const currentIST = moment.tz("Asia/Kolkata");
    const todayISTDateString = currentIST.format("YYYY-MM-DD");
    
    // Create today's IST day boundaries and convert to UTC for DB query
    const todayStartIST = moment.tz(todayISTDateString + " 00:00:00", "Asia/Kolkata");
    const todayEndIST = moment.tz(todayISTDateString + " 23:59:59", "Asia/Kolkata");
    
    const todayStartUTC = todayStartIST.utc().toDate();
    const todayEndUTC = todayEndIST.utc().toDate();
    
    console.log("Current IST:", currentIST.format("YYYY-MM-DD HH:mm:ss"));
    console.log("Fetching employees with status:", attendanceStatus);
    console.log("Received officeId param:", officeId);

    // 2. Determine target office or all offices
    let isAllOffices = false;
    let targetOfficeId;
    let employeeIds;
    let officeDetails;
    const adminId = Number(req.admin.id);

    if (officeId === "all") {
      isAllOffices = true;
      
      // Get all active employees from all offices belonging to THIS admin
      const allEmployees = await req.db.employee.findMany({
        where: { 
          status: 'ACTIVE',
          adminId
        },
        select: { id: true }
      });
      
      employeeIds = allEmployees.map(emp => emp.id);
      officeDetails = { id: "all", name: "All Offices" };
    } else {
      // Use the provided officeId
      targetOfficeId = Number(officeId);
      
      // Verify office exists and belongs to THIS admin
      const officeExists = await req.db.office.findFirst({
        where: { id: targetOfficeId, adminId },
      });
      
      if (!officeExists) {
        return res.status(404).json({ error: "Office not found or unauthorized" });
      }

      // Get employees for specific office belonging to THIS admin
      const officeEmployees = await req.db.employee.findMany({
        where: { 
          officeId: targetOfficeId,
          status: 'ACTIVE',
          adminId
        },
        select: { id: true }
      });
      
      employeeIds = officeEmployees.map(emp => emp.id);
      
      // Get office details for response
      officeDetails = await req.db.office.findFirst({
        where: { id: targetOfficeId, adminId },
        select: { id: true, name: true }
      });
    }

    // 3. Get attendance records for today with the specified status
    const statusCondition = attendanceStatus === "PRESENT" ? { in: ["PRESENT", "LATE"] } : attendanceStatus;

    const attendanceRecords = await req.db.attendance.findMany({
      where: {
        status: statusCondition,
        empId: { in: employeeIds },
        date: {
          gte: todayStartUTC,
          lte: todayEndUTC,
        },
      },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            office: {
              select: {
                id: true,
                name: true
              }
            }
          }
        }
      },
      orderBy: {
        employee: {
          name: 'asc'
        }
      }
    });

    // 4. Format the response
    const employees = attendanceRecords.map(record => ({
      id: record.employee.id,
      name: record.employee.name,
      email: record.employee.email,
      phone: record.employee.phone,
      office: record.employee.office,
      status: record.status,
      checkInTime: record.checkInTime ? moment(record.checkInTime).tz("Asia/Kolkata").format("HH:mm:ss") : null,
      checkOutTime: record.checkOutTime ? moment(record.checkOutTime).tz("Asia/Kolkata").format("HH:mm:ss") : null,
      attendanceDate: moment(record.date).tz("Asia/Kolkata").format("YYYY-MM-DD"),
    }));

    // 5. Get count
    const totalCount = employees.length;

    // ---- Final Response ----
    res.json({
      date: todayISTDateString,
      office: officeDetails,
      status: attendanceStatus,
      totalCount,
      employees,
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch employees by attendance status");
  }
};