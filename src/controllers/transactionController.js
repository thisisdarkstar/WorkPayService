import moment from "moment-timezone";
import { sendApiError } from "../utils/errorHandler.js";

// Helper: convert UTC date to IST string
const toISTString = (utcDate) => {
  return moment.utc(utcDate).tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");
};

// ✅ Add Transaction API (for admin)
export const addTransaction = async (req, res) => {
  try {
    const { empId, amount, description, type, month, year, date } = req.body;

    if (!empId || !amount || !type) {
      return res.status(400).json({ error: "empId, amount and type are required" });
    }

    const employee = await req.db.employee.findFirst({
      where: { id: Number(empId), adminId: Number(req.admin.id) }
    });
    if (!employee) return res.status(404).json({ error: "Employee not found in your organization" });

    if (employee.status !== "ACTIVE") {
      return res.status(403).json({ error: `Cannot add ${type} for Inactive employee` });
    }

    // Determine target month and year
    const nowUTC = new Date();
    let txDateUTC = nowUTC;
    let targetYear = year ? Number(year) : moment.tz(nowUTC, "Asia/Kolkata").year();
    let targetMonth = month ? Number(month) : (moment.tz(nowUTC, "Asia/Kolkata").month() + 1);

    if (date) {
      txDateUTC = new Date(date);
      const mDate = moment.tz(txDateUTC, "Asia/Kolkata");
      targetYear = mDate.year();
      targetMonth = mDate.month() + 1;
    } else if (month && year) {
      const currentMoment = moment.tz(nowUTC, "Asia/Kolkata");
      const isCurrentMonth = currentMoment.year() === targetYear && (currentMoment.month() + 1) === targetMonth;
      if (isCurrentMonth) {
        txDateUTC = nowUTC;
      } else {
        // Attribute to target month (last second of the month in IST)
        txDateUTC = moment.tz([targetYear, targetMonth - 1, 1], "Asia/Kolkata").endOf("month").utc().toDate();
      }
    }

    const monthStartUTC = moment.tz([targetYear, targetMonth - 1, 1], "Asia/Kolkata").startOf("month").utc().toDate();
    const monthEndUTC = moment.tz([targetYear, targetMonth - 1, 1], "Asia/Kolkata").endOf("month").utc().toDate();
    const monthName = moment.tz([targetYear, targetMonth - 1, 1], "Asia/Kolkata").format("MMMM");

    // If SALARY, check if already settled for target month
    if (type === "SALARY") {
      const existingSalary = await req.db.transaction.findFirst({
        where: {
          empId: Number(empId),
          payType: "SALARY",
          date: { gte: monthStartUTC, lte: monthEndUTC }
        }
      });

      if (existingSalary) {
        return res.status(400).json({
          error: `Salary transaction has already been settled for this employee in ${monthName} ${targetYear}`
        });
      }
    }

    // Create transaction record (store UTC)
    const transaction = await req.db.transaction.create({
      data: {
        empId: Number(empId),
        amount: Number(amount),
        payType: type,
        description: description || null,
        date: txDateUTC
      },
      include: { employee: { select: { id: true, name: true } } }
    });

    res.json({
      message: "Transaction settled successfully",
      transaction: {
        ...transaction,
        date: toISTString(transaction.date) // Response in IST
      }
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to settle transaction");
  }
};

// ✅ Get employee transactions by year (IST-aware)
export const getEmployeeTransactions = async (req, res) => {
  try {
    const empId = req.employee.id;
    const { year } = req.query;

    if (!empId || !year) {
      return res.status(400).json({ error: "empId and year are required" });
    }

    const empIdNum = Number(empId);
    const yearNum = Number(year);

    const employee = await req.db.employee.findUnique({
      where: { id: empIdNum },
      select: { baseSalary: true, joinedDate: true }
    });

    if (!employee) return res.status(404).json({ error: "Employee not found" });

    // IST boundaries for year
    const yearStartUTC = moment.tz(`${year}-01-01 00:00:00`, "Asia/Kolkata").startOf("year").utc().toDate();
    const yearEndUTC = moment.tz(`${year}-01-01 00:00:00`, "Asia/Kolkata").endOf("year").utc().toDate();

    const transactions = await req.db.transaction.findMany({
      where: { empId: empIdNum, date: { gte: yearStartUTC, lte: yearEndUTC } },
      orderBy: { date: "asc" }
    });

    // Group by month and convert to IST
    const transactionsByMonth = {};
    transactions.forEach(t => {
      const monthName = moment.utc(t.date).tz("Asia/Kolkata").format("MMMM");
      if (!transactionsByMonth[monthName]) transactionsByMonth[monthName] = [];
      transactionsByMonth[monthName].push({ ...t, date: toISTString(t.date) });
    });

    const currentIST = moment.tz(new Date(), "Asia/Kolkata");
    const currentYear = currentIST.year();
    const currentMonthIndex = currentIST.month(); // 0-11
    const currentMonthName = currentIST.format("MMMM");

    const allMonthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];

    // Determine joining date in IST
    const employeeJoinedMoment = employee.joinedDate 
      ? moment.tz(employee.joinedDate, "Asia/Kolkata").startOf("month")
      : null;

    // Determine relevant past months:
    // Only include months on or after employee's joined date, OR months that have explicit transactions
    let relevantMonths = [];
    const maxMonthIndex = (yearNum === currentYear) ? currentMonthIndex - 1 : (yearNum < currentYear ? 11 : -1);

    if (maxMonthIndex >= 0) {
      for (let i = maxMonthIndex; i >= 0; i--) {
        const monthMoment = moment.tz([yearNum, i, 1], "Asia/Kolkata").startOf("month");
        const isAfterOrSameAsJoined = !employeeJoinedMoment || monthMoment.isSameOrAfter(employeeJoinedMoment, "month");
        const hasTransactions = Boolean(transactionsByMonth[allMonthNames[i]]?.length);

        if (isAfterOrSameAsJoined || hasTransactions) {
          relevantMonths.push(allMonthNames[i]);
        }
      }
    }

    // Include any other months that have transactions (e.g. out-of-order adjustments)
    Object.keys(transactionsByMonth).forEach(m => {
      if (m !== currentMonthName && !relevantMonths.includes(m)) {
        relevantMonths.push(m);
      }
    });

    const previousTransaction = relevantMonths.map(month => {
      const txs = transactionsByMonth[month] || [];
      const isPaid = txs.some(t => t.payType === "SALARY");
      return {
        month,
        baseSalary: employee.baseSalary,
        isPaid,
        transactions: txs
      };
    });

    // Current month employment check
    const currentMonthMoment = currentIST.clone().startOf("month");
    const isEmployedInCurrentMonth = !employeeJoinedMoment || currentMonthMoment.isSameOrAfter(employeeJoinedMoment, "month");
    const currentTxs = transactionsByMonth[currentMonthName] || [];
    const currentIsPaid = currentTxs.some(t => t.payType === "SALARY");

    let currentTransaction = null;
    if (isEmployedInCurrentMonth || currentTxs.length > 0) {
      currentTransaction = {
        month: currentMonthName,
        baseSalary: employee.baseSalary,
        isPaid: currentIsPaid,
        transactions: currentTxs,
        isBeforeJoining: false
      };
    } else {
      currentTransaction = {
        month: currentMonthName,
        baseSalary: employee.baseSalary,
        isPaid: false,
        transactions: [],
        isBeforeJoining: true
      };
    }

    res.json({
      year: yearNum,
      currentTransaction,
      baseSalary: employee.baseSalary,
      joinedDate: employee.joinedDate ? moment.tz(employee.joinedDate, "Asia/Kolkata").format("YYYY-MM-DD") : null,
      previousTransaction
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch employee transactions");
  }
};

// ✅ Get monthly transactions for all employees (IST-aware)
// Shows employees who were employed during the requested month (or have transactions in it)
export const getMonthlyTransactions = async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) return res.status(400).json({ error: "month and year are required" });

    const monthNum = Number(month);
    const yearNum = Number(year);

    const monthStartUTC = moment.tz([yearNum, monthNum - 1, 1], "Asia/Kolkata").startOf("month").utc().toDate();
    const monthEndUTC = moment.tz([yearNum, monthNum - 1, 1], "Asia/Kolkata").endOf("month").utc().toDate();

    const currentMonthIST = moment.tz(new Date(), "Asia/Kolkata");
    const requestedMonthIST = moment.tz([yearNum, monthNum - 1, 1], "Asia/Kolkata");
    const isCurrentMonth = currentMonthIST.isSame(requestedMonthIST, 'month') && currentMonthIST.isSame(requestedMonthIST, 'year');

    const adminId = Number(req.admin.id);

    // Get transactions for this month for THIS admin's employees
    const transactions = await req.db.transaction.findMany({
      where: {
        date: { gte: monthStartUTC, lte: monthEndUTC },
        employee: { adminId }
      },
      orderBy: { date: "asc" },
      include: { employee: { select: { id: true, name: true, phone: true, baseSalary: true } } }
    });

    // Fetch all active employees for this admin
    const allEmployees = await req.db.employee.findMany({
      where: { adminId },
      select: { 
        id: true, 
        name: true, 
        phone: true, 
        baseSalary: true, 
        status: true,
        officeId: true,
        joinedDate: true,
        office: { select: { id: true, name: true } }
      },
      orderBy: { name: 'asc' }
    });

    const requestedMonthMomentEnd = moment.tz([yearNum, monthNum - 1, 1], "Asia/Kolkata").endOf("month");

    // Filter employees: an employee is eligible for this month's payroll if:
    // 1. Their joinedDate is on or before the requested month end, OR
    // 2. They have transactions recorded in this month
    const eligibleEmployees = allEmployees.filter(employee => {
      const hasTransactions = transactions.some(t => t.empId === employee.id);
      if (hasTransactions) return true;

      const empJoinedMoment = employee.joinedDate 
        ? moment.tz(employee.joinedDate, "Asia/Kolkata").startOf("month")
        : null;

      if (!empJoinedMoment) return true;
      return empJoinedMoment.isSameOrBefore(requestedMonthMomentEnd);
    });

    const payments = eligibleEmployees.map(employee => {
      const employeeTransactions = transactions
        .filter(t => t.empId === employee.id)
        .map(t => ({
          id: t.id,
          amount: t.amount,
          date: toISTString(t.date),
          payType: t.payType,
          description: t.description
        }));

      const isPaid = employeeTransactions.some(t => t.payType === "SALARY");

      return {
        empId: employee.id,
        name: employee.name,
        phone: employee.phone,
        baseSalary: employee.baseSalary,
        status: employee.status,
        officeId: employee.officeId,
        officeName: employee.office?.name || null,
        joinedDate: employee.joinedDate ? moment.tz(employee.joinedDate, "Asia/Kolkata").format("YYYY-MM-DD") : null,
        isPaid,
        transactions: employeeTransactions
      };
    });

    res.json({
      month: moment.tz(monthStartUTC, "Asia/Kolkata").format("MMMM"),
      year: yearNum,
      isCurrentMonth,
      payments
    });
  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch monthly transactions");
  }
};

