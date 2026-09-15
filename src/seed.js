import bcrypt from "bcrypt";
import moment from "moment";

import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function main() {
  // 🧹 Clean DB
  await prisma.transaction.deleteMany();
  await prisma.attendance.deleteMany();
  await prisma.leave.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.admin.deleteMany();
  await prisma.office.deleteMany();
  await prisma.holiday.deleteMany();

  // 🔑 Hash passwords
  const adminPassword = await bcrypt.hash("Admin@123", 10);
  const chiranjeebPassword = await bcrypt.hash("1234567890", 10);
  const empPassword = await bcrypt.hash("Emp@123", 10);

  // 👨‍💼 Create Primary Admin
  const admin = await prisma.admin.create({
    data: {
      name: "Chiranjeeb Nayak",
      phone: "1234567890",
      email: "chiranjeebnayak.37@gmail.com",
      password: chiranjeebPassword,
    },
  });

  // 👨‍💼 Create Demo Admin
  await prisma.admin.create({
    data: {
      name: "System Admin",
      phone: "9999999999",
      email: "admin@demo.com",
      password: adminPassword,
    },
  });

  // 🏢 Create Office
  const office = await prisma.office.create({
    data: {
      name: "Head Office",
      latitude: 12.9716,
      longitude: 77.5946,
      checkin: new Date("2025-09-01T03:30:00Z"),
      checkout: new Date("2025-09-01T13:00:00Z"),
      breakTime: 60,
      adminId: admin.id,
    },
  });

  // 👨‍💻 Create Employee
  const employee = await prisma.employee.create({
    data: {
      name: "Ravi Kumar",
      phone: "8888888888",
      email: "ravi@demo.com",
      password: empPassword,
      baseSalary: 30000,
      overtimeRate: 200,
      leaveBalance: 10,
      joinedDate: new Date("2025-08-01T00:00:00Z"),
      officeId: office.id,
      adminId: admin.id,
    },
  });

  // 🎉 Holidays
  await prisma.holiday.createMany({
    data: [
      {
        description: "Independence Day",
        date: moment("2025-08-15").startOf("day").toDate(),
        adminId: admin.id,
      },
      {
        description: "Gandhi Jayanti",
        date: moment("2025-10-02").startOf("day").toDate(),
        adminId: admin.id,
      },
    ],
  });

  // ------------------------- JULY -------------------------
  const julyStart = moment("2025-07-01");
  const julyEnd = moment("2025-07-31");

  for (let d = julyStart.clone(); d.isSameOrBefore(julyEnd); d.add(1, "day")) {

    const checkIn = d.clone().hour(9).minute(5).toDate();
    const checkOut = d.clone().hour(17).minute(50).toDate();
    const overtimeHours = Math.random() < 0.3 ? Math.floor(Math.random() * 3) : 0; // 0–2 hrs
    const overtimeMinutes = overtimeHours * 60;

    await prisma.attendance.create({
      data: {
        empId: employee.id,
        date: d.toDate(),
        checkInTime: checkIn,
        checkOutTime: checkOut,
        overTime: overtimeMinutes,
        status: "PRESENT",
      },
    });

    if (overtimeMinutes > 0) {
      await prisma.transaction.create({
        data: {
          empId: employee.id,
          amount: (overtimeMinutes / 60) * 190, // July overtime rate
          date: d.toDate(),
          payType: "OVERTIME",
          description: `${overtimeMinutes} mins overtime on ${d.format("YYYY-MM-DD")}`,
        },
      });
    }
  }

  // Salary & Deduction for July
  await prisma.transaction.create({
    data: {
      empId: employee.id,
      amount: 29500,
      date: moment("2025-07-31").endOf("day").toDate(),
      payType: "SALARY",
      description: "Salary for July 2025",
    },
  });

  await prisma.transaction.create({
    data: {
      empId: employee.id,
      amount: 600,
      date: moment("2025-07-31").endOf("day").toDate(),
      payType: "DEDUCTION",
      description: "Late coming fine for July 2025",
    },
  });

  // ------------------------- AUGUST -------------------------
  const augStart = moment("2025-08-01");
  const augEnd = moment("2025-08-31");

  for (let d = augStart.clone(); d.isSameOrBefore(augEnd); d.add(1, "day")) {


    // Random leave
    if (Math.random() < 0.025) {
      await prisma.leave.create({
        data: {
          empId: employee.id,
          reason: "Sister's wedding",
          fromDate: d.toDate(),
          toDate: d.toDate(),
          totalDays: 1,
          type: "PAID",
          status: "APPROVED",
        },
      });
      continue;
    }

    const checkIn = d.clone().hour(9).minute(10).toDate();
    const checkOut = d.clone().hour(18).minute(15).toDate();
    const overtimeHours = Math.random() < 0.2 ? Math.floor(Math.random() * 3) : 0;
    const overtimeMinutes = overtimeHours * 60;

    await prisma.attendance.create({
      data: {
        empId: employee.id,
        date: d.toDate(),
        checkInTime: checkIn,
        checkOutTime: checkOut,
        overTime: overtimeMinutes,
        status: "PRESENT",
      },
    });

    if (overtimeMinutes > 0) {
      await prisma.transaction.create({
        data: {
          empId: employee.id,
          amount: (overtimeMinutes / 60) * 200, // August rate
          date: d.toDate(),
          payType: "OVERTIME",
          description: `${overtimeMinutes} mins overtime on ${d.format("YYYY-MM-DD")}`,
        },
      });
    }
  }

  // Salary & Deduction for August
  await prisma.transaction.create({
    data: {
      empId: employee.id,
      amount: 30000,
      date: moment("2025-08-31").endOf("day").toDate(),
      payType: "SALARY",
      description: "Salary for August 2025",
    },
  });

  await prisma.transaction.create({
    data: {
      empId: employee.id,
      amount: 500,
      date: moment("2025-08-31").endOf("day").toDate(),
      payType: "DEDUCTION",
      description: "Late coming fine for August 2025",
    },
  });

  // ------------------------- SEPTEMBER (Partial Month) -------------------------
  const sepStart = moment("2025-09-01");
  const sepEnd = moment("2025-09-19"); // can adjust to current day

  for (let d = sepStart.clone(); d.isSameOrBefore(sepEnd); d.add(1, "day")) {


    const checkIn = d.clone().hour(9).minute(10).toDate();
    const checkOut = d.clone().hour(18).minute(0).toDate();
    const overtimeHours = Math.random() < 0.25 ? Math.floor(Math.random() * 3) : 0;
    const overtimeMinutes = overtimeHours * 60;

    await prisma.attendance.create({
      data: {
        empId: employee.id,
        date: d.toDate(),
        checkInTime: checkIn,
        checkOutTime: checkOut,
        overTime: overtimeMinutes,
        status: "PRESENT",
      },
    });

    if (overtimeMinutes > 0) {
      await prisma.transaction.create({
        data: {
          empId: employee.id,
          amount: (overtimeMinutes / 60) * 200,
          date: d.toDate(),
          payType: "OVERTIME",
          description: `${overtimeMinutes} mins overtime on ${d.format("YYYY-MM-DD")}`,
        },
      });
    }

    // Random small deduction
    if (Math.random() < 0.1) {
      await prisma.transaction.create({
        data: {
          empId: employee.id,
          amount: 100,
          date: d.toDate(),
          payType: "DEDUCTION",
          description: `Late coming fine on ${d.format("YYYY-MM-DD")}`,
        },
      });
    }
  }

  // Advance Payment in September
  await prisma.transaction.create({
    data: {
      empId: employee.id,
      amount: 5000,
      date: moment("2025-09-05").toDate(),
      payType: "ADVANCE",
      description: "Advance payment for September 2025",
    },
  });

  console.log("✅ Seed data inserted (July, August & September).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
