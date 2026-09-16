import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// ✅ Admin Login (supports email or phone)
export const loginAdmin = async (req, res) => {
  try {
    const { email, phone, password } = req.body;

    if ((!email && !phone) || !password) {
      return res.status(400).json({ error: "Email or phone, and password are required" });
    }

    const admin = await req.db.admin.findFirst({
      where: {
        OR: [
          email ? { email } : undefined,
          phone ? { phone } : undefined,
        ].filter(Boolean),
      },
    });

    if (!admin) return res.status(404).json({ error: "Admin not found" });

    const isPasswordValid = await bcrypt.compare(password, admin.password);
    if (!isPasswordValid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: admin.id, email: admin.email, phone: admin.phone, role: "admin" },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({ message: "Login successful", token });
  } catch (error) {
    console.error("Admin Login error:", error);
    res.status(500).json({ error: "Failed to login admin" });
  }
};

// Create Admin (Guarded against unauthorized HTTP creation; use internal script 'npm run create-admin')
export const createAdmin = async (req, res) => {
  try {
    const superAdminSecret = process.env.SUPER_ADMIN_SECRET_KEY;
    const providedKey = req.headers["x-super-admin-key"];

    if (!superAdminSecret || providedKey !== superAdminSecret) {
      return res.status(403).json({
        error: "Forbidden: Direct admin creation via HTTP is disabled. Please use the internal CLI script 'npm run create-admin' or provide a valid 'x-super-admin-key' header.",
      });
    }

    const { name, phone, email, password } = req.body;

    if (!name || !phone || !email || !password) {
      return res.status(400).json({ error: "Name, phone, email, and password are required" });
    }

    const existingAdmin = await req.db.admin.findFirst({
      where: {
        OR: [{ email }, { phone }],
      },
    });

    if (existingAdmin) {
      return res.status(400).json({
        error: existingAdmin.email === email
          ? "An admin with this email already exists"
          : "An admin with this phone number already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const admin = await req.db.admin.create({
      data: { name, phone, email, password: hashedPassword },
      select: { id: true, name: true, phone: true, email: true },
    });

    res.status(201).json({
      message: "Admin created successfully",
      admin,
    });
  } catch (error) {
    console.error("Create Admin error:", error);
    res.status(500).json({ error: "Failed to create admin" });
  }
};

// Get Admin by ID (excludes password hash)
export const getAdminById = async (req, res) => {
  try {
    const { id } = req.params;
    if (req.admin && req.admin.id !== Number(id)) {
      return res.status(403).json({ error: "Unauthorized access: you can only view your own profile" });
    }

    const admin = await req.db.admin.findUnique({
      where: { id: Number(id) },
      select: { id: true, name: true, phone: true, email: true },
    });

    if (!admin) return res.status(404).json({ error: "Admin not found" });
    res.json(admin);
  } catch (error) {
    console.error("Fetch Admin error:", error);
    res.status(500).json({ error: "Failed to fetch admin" });
  }
};

// Update Admin (excludes password hash)
export const updateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (req.admin && req.admin.id !== Number(id)) {
      return res.status(403).json({ error: "Unauthorized access: you can only update your own profile" });
    }

    const { name, email, phone } = req.body;

    const data = {};
    if (name) data.name = name;
    if (email) data.email = email;
    if (phone) data.phone = phone;

    const updatedAdmin = await req.db.admin.update({
      where: { id: Number(id) },
      data,
      select: { id: true, name: true, phone: true, email: true },
    });

    res.json(updatedAdmin);
  } catch (error) {
    console.error("Update Admin error:", error);
    res.status(500).json({ error: "Failed to update admin" });
  }
};

// Delete Admin
export const deleteAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (req.admin && req.admin.id !== Number(id)) {
      return res.status(403).json({ error: "Unauthorized access: you can only delete your own profile" });
    }

    await req.db.admin.delete({ where: { id: Number(id) } });

    res.json({ message: "Admin deleted successfully" });
  } catch (error) {
    console.error("Delete Admin error:", error);
    res.status(500).json({ error: "Failed to delete admin" });
  }
};

// Reset password with Phone
export const resetPasswordWithPhone = async (req, res) => {
  try {
    const { phone, newPassword } = req.body;
    if (!phone || !newPassword) return res.status(400).json({ error: "Phone and new password required" });

    const admin = await req.db.admin.findUnique({ where: { phone } });
    if (!admin) return res.status(404).json({ error: "Admin not found" });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await req.db.admin.update({ where: { phone }, data: { password: hashedPassword } });

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Reset Admin Password error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
};

// Get Admin by Phone
export const getAdminByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) return res.status(400).json({ error: "Phone number required" });

    const admin = await req.db.admin.findUnique({ where: { phone } });
    res.json({ adminFound: !!admin });
  } catch (error) {
    console.error("Get Admin by Phone error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
};
