import jwt from "jsonwebtoken";
import prisma from "../prisma.js";
import { sendApiError } from "../utils/errorHandler.js";
import { JWT_SECRET } from "../config/jwt.js";

// ✅ Verify Admin token & check DB
export const adminAuth = async (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.role !== "admin") {
      return res.status(403).json({ error: "Admin access only" });
    }

    // 🔎 Check if admin exists in DB
    const db = req.db || prisma;
    const admin = await db.admin.findUnique({ where: { id: decoded.id } });
    if (!admin) {
      return res.status(401).json({ error: "Admin not found" });
    }

    // H-02: Invalidate tokens issued before the last password change so that a
    // password reset/change revokes all previously issued sessions.
    if (admin.passwordChangedAt && decoded.iat) {
      const tokenIssuedAtMs = decoded.iat * 1000;
      if (tokenIssuedAtMs < admin.passwordChangedAt.getTime()) {
        return res.status(401).json({ error: "Session expired, please login again" });
      }
    }

    req.admin = admin; // attach DB record
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired, please login again" });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }

    return sendApiError(res, error, 500, "Authentication failed");
  }
};

// ✅ Verify Employee token & check DB
export const employeeAuth = async (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.role !== "employee") {
      return res.status(403).json({ error: "Employee access only" });
    }

    // 🔎 Check if employee exists in DB
    const db = req.db || prisma;
    const employee = await db.employee.findUnique({ where: { id: decoded.id } });
    if (!employee) {
      return res.status(401).json({ error: "Employee not found" });
    }

    if (employee.status !== "ACTIVE") {
      return res.status(403).json({ error: "Account is inactive. Please contact your administrator." });
    }

    // H-02: Invalidate tokens issued before the last password change.
    if (employee.passwordChangedAt && decoded.iat) {
      const tokenIssuedAtMs = decoded.iat * 1000;
      if (tokenIssuedAtMs < employee.passwordChangedAt.getTime()) {
        return res.status(401).json({ error: "Session expired, please login again" });
      }
    }

    req.employee = employee; // attach DB record
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired, please login again" });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }

    return sendApiError(res, error, 500, "Authentication failed");
  }
};

// ✅ Common middleware for both admin & employee
export const adminOrEmployeeAuth = async (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    let user = null;
    const db = req.db || prisma;

    if (decoded.role === "admin") {
      user = await db.admin.findUnique({ where: { id: decoded.id } });
    } else if (decoded.role === "employee") {
      user = await db.employee.findUnique({ where: { id: decoded.id } });
      if (user && user.status !== "ACTIVE") {
        return res.status(403).json({ error: "Account is inactive. Please contact your administrator." });
      }
    }

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // H-02: Invalidate tokens issued before the last password change.
    if (user.passwordChangedAt && decoded.iat) {
      const tokenIssuedAtMs = decoded.iat * 1000;
      if (tokenIssuedAtMs < user.passwordChangedAt.getTime()) {
        return res.status(401).json({ error: "Session expired, please login again" });
      }
    }

    req.user = { ...decoded, dbUser: user };
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired, please login again" });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }

    return sendApiError(res, error, 500, "Authentication failed");
  }
};
