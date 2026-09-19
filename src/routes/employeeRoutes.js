import express from "express";
import {
  createEmployee,
  getEmployees,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
  loginEmployee,
  resetPasswordWithPhone,
  resetPasswordWithJWT,
  adminResetEmployeePassword,
  getEmployeeByPhone,
  getEmployeeDashboard,
  updateEmployeeStatus,
  updateBankDetails
} from "../controllers/employeeController.js";
import { adminAuth,employeeAuth } from "../Middleware/authMiddleware.js";

const router = express.Router();

router.post("/add", adminAuth, createEmployee);         // Create employee
router.get("/getAll", adminAuth, getEmployees);            // Get all employees
router.get("/get/:id", adminAuth, getEmployeeById);      // Get single employee
router.put("/update/:id", adminAuth, updateEmployee);       // Update employee
router.put("/update-status/:id", adminAuth, updateEmployeeStatus); // Update employee status
router.delete("/delete/:id", adminAuth, deleteEmployee);
router.post("/admin-reset-password/:id", adminAuth, adminResetEmployeePassword); // Admin reset employee password

//login routes
router.post("/login", loginEmployee);
router.post("/reset-password",resetPasswordWithPhone);
router.post("/update-password",employeeAuth,resetPasswordWithJWT);
router.get("/phone/:phone", adminAuth, getEmployeeByPhone); // Get employee by phone (protected; prevents anonymous enumeration - H-01)



router.get("/dashboard",employeeAuth, getEmployeeDashboard); // Get employee dashboard details
router.put("/update-bank",employeeAuth,updateBankDetails)

export default router;
