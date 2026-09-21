import moment from "moment-timezone";
import { sendApiError } from "../utils/errorHandler.js";

// ---------------- Helper ----------------
const toUTC = (datetime) => {
  // Convert IST date to UTC properly
  return moment.tz(datetime, "Asia/Kolkata").startOf("day").utc().toDate();
};

const formatDateIST = (datetime) =>
  moment.utc(datetime).tz("Asia/Kolkata").format("YYYY-MM-DD");

// ---------------- Preview Leave (M-10) ----------------
// Returns the authoritative server-side calculation of working days, holiday
// exclusions, and paid/unpaid split for a proposed leave range WITHOUT creating
// any records. The client uses this instead of re-implementing the same rules,
// eliminating the risk of the preview diverging from what applyLeave does.
export const previewLeave = async (req, res) => {
  try {
    const empId = req.employee.id;
    const { startDate, endDate } = req.body;

    if (!startDate) {
      return res.status(400).json({ error: "startDate is required" });
    }

    const fromDateUTC = toUTC(startDate);
    const toDateUTC = toUTC(endDate || startDate);

    if (fromDateUTC > toDateUTC) {
      return res.status(400).json({ error: "Start date cannot be after end date" });
    }

    // Holidays in range for this employee's admin
    const holidays = await req.db.holiday.findMany({
      where: {
        date: { gte: fromDateUTC, lte: toDateUTC },
        adminId: Number(req.employee.adminId),
      },
      select: { date: true, description: true },
    });
    const holidayDateSet = new Set(holidays.map((h) => formatDateIST(h.date)));

    const startStr = formatDateIST(fromDateUTC);
    const endStr = formatDateIST(toDateUTC);

    // Reject if start or end is a holiday (mirrors applyLeave)
    if (holidayDateSet.has(startStr) || holidayDateSet.has(endStr)) {
      return res.json({
        valid: false,
        reason: holidayDateSet.has(startStr)
          ? "Start date is a holiday. Please select a different date."
          : "End date is a holiday. Please select a different date.",
      });
    }

    // Build working days (exclude in-between holidays)
    const holidaysExcluded = [];
    let workingDays = 0;
    const cursor = moment.utc(fromDateUTC);
    const endCursor = moment.utc(toDateUTC);
    while (cursor <= endCursor) {
      const dateStr = cursor.format("YYYY-MM-DD");
      if (holidayDateSet.has(dateStr)) {
        const h = holidays.find((x) => formatDateIST(x.date) === dateStr);
        holidaysExcluded.push({ date: dateStr, name: h?.description || "Holiday" });
      } else {
        workingDays++;
      }
      cursor.add(1, "day");
    }

    if (workingDays <= 0) {
      return res.json({
        valid: false,
        reason: "Selected period contains only holidays. No leave application needed.",
        holidaysExcluded,
      });
    }

    const employee = await req.db.employee.findUnique({
      where: { id: Number(empId) },
      select: { leaveBalance: true },
    });
    const leaveBalance = employee?.leaveBalance ?? 0;

    const paidDays = Math.max(0, Math.min(workingDays, leaveBalance));
    const unpaidDays = workingDays - paidDays;

    const totalCalendarDays =
      Math.round((toDateUTC - fromDateUTC) / (1000 * 60 * 60 * 24)) + 1;

    return res.json({
      valid: true,
      startDate: startStr,
      endDate: endStr,
      totalCalendarDays,
      totalWorkingDays: workingDays,
      holidaysExcluded,
      leaveBalance,
      paidDays,
      unpaidDays,
      isSingleDay: startStr === endStr,
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to preview leave");
  }
};

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

    // 1️⃣ Overlapping leave check.
    // M-03: Conflict with both APPROVED and PENDING leaves. Previously only
    // APPROVED leaves were checked, so an employee could stack multiple
    // overlapping applications for the same dates; approving them in sequence
    // would double-decrement the leave balance for the same days.
    const existingLeaves = await req.db.leave.findMany({
      where: {
        empId: Number(empId),
        status: { in: ["APPROVED", "PENDING"] },
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
        error: "Leave dates conflict with an existing pending or approved leave application",
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

      // F-4: Persist both halves atomically. Previously these were two separate
      // create() calls, so a failure on the second one left the employee with
      // only the paid portion — silently losing the unpaid tail of their leave
      // range even though the success toast implied the whole leave was saved.
      const [paidLeave, unpaidLeave] = await req.db.$transaction(async (tx) => {
        const paid = await tx.leave.create({
          data: {
            empId: Number(empId),
            reason,
            fromDate: workingDates[0],
            toDate: workingDates[paidDays - 1],
            totalDays: paidDays,
            type: "PAID",
          },
        });

        const unpaid = await tx.leave.create({
          data: {
            empId: Number(empId),
            reason,
            fromDate: workingDates[paidDays],
            toDate: workingDates[workingDates.length - 1],
            totalDays: unpaidDays,
            type: "UNPAID",
          },
        });

        return [paid, unpaid];
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

      // H-04: Skip any holidays that fall within the leave range. Holidays may
      // have been added AFTER the leave was applied, so we cannot rely solely on
      // the stored fromDate/toDate range being holiday-free. Deducting salary for
      // a company holiday would overcharge the employee.
      const rangeHolidays = await req.db.holiday.findMany({
        where: {
          adminId: leave.employee.adminId,
          date: { gte: start, lte: end },
        },
        select: { date: true },
      });
      const holidaySet = new Set(rangeHolidays.map((h) => formatDateIST(h.date)));

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const leaveDateIST = formatDateIST(d);

        // Do not deduct for holidays within the leave period.
        if (holidaySet.has(leaveDateIST)) continue;

        const leaveDay = moment.utc(d).tz("Asia/Kolkata");
        const totalDaysInMonth = leaveDay.daysInMonth();
        const perDayAmount = Math.round(employeeSalary / totalDaysInMonth);
        totalDeductionAmount += perDayAmount;

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
        // CF-05: The paid/unpaid split was decided at APPLY time using the
        // balance then. By approval time the balance may have dropped (e.g.
        // another leave was approved first). Re-read the CURRENT balance inside
        // the transaction and never let it go negative. If the employee no
        // longer has enough paid days, convert the uncovered days to unpaid
        // deductions instead of silently over-crediting / going negative.
        const current = await tx.employee.findUnique({
          where: { id: leave.empId },
          select: { leaveBalance: true, baseSalary: true },
        });
        const availablePaid = Math.max(0, Math.min(current?.leaveBalance ?? 0, leave.totalDays));
        const shortfallDays = leave.totalDays - availablePaid;

        if (availablePaid > 0) {
          await tx.employee.update({
            where: { id: leave.empId },
            data: { leaveBalance: { decrement: availablePaid } },
          });
        }

        // Any days not covered by remaining balance become unpaid deductions,
        // applied per working day (skipping holidays), matching the UNPAID path.
        if (shortfallDays > 0) {
          const start = new Date(leave.fromDate);
          const end = new Date(leave.toDate);
          const rangeHolidays = await tx.holiday.findMany({
            where: { adminId: leave.employee.adminId, date: { gte: start, lte: end } },
            select: { date: true },
          });
          const holidaySet = new Set(rangeHolidays.map((h) => formatDateIST(h.date)));

          const salary = current?.baseSalary ?? leave.employee.baseSalary;
          const shortfallTxns = [];
          const remaining = shortfallDays;
          // Deduct for the LAST `shortfallDays` working days of the leave.
          const workingDays = [];
          for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            if (!holidaySet.has(formatDateIST(d))) workingDays.push(new Date(d));
          }
          const toDeduct = workingDays.slice(Math.max(0, workingDays.length - remaining));
          for (const d of toDeduct) {
            const daysInMonth = moment.utc(d).tz("Asia/Kolkata").daysInMonth();
            const perDay = Math.round(salary / daysInMonth);
            shortfallTxns.push({
              empId: leave.empId,
              amount: perDay,
              payType: "DEDUCTION",
              description: `Unpaid leave deduction (insufficient balance) for ${formatDateIST(d)} - Leave ID: ${leave.id}`,
              date: new Date(d),
            });
          }
          if (shortfallTxns.length > 0) {
            await tx.transaction.createMany({ data: shortfallTxns });
          }
        }
      }

      if (status === "APPROVED" && leave.type === "UNPAID" && transactions.length > 0) {
        await tx.transaction.createMany({ data: transactions });
      }

      // F-3: Retroactive reconciliation. If the leave range covers dates
      // that are already past (or today) the finalize service may have
      // marked those days ABSENT and created per-day salary DEDUCTION
      // transactions. Without this pass, an APPROVED leave silently
      // double-charges the employee (existing absence deduction + new unpaid
      // deduction) or consumes their leave balance for a day that still
      // shows as ABSENT in their attendance history. We only run this for
      // APPROVED (never for REJECTED, which naturally leaves the ABSENT
      // record intact).
      if (status === "APPROVED") {
        const cleanupStart = new Date(leave.fromDate);
        const cleanupEnd = new Date(leave.toDate);
        const rangeHolidaysForCleanup = await tx.holiday.findMany({
          where: {
            adminId: leave.employee.adminId,
            date: { gte: cleanupStart, lte: cleanupEnd },
          },
          select: { date: true },
        });
        const cleanupHolidaySet = new Set(
          rangeHolidaysForCleanup.map((h) => formatDateIST(h.date))
        );

        for (
          let d = new Date(cleanupStart);
          d <= cleanupEnd;
          d.setDate(d.getDate() + 1)
        ) {
          const dateISTStr = formatDateIST(d);
          if (cleanupHolidaySet.has(dateISTStr)) continue;

          const dayStartUTC = moment
            .tz(dateISTStr, "Asia/Kolkata")
            .startOf("day")
            .utc()
            .toDate();
          const dayEndUTC = moment
            .tz(dateISTStr, "Asia/Kolkata")
            .endOf("day")
            .utc()
            .toDate();

          // 1) Convert any ABSENT row for that day to LEAVE. Rows that show
          //    PRESENT/LATE (employee actually worked) or HOLIDAY are left
          //    untouched — we don't want to overwrite worked days.
          await tx.attendance.updateMany({
            where: {
              empId: leave.empId,
              status: "ABSENT",
              date: { gte: dayStartUTC, lte: dayEndUTC },
            },
            data: { status: "LEAVE" },
          });

          // 2) Remove the paired per-day absence DEDUCTION transaction.
          //    Matched by the exact description prefix that finalize
          //    writes, so we don't accidentally delete unrelated
          //    deductions (bonuses/advances/etc. have different payType,
          //    unpaid-leave deductions have a different description).
          await tx.transaction.deleteMany({
            where: {
              empId: leave.empId,
              payType: "DEDUCTION",
              date: { gte: dayStartUTC, lte: dayEndUTC },
              description: {
                contains: `Salary deduction for absence on ${dateISTStr}`,
              },
            },
          });
        }
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

    // Include the current leave balance so the client shows an accurate
    // paid/unpaid preview without depending on separately-fetched state.
    const employee = await req.db.employee.findUnique({
      where: { id: Number(empId) },
      select: { leaveBalance: true },
    });

    res.json({
      empId: Number(empId),
      year: Number(year),
      leaveBalance: employee?.leaveBalance ?? 0,
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
