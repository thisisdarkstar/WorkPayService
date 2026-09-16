import moment from "moment-timezone";
import { sendApiError } from "../utils/errorHandler.js";

// ---------------- Helper ----------------
const toUTC = (datetime) => {
  // Convert IST date to UTC properly
  return moment.tz(datetime, "Asia/Kolkata").startOf("day").utc().toDate();
};

const formatDateIST = (datetime) =>
  moment.utc(datetime).tz("Asia/Kolkata").format("YYYY-MM-DD");

// ---------------- Apply Leave ----------------
export const applyLeave = async (req, res) => {
  try {
    const empId = req.employee.id;
    const { reason, startDate, endDate } = req.body;

    if (!empId || !reason || !startDate || !endDate) {
      return res
        .status(400)
        .json({ error: "empId, reason, startDate, endDate are required" });
    }

    const fromDateUTC = toUTC(startDate);
    const toDateUTC = toUTC(endDate);

    if (fromDateUTC > toDateUTC) {
      return res
        .status(400)
        .json({ error: "Start date cannot be after end date" });
    }

    // 1️⃣ Overlapping leave check (only conflict with APPROVED leaves)
    const existingLeaves = await req.db.leave.findMany({
      where: {
        empId: Number(empId),
        status: "APPROVED",
        OR: [
          {
            AND: [
              { fromDate: { lte: fromDateUTC } },
              { toDate: { gte: fromDateUTC } },
            ],
          },
          {
            AND: [
              { fromDate: { lte: toDateUTC } },
              { toDate: { gte: toDateUTC } },
            ],
          },
          {
            AND: [
              { fromDate: { gte: fromDateUTC } },
              { toDate: { lte: toDateUTC } },
            ],
          },
          {
            AND: [
              { fromDate: { lte: fromDateUTC } },
              { toDate: { gte: toDateUTC } },
            ],
          },
        ],
      },
    });

    if (existingLeaves.length > 0) {
      return res.status(400).json({
        error: "Leave dates conflict with existing approved leave applications",
        conflictingLeaves: existingLeaves.map((l) => ({
          id: l.id,
          fromDate: formatDateIST(l.fromDate),
          toDate: formatDateIST(l.toDate),
          type: l.type,
        })),
      });
    }

    // 2️⃣ Fetch holidays in range for THIS employee's admin
    const holidays = await req.db.holiday.findMany({
      where: {
        date: {
          gte: fromDateUTC,
          lte: toDateUTC,
        },
        adminId: Number(req.employee.adminId),
      },
      select: { date: true },
    });
    const holidayDates = holidays.map((h) => formatDateIST(h.date));

    // Reject if start or end is a holiday
    if (
      holidayDates.includes(formatDateIST(fromDateUTC)) ||
      holidayDates.includes(formatDateIST(toDateUTC))
    ) {
      return res
        .status(400)
        .json({ error: "Start date or end date cannot be a holiday" });
    }

    // 3️⃣ Build working days list (FIXED: exclude holidays in between)
    let workingDates = [];
    let cursor = moment.utc(fromDateUTC); // Use UTC cursor to avoid timezone issues
    
    while (cursor <= moment.utc(toDateUTC)) {
      const dateStr = cursor.format("YYYY-MM-DD");
      if (!holidayDates.includes(dateStr)) {
        // Don't call toUTC again - just use the cursor date directly
        workingDates.push(cursor.clone().toDate());
      }
      cursor.add(1, "day");
    }
    
    const totalWorkingDays = workingDates.length;

    if (totalWorkingDays <= 0) {
      return res
        .status(400)
        .json({ error: "No working days left after excluding holidays" });
    }

    // 4️⃣ Fetch employee leave balance
    const employee = await req.db.employee.findUnique({
      where: { id: Number(empId) },
      select: { leaveBalance: true },
    });

    if (!employee)
      return res.status(404).json({ error: "Employee not found" });

    let leaveApplications = [];

    // 5️⃣ Apply leave logic
    if (employee.leaveBalance <= 0) {
      // All unpaid
      const leave = await req.db.leave.create({
        data: {
          empId: Number(empId),
          reason,
          fromDate: workingDates[0],
          toDate: workingDates[workingDates.length - 1],
          totalDays: totalWorkingDays,
          type: "UNPAID",
        },
      });
      leaveApplications.push(leave);
    } else if (employee.leaveBalance >= totalWorkingDays) {
      // All paid
      const leave = await req.db.leave.create({
        data: {
          empId: Number(empId),
          reason,
          fromDate: workingDates[0],
          toDate: workingDates[workingDates.length - 1],
          totalDays: totalWorkingDays,
          type: "PAID",
        },
      });
      leaveApplications.push(leave);
    } else {
      // Split between paid and unpaid
      const paidDays = employee.leaveBalance;
      const unpaidDays = totalWorkingDays - paidDays;

      const paidLeave = await req.db.leave.create({
        data: {
          empId: Number(empId),
          reason,
          fromDate: workingDates[0],
          toDate: workingDates[paidDays - 1],
          totalDays: paidDays,
          type: "PAID",
        },
      });

      const unpaidLeave = await req.db.leave.create({
        data: {
          empId: Number(empId),
          reason,
          fromDate: workingDates[paidDays],
          toDate: workingDates[workingDates.length - 1],
          totalDays: unpaidDays,
          type: "UNPAID",
        },
      });

      leaveApplications.push(paidLeave, unpaidLeave);
    }

    // Response with formatted dates
    res.json({
      message: "Leave application submitted",
      applications: leaveApplications.map((l) => ({
        ...l,
        fromDate: formatDateIST(l.fromDate),
        toDate: formatDateIST(l.toDate),
      })),
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to apply leave");
  }
};

// ---------------- Get Leave Summary (Office-specific) ----------------
export const getLeaveSummary = async (req, res) => {
  try {
    let targetOfficeId;
    let isAllOffices = false;
    let employeeIds = [];
    let officeDetails;
    const { officeId } = req.params;
    const adminId = Number(req.admin.id);
    
    console.log("DEBUG - Getting leave summary for officeId:", officeId);
    
    if (officeId === "all" || officeId === undefined) {
      isAllOffices = true;
      const allEmployees = await req.db.employee.findMany({
        where: { 
          status: 'ACTIVE',
          adminId
        },
        select: { id: true }
      });
      employeeIds = allEmployees.map(emp => emp.id);
      officeDetails = { id: "all", name: "All Branches" };
    } else {
      targetOfficeId = Number(officeId);
      const officeExists = await req.db.office.findFirst({
        where: { id: targetOfficeId, adminId },
        select: { id: true, name: true }
      });
      
      if (!officeExists) {
        return res.status(404).json({ error: "Office not found or unauthorized" });
      }
      officeDetails = officeExists;

      const officeEmployees = await req.db.employee.findMany({
        where: { 
          officeId: targetOfficeId,
          status: 'ACTIVE',
          adminId
        },
        select: { id: true }
      });

      employeeIds = officeEmployees.map(emp => emp.id);
    }
    
    console.log("DEBUG - Total active employees in leave summary scope:", employeeIds.length);

    if (employeeIds.length === 0) {
      return res.json({
        office: officeDetails,
        approvedLeaves: [],
        rejectedLeaves: [],
        pendingLeaves: [],
        message: "No active employees found"
      });
    }

    // 3. Fetch leaves filtered by employees
    const fetchLeaves = async (status) => {
      return req.db.leave.findMany({
        where: { 
          status,
          empId: { in: employeeIds }
        },
        orderBy: { applyDate: "desc" },
        take: status === "PENDING" ? undefined : 20,
        include: { employee: { select: { id: true, name: true } } },
      });
    };

    const [approved, rejected, pending] = await Promise.all([
      fetchLeaves("APPROVED"),
      fetchLeaves("REJECTED"),
      fetchLeaves("PENDING"),
    ]);

    const formatLeaves = (leaves) =>
      leaves.map((l) => ({
        ...l,
        fromDate: formatDateIST(l.fromDate),
        toDate: formatDateIST(l.toDate),
      }));

    console.log("DEBUG - Leave summary counts:", {
      approved: approved.length,
      rejected: rejected.length,
      pending: pending.length
    });

    res.json({
      office: officeDetails,
      approvedLeaves: formatLeaves(approved),
      rejectedLeaves: formatLeaves(rejected),
      pendingLeaves: formatLeaves(pending),
      totalCounts: {
        approved: approved.length,
        rejected: rejected.length,
        pending: pending.length
      }
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch leave summary");
  }
};


// ---------------- Approve / Reject Leave ----------------
export const updateLeaveStatus = async (req, res) => {
  try {
    const { leaveId, status } = req.body;

    if (!leaveId || !status || !["APPROVED", "REJECTED"].includes(status)) {
      return res.status(400).json({ error: "Invalid leaveId or status" });
    }

    const leave = await req.db.leave.findUnique({
      where: { id: Number(leaveId) },
      include: { 
        employee: { 
          select: { 
            id: true, 
            name: true, 
            leaveBalance: true,
            baseSalary: true,
            adminId: true // for ownership verification
          } 
        } 
      },
    });

    if (!leave) return res.status(404).json({ error: "Leave not found" });

    // Verify this leave belongs to an employee managed by the requesting admin
    if (req.admin?.id && leave.employee.adminId !== req.admin.id) {
      return res.status(403).json({ error: "Unauthorized: this employee does not belong to your account" });
    }

    if (leave.status === status) {
      return res.status(400).json({ error: `Leave is already ${status.toLowerCase()}` });
    }

    if (leave.status !== "PENDING") {
      return res.status(400).json({
        error: `Cannot update a leave that has already been ${leave.status.toLowerCase()}`,
      });
    }

    let totalDeductionAmount = 0;
    let deductionDetails = [];
    let transactions = [];

    if (status === "APPROVED" && leave.type === "UNPAID") {
      const start = new Date(leave.fromDate);
      const end = new Date(leave.toDate);
      const employeeSalary = leave.employee.baseSalary;

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const leaveDay = moment.utc(d).tz("Asia/Kolkata");
        const totalDaysInMonth = leaveDay.daysInMonth();
        const perDayAmount = Math.round(employeeSalary / totalDaysInMonth);
        totalDeductionAmount += perDayAmount;

        const leaveDateIST = formatDateIST(d);

        transactions.push({
          empId: leave.empId,
          amount: perDayAmount,
          payType: "DEDUCTION",
          description: `Unpaid leave deduction for ${leaveDateIST} (₹${perDayAmount}/${totalDaysInMonth} days) - Leave ID: ${leave.id}`,
          date: new Date(d),
        });

        deductionDetails.push({
          date: leaveDateIST,
          amount: perDayAmount,
          daysInMonth: totalDaysInMonth
        });
      }
    }

    // Execute updates atomically inside a transaction
    const updatedLeave = await req.db.$transaction(async (tx) => {
      if (status === "APPROVED" && leave.type === "PAID") {
        await tx.employee.update({
          where: { id: leave.empId },
          data: { leaveBalance: { decrement: leave.totalDays } },
        });
      }

      if (status === "APPROVED" && leave.type === "UNPAID" && transactions.length > 0) {
        await tx.transaction.createMany({ data: transactions });
      }

      return tx.leave.update({
        where: { id: Number(leaveId) },
        data: { status },
        include: { 
          employee: { 
            select: { 
              id: true, 
              name: true, 
              leaveBalance: true,
              baseSalary: true
            } 
          } 
        },
      });
    });

    // Prepare response with deduction information
    const responseData = {
      message: `Leave ${status.toLowerCase()}`,
      leave: {
        ...updatedLeave,
        fromDate: formatDateIST(updatedLeave.fromDate),
        toDate: formatDateIST(updatedLeave.toDate),
      }
    };

    // Add deduction details if unpaid leave was approved
    if (status === "APPROVED" && leave.type === "UNPAID") {
      responseData.deductionSummary = {
        totalAmount: totalDeductionAmount,
        totalDays: leave.totalDays,
        employeeSalary: leave.employee.baseSalary,
        deductionDetails: deductionDetails
      };
    }

    res.json(responseData);

  } catch (error) {
    return sendApiError(res, error, 500, "Failed to update leave status");
  }
};

// ---------------- Get Leaves by Year (Employee) ----------------
export const getLeavesByYear = async (req, res) => {
  try {
    const empId = req.employee.id;
    const { year } = req.query;

    if (!empId || !year)
      return res.status(400).json({ error: "empId and year are required" });

    // ✅ Fixed year range (covers full IST year)
    const startUTC = moment
      .tz(`${year}-01-01`, "Asia/Kolkata")
      .startOf("day")
      .utc()
      .toDate();
    const endUTC = moment
      .tz(`${year}-12-31`, "Asia/Kolkata")
      .endOf("day")
      .utc()
      .toDate();

    const leaves = await req.db.leave.findMany({
      where: {
        empId: Number(empId),
        fromDate: { gte: startUTC },
        toDate: { lte: endUTC },
      },
      orderBy: { fromDate: "desc" },
    });

    res.json({
      empId: Number(empId),
      year: Number(year),
      leaves: leaves.map((l) => ({
        ...l,
        fromDate: formatDateIST(l.fromDate),
        toDate: formatDateIST(l.toDate),
      })),
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch leaves");
  }
};

// ---------------- Get Employee Leave History (Admin) ----------------
export const getEmployeeLeaveHistory = async (req, res) => {
  try {
    const { empId, year } = req.query;

    if (!empId || !year)
      return res.status(400).json({ error: "empId and year are required" });

    // Verify employee belongs to this admin
    const employee = await req.db.employee.findFirst({
      where: { id: Number(empId), adminId: Number(req.admin.id) }
    });
    if (!employee) return res.status(404).json({ error: "Employee not found in your organization" });

    // ✅ Fixed year range (covers full IST year)
    const startUTC = moment
      .tz(`${year}-01-01`, "Asia/Kolkata")
      .startOf("day")
      .utc()
      .toDate();
    const endUTC = moment
      .tz(`${year}-12-31`, "Asia/Kolkata")
      .endOf("day")
      .utc()
      .toDate();

    const leaves = await req.db.leave.findMany({
      where: {
        empId: Number(empId),
        fromDate: { gte: startUTC },
        toDate: { lte: endUTC },
      },
      orderBy: { fromDate: "asc" },
    });

    res.json({
      empId: Number(empId),
      year: Number(year),
      leaves: leaves.map((l) => ({
        ...l,
        fromDate: formatDateIST(l.fromDate),
        toDate: formatDateIST(l.toDate),
      })),
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch leave history");
  }
};
