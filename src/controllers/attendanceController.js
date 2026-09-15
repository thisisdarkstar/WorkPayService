import moment from "moment-timezone";
import { finalizeOfficeAttendance, checkAndRunAutoFinalize } from "../services/autoFinalizeService.js";

// Convert UTC date to IST string for response
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
    const { type } = req.body;
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

    // Convert stored office times to today's UTC times
    console.log("DEBUG - Stored office.checkin:", office.checkin);
    console.log("DEBUG - Stored office.checkout:", office.checkout);
    
    const officeCheckinUTC = getTodayOfficeTimeUTC(office.checkin);
    const officeCheckoutUTC = getTodayOfficeTimeUTC(office.checkout);

    // Debug logs to verify office times
    console.log("DEBUG - Office checkin UTC:", officeCheckinUTC);
    console.log("DEBUG - Office checkout UTC:", officeCheckoutUTC);
    console.log("DEBUG - Office checkin IST:", toISTString(officeCheckinUTC));
    console.log("DEBUG - Office checkout IST:", toISTString(officeCheckoutUTC));

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

      attendance = await req.db.attendance.update({
        where: { id: attendance.id },
        data: { checkOutTime: nowUTC, overTime: overtimeMinutes, employee: { connect: { id: Number(employeeId) } } },
      });

      // Create overtime transaction if applicable
      if (overtimeMinutes > 0) {
        const overtimeHours = overtimeMinutes / 60;
        const overtimePay = overtimeHours * employee.overtimeRate;

        await req.db.transaction.create({
          data: {
            empId: Number(employeeId),
            amount: overtimePay,
            payType: "OVERTIME",
            description: `Overtime payment for ${overtimeHours.toFixed(2)} hr(s) on ${toISTString(nowUTC).split(" ")[0]}`,
            date: nowUTC,
          },
        });
      }

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
    console.error("Attendance Error:", error);
    res.status(500).json({ error: "Failed to handle attendance", details: error.message });
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
      console.log("DEBUG - Current month detected, limiting to today");
      console.log("DEBUG - Month end changed from full month to:", monthEndIST.format("YYYY-MM-DD HH:mm:ss"));
    }

    // 2. Convert to UTC for querying
    const monthStartUTC = monthStartIST.utc().toDate();
    const monthEndUTC = monthEndIST.utc().toDate();

    console.log("DEBUG - Query range:");
    console.log("DEBUG - Start IST:", monthStartIST.format("YYYY-MM-DD HH:mm:ss"));
    console.log("DEBUG - End IST:", monthEndIST.format("YYYY-MM-DD HH:mm:ss"));
    console.log("DEBUG - Start UTC:", monthStartUTC);
    console.log("DEBUG - End UTC:", monthEndUTC);

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
    console.error("Error fetching employee attendance:", error);
    res.status(500).json({ error: "Failed to fetch employee attendance" });
  }
};




