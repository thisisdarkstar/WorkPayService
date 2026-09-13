import express from "express";
import { handleAttendance ,getEmployeeAttendanceByMonth,getTodayAttendanceDashboard ,getEmployeeAttendanceByMonthInAdmin,
    checkBulkAttendanceStatus,markAttendanceForAbsentEmployees,getEmployeesByAttendanceStatus,
    cronAutoFinalize
} from "../controllers/attendanceController.js";
import { employeeAuth ,adminAuth} from "../Middleware/authMiddleware.js";


const router = express.Router();

// Single route to handle both check-in and check-out
router.post("/mark", employeeAuth, handleAttendance);
router.get("/getAttendance",employeeAuth, getEmployeeAttendanceByMonth);
router.get("/getTodayAttendance", adminAuth, getTodayAttendanceDashboard);
router.get("/getTodayAttendance/:officeId", adminAuth, getTodayAttendanceDashboard);
router.get("/checkBulkAttendanceStatus",adminAuth, checkBulkAttendanceStatus);
router.get("/checkBulkAttendanceStatus/:officeId",adminAuth, checkBulkAttendanceStatus);
router.post("/finalizeAttendance",adminAuth, markAttendanceForAbsentEmployees);
router.post("/finalizeAttendance/:officeId",adminAuth, markAttendanceForAbsentEmployees);
router.get("/getEmployeeAttendance",adminAuth,getEmployeeAttendanceByMonthInAdmin);
router.get("/getEmployeesByStatus/:officeId/:status",adminAuth,getEmployeesByAttendanceStatus);
router.get("/cron-auto-finalize", cronAutoFinalize);
router.post("/cron-auto-finalize", cronAutoFinalize);


export default router;
