import moment from "moment-timezone";
import { sendApiError } from "../utils/errorHandler.js";


// Convert UTC date to IST string for response (same as attendance)
const toISTString = (utcDate) =>
  moment.utc(utcDate).tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");

// Convert IST date to IST date string (YYYY-MM-DD format)
const toISTDateString = (utcDate) =>
  moment.utc(utcDate).tz("Asia/Kolkata").format("YYYY-MM-DD");

// Convert IST date string to UTC start of day (same logic as attendance)
const getISTDateAsUTC = (dateString) => {
  // Parse the IST date and get start of day in IST, then convert to UTC
  return moment.tz(dateString, "YYYY-MM-DD", "Asia/Kolkata")
    .startOf("day")
    .utc()
    .toDate();
};

// ✅ Get holidays for current year, grouped by month (strictly scoped by adminId)
export const getHolidaysByYear = async (req, res) => {
  try {
    let adminId = req.admin?.id;
    if (!adminId && req.user) {
      adminId = req.user.role === "admin" ? req.user.id : req.user.dbUser?.adminId;
    }

    if (!adminId) {
      return res.status(401).json({ error: "Unauthorized: admin identification missing" });
    }

    const now = new Date();
    const year = now.getFullYear();

    // Start & end of current year
    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year + 1, 0, 1);

    const holidays = await req.db.holiday.findMany({
      where: {
        date: {
          gte: startOfYear,
          lt: endOfYear,
        },
        adminId: Number(adminId),
      },
      orderBy: { date: "asc" },
    });

    // Group by month
    const grouped = holidays.reduce((acc, holiday) => {
      const monthName = holiday.date.toLocaleString("en-US", { month: "long" });

      if (!acc[monthName]) acc[monthName] = [];

      acc[monthName].push({
        id: holiday.id,
        date: holiday.date,
        description: holiday.description,
      });

      return acc;
    }, {});

    const response = Object.keys(grouped).map((month) => ({
      month,
      holidays: grouped[month],
    }));

    res.json(response);
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch holidays");
  }
};

export const addHoliday = async (req, res) => {
  try {
    const { description, date } = req.body;

    if (!description || !date) {
      return res.status(400).json({ error: "description and date are required" });
    }

    // Ensure only YYYY-MM-DD is taken (drop any accidental time)
    const onlyDate = date.split("T")[0];

    // Validate date format
    if (!moment(onlyDate, "YYYY-MM-DD", true).isValid()) {
      return res.status(400).json({ error: "Invalid date format, expected YYYY-MM-DD" });
    }

    // Convert IST date to UTC (start of day in IST becomes UTC timestamp)
    // This matches how attendance stores dates
    const holidayDateUTC = getISTDateAsUTC(onlyDate);

    console.log("DEBUG - Input IST date:", onlyDate);
    console.log("DEBUG - Stored UTC date:", holidayDateUTC);
    console.log("DEBUG - Converted back to IST:", toISTDateString(holidayDateUTC));

    // Check if holiday already exists on this date for THIS admin
    const existingHoliday = await req.db.holiday.findFirst({
      where: {
        date: holidayDateUTC,
        adminId: req.admin.id
      }
    });

    if (existingHoliday) {
      return res.status(400).json({ 
        error: "A holiday already exists on this date",
        existing: {
          ...existingHoliday,
          date: toISTDateString(existingHoliday.date)
        }
      });
    }

    // Get only THIS admin's employees to create attendance records
    const employees = await req.db.employee.findMany({
      where: { adminId: req.admin.id },
      select: { id: true }
    });

    // Check if any attendance records already exist for this date among THIS admin's employees
    const employeeIds = employees.map(e => e.id);
    const existingAttendance = employeeIds.length > 0 ? await req.db.attendance.findMany({
      where: {
        date: holidayDateUTC,
        empId: { in: employeeIds }
      }
    }) : [];

    if (existingAttendance.length > 0) {
      return res.status(400).json({ 
        error: "Attendance records already exist for this date",
        existingCount: existingAttendance.length
      });
    }

    // Use transaction to ensure both holiday and attendance records are created atomically
    const result = await req.db.$transaction(async (tx) => {
      // Create the holiday
      const holiday = await tx.holiday.create({
        data: {
          description,
          date: holidayDateUTC,
          adminId: req.admin.id,
        },
      });

      let attendanceCount = 0;
      if (employees.length > 0) {
        // Create attendance records for all employees with status "HOLIDAY"
        const attendanceRecords = await tx.attendance.createMany({
          data: employees.map(employee => ({
            empId: employee.id,
            date: holidayDateUTC, // Same UTC date as holiday
            checkInTime: null, // No check-in for holidays
            checkOutTime: null, // No check-out for holidays
            overTime: 0, // No overtime for holidays
            status: "HOLIDAY" // Status as HOLIDAY
          }))
        });
        attendanceCount = attendanceRecords.count;
      }

      return { 
        holiday, 
        attendanceCount 
      };
    });

    console.log(`DEBUG - Created holiday and attendance for ${result.attendanceCount} employees`);
    console.log(`DEBUG - Holiday date UTC: ${result.holiday.date}`);
    console.log(`DEBUG - Holiday date IST: ${toISTDateString(result.holiday.date)}`);

    res.json({
      message: `Holiday added successfully and attendance created for ${result.attendanceCount} employees`,
      holiday: {
        ...result.holiday,
        date: toISTDateString(result.holiday.date), // Convert back to IST for response
      },
      attendanceCreated: result.attendanceCount
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to add holiday");
  }
};




// ✅ Delete holiday
export const deleteHoliday = async (req, res) => {
  try {
    const { id } = req.params;

    const holiday = await req.db.holiday.findUnique({ where: { id: Number(id) } });
    if (!holiday) {
      return res.status(404).json({ error: "Holiday not found" });
    }

    // Verify ownership
    if (req.admin?.id && holiday.adminId !== req.admin.id) {
      return res.status(403).json({ error: "Unauthorized: this holiday does not belong to your account" });
    }

    // Get the holiday date for finding associated attendance records
    const holidayDate = holiday.date;

    console.log("DEBUG - Deleting holiday:", holiday.description);
    console.log("DEBUG - Holiday date UTC:", holidayDate);
    console.log("DEBUG - Holiday date IST:", toISTDateString(holidayDate));

    // Find all attendance records with HOLIDAY status for this date belonging to THIS admin's employees
    const adminEmployees = await req.db.employee.findMany({
      where: { adminId: req.admin.id },
      select: { id: true }
    });
    const adminEmployeeIds = adminEmployees.map(e => e.id);

    // Use transaction to ensure both holiday and attendance records are deleted atomically
    const result = await req.db.$transaction(async (tx) => {
      // Delete attendance records with HOLIDAY status for this date belonging to THIS admin's employees
      const deletedAttendances = adminEmployeeIds.length > 0 ? await tx.attendance.deleteMany({
        where: {
          date: holidayDate,
          status: "HOLIDAY",
          empId: { in: adminEmployeeIds }
        }
      }) : { count: 0 };

      // Delete the holiday
      await tx.holiday.delete({ where: { id: Number(id) } });

      return {
        attendanceDeleted: deletedAttendances.count
      };
    });

    console.log(`DEBUG - Deleted holiday and ${result.attendanceDeleted} attendance records`);

    res.json({ 
      message: `Holiday deleted successfully and ${result.attendanceDeleted} attendance records removed`,
      attendanceDeleted: result.attendanceDeleted
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to delete holiday");
  }
};