// ✅ Dashboard Attendance API (IST-aware with Office filtering and "all" support)
export const getTodayAttendanceDashboard = async (req, res) => {
  try {
    // Opportunistically run auto-finalize check in background if any office deadline passed
    checkAndRunAutoFinalize(req.db).catch(err => console.error('[AutoFinalize Error]', err));

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
      
      // Verify office exists
      const officeExists = await req.db.office.findUnique({
        where: { id: targetOfficeId },
      });
      
      if (!officeExists) {
        return res.status(404).json({ error: "Office not found" });
      }
    }

    // 3. Get employees based on office selection
    let employeeIds;
    let officeDetails;

    if (isAllOffices) {
      // Get all active employees from all offices belonging to this admin
      const adminId = req.admin?.id;
      const allEmployees = await req.db.employee.findMany({
        where: { 
          status: 'ACTIVE',
          ...(adminId ? { adminId: Number(adminId) } : {})
        },
        select: { id: true }
      });
      
      employeeIds = allEmployees.map(emp => emp.id);
      officeDetails = { id: "all", name: "All Offices" };
    } else {
      // Get employees for specific office belonging to this admin
      const adminId = req.admin?.id;
      const officeEmployees = await req.db.employee.findMany({
        where: { 
          officeId: targetOfficeId,
          status: 'ACTIVE',
          ...(adminId ? { adminId: Number(adminId) } : {})
        },
        select: { id: true }
      });
      
      employeeIds = officeEmployees.map(emp => emp.id);
      
      // Get office details for response
      officeDetails = await req.db.office.findUnique({
        where: { id: targetOfficeId },
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

          // ---- Get all offices ----
      const offices = await req.db.office.findMany();

    // ---- Prepare response based on office selection ----
    const response = {
      date: todayISTDateString,
      office: officeDetails,
      totalEmployees,
      totalLate,
      totalPresent,
      totalAbsent,
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
    console.error("Error fetching dashboard attendance:", error);
    res.status(500).json({ error: "Failed to fetch dashboard attendance" });
  }
};
 

// ✅ Admin: Get all attendance for an employee by month & year (IST-aware)
export const getEmployeeAttendanceByMonthInAdmin = async (req, res) => {
  try {
    const { month, year, empId } = req.query;

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

    res.json({ month, year, attendanceRecords: attendanceRecordsIST });
  } catch (error) {
    console.error("Error fetching employee attendance:", error);
    res.status(500).json({ error: "Failed to fetch employee attendance" });
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
      const officeExists = await req.db.office.findUnique({
        where: { id: targetOfficeId },
        select: { id: true, name: true }
      });
      if (!officeExists) {
        return res.status(404).json({ error: "Office not found" });
      }
    } else {
      const firstOffice = await req.db.office.findFirst({
        orderBy: { id: 'asc' },
        select: { id: true, name: true }
      });
      if (!firstOffice) {
        return res.status(404).json({ error: "No offices found" });
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
    console.error("Error finalizing attendance:", error);
    res.status(500).json({ 
      error: "Failed to finalize attendance", 
      details: error.message 
    });
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
      const officeExists = await req.db.office.findUnique({
        where: { id: targetOfficeId },
        select: { id: true, name: true }
      });
      if (!officeExists) {
        return res.status(404).json({ error: "Office not found" });
      }
    } else {
      const firstOffice = await req.db.office.findFirst({
        orderBy: { id: 'asc' },
        select: { id: true, name: true }
      });
      if (!firstOffice) {
        return res.status(404).json({ error: "No offices found" });
      }
      targetOfficeId = firstOffice.id;
    }

    // Get office details
    const officeDetails = await req.db.office.findUnique({
      where: { id: targetOfficeId },
      select: { 
        id: true, 
        name: true,
        checkin: true,
        checkout: true,
        autoFinalizeTime: true,
        lastFinalized: true
      }
    });

    // Get all active employees for the target office
    const officeEmployees = await req.db.employee.findMany({
      where: { 
        officeId: targetOfficeId,
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

    const totalRecorded = stats.PRESENT + stats.ABSENT + stats.LATE + stats.LEAVE;
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
    console.error("Error checking bulk attendance status:", error);
    res.status(500).json({ 
      error: "Failed to check bulk attendance status", 
      details: error.message 
    });
  }
};

// Cron auto-finalize handler (invoked by scheduler or Vercel Cron)
export const cronAutoFinalize = async (req, res) => {
  try {
    const results = await checkAndRunAutoFinalize(req.db);
    res.json({
      message: "Auto-finalize check completed",
      processedCount: results.length,
      results
    });
  } catch (error) {
    console.error("Cron auto-finalize error:", error);
    res.status(500).json({ 
      error: "Failed to execute auto-finalize check", 
      details: error.message 
    });
  }
};



// ✅ Get Employees by Attendance Status for Today
export const getEmployeesByAttendanceStatus = async (req, res) => {
  try {
    const { officeId, status } = req.params;

    console.log(officeId,status)

    // Validate status parameter
    const validStatuses = ["PRESENT", "ABSENT", "LATE"];
    if (!status || !validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ 
        error: "Invalid status. Must be one of: PRESENT, ABSENT, LATE" 
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

    if (officeId === "all") {
      isAllOffices = true;
      
      // Get all active employees from all offices
      const allEmployees = await req.db.employee.findMany({
        where: { 
          status: 'ACTIVE'
        },
        select: { id: true }
      });
      
      employeeIds = allEmployees.map(emp => emp.id);
      officeDetails = { id: "all", name: "All Offices" };
    } else {
      // Use the provided officeId
      targetOfficeId = Number(officeId);
      
      // Verify office exists
      const officeExists = await req.db.office.findUnique({
        where: { id: targetOfficeId },
      });
      
      if (!officeExists) {
        return res.status(404).json({ error: "Office not found" });
      }

      // Get employees for specific office
      const officeEmployees = await req.db.employee.findMany({
        where: { 
          officeId: targetOfficeId,
          status: 'ACTIVE'
        },
        select: { id: true }
      });
      
      employeeIds = officeEmployees.map(emp => emp.id);
      
      // Get office details for response
      officeDetails = await req.db.office.findUnique({
        where: { id: targetOfficeId },
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
    console.error("Error fetching employees by attendance status:", error);
    res.status(500).json({ error: "Failed to fetch employees by attendance status" });
  }
};