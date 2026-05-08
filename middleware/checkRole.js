const pool = require("../db/pool");

const checkRole = (allowedRoles) => {
  return async (req, res, next) => {
    try {
      const clerkId = req.headers["clerk-id"];

      if (!clerkId) {
        return res.status(401).json({ message: "No user" });
      }

      const result = await pool.query(
        "SELECT id, clerk_user_id, name, role FROM users WHERE clerk_user_id = $1",
        [clerkId]
      );

      const user = result.rows[0];

      if (!user || !allowedRoles.includes(user.role)) {
        return res.status(403).json({ message: "Forbidden" });
      }

      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
};

module.exports = checkRole;