// ✅ Get employee transactions for admin by year (IST-aware)
export const getEmployeeTransactionsAdmin = async (req, res) => {
  try {
    const { empId, year } = req.query;
    if (!empId || !year) return res.status(400).json({ error: "empId and year are required" });

    const empIdNum = Number(empId);
    const yearNum = Number(year);

    const employee = await req.db.employee.findFirst({
      where: { id: empIdNum, adminId: Number(req.admin.id) },
      select: { baseSalary: true }
    });
    if (!employee) return res.status(404).json({ error: "Employee not found in your organization" });

    const yearStartUTC = moment.tz([yearNum, 0, 1], "Asia/Kolkata").startOf("year").utc().toDate();
    const yearEndUTC = moment.tz([yearNum, 0, 1], "Asia/Kolkata").endOf("year").utc().toDate();

    const transactions = await req.db.transaction.findMany({
      where: { empId: empIdNum, date: { gte: yearStartUTC, lte: yearEndUTC } },
      orderBy: { date: "desc" }
    });

    // Group by month
    const transactionsData = {};
    transactions.forEach(t => {
      const monthName = moment.utc(t.date).tz("Asia/Kolkata").format("MMMM");
      if (!transactionsData[monthName]) transactionsData[monthName] = [];
      transactionsData[monthName].push({ ...t, date: toISTString(t.date) });
    });

    // Sort months in descending order
    const monthOrder = ["December","November","October","September","August","July","June","May","April","March","February","January"];
    const sortedTransactions = monthOrder
      .filter(m => transactionsData[m])
      .map(m => ({ month: m, transactions: transactionsData[m] }));

    res.json({
      empId: empIdNum,
      year: yearNum,
      baseSalary: employee.baseSalary,
      transactionsData: sortedTransactions
    });

  } catch (error) {
    return sendApiError(res, error, 500, "Failed to fetch employee transactions");
  }
};
