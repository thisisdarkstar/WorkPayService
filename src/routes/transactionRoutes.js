import express from "express";
import { addTransaction, getEmployeeTransactions,getMonthlyTransactions,getEmployeeTransactionsAdmin, revertSalary } from "../controllers/transactionController.js";
import { employeeAuth ,adminAuth} from "../Middleware/authMiddleware.js";

const transactionRouter = express.Router();

transactionRouter.post("/add-transaction", adminAuth,addTransaction);
transactionRouter.post("/revert-salary", adminAuth, revertSalary);
transactionRouter.get("/employee",employeeAuth, getEmployeeTransactions);
transactionRouter.get("/monthly-transactions", adminAuth, getMonthlyTransactions);
transactionRouter.get("/get/monthly-transactions",adminAuth,getEmployeeTransactionsAdmin)

export default transactionRouter;
 


