const express = require("express");
const cors = require("cors");

require("dotenv").config();

const pool = require("./db");
const checkRole = require("./middleware/checkRole");

const app = express();
const PORT = process.env.PORT || 5000;
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
  })
);
app.use(express.json());

const asyncHandler = (handler) => async (req, res, next) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    next(error);
  }
};

app.get("/", (req, res) => {
  res.json({ message: "SkillBridge backend running" });
});

app.get(
  "/test-db",
  asyncHandler(async (req, res) => {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  })
);

app.get(
  "/test-users",
  asyncHandler(async (req, res) => {
    const result = await pool.query("SELECT * FROM users");
    res.json(result.rows);
  })
);

app.post(
  "/save-user",
  asyncHandler(async (req, res) => {
    const { clerk_user_id, name, role } = req.body;

    if (!clerk_user_id || !role) {
      return res
        .status(400)
        .json({ message: "clerk_user_id and role are required" });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE clerk_user_id = $1",
      [clerk_user_id]
    );

    if (existing.rows[0]) {
      const result = await pool.query(
        "UPDATE users SET name = $1, role = $2 WHERE clerk_user_id = $3 RETURNING *",
        [name || "User", role, clerk_user_id]
      );

      return res.status(200).json(result.rows[0]);
    }

    const result = await pool.query(
      "INSERT INTO users (clerk_user_id, name, role) VALUES ($1,$2,$3) RETURNING *",
      [clerk_user_id, name || "User", role]
    );

    res.status(201).json(result.rows[0]);
  })
);

app.get(
  "/get-user/:clerkId",
  asyncHandler(async (req, res) => {
    const { clerkId } = req.params;

    const result = await pool.query(
      "SELECT * FROM users WHERE clerk_user_id = $1",
      [clerkId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);
  })
);

app.post(
  "/batches",
  checkRole(["trainer"]),
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    const trainerId = req.user.id;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Batch name is required" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const batchResult = await client.query(
        "INSERT INTO batches (name) VALUES ($1) RETURNING *",
        [name.trim()]
      );
      const batch = batchResult.rows[0];

      await client.query(
        "INSERT INTO batch_trainers (batch_id, trainer_id) VALUES ($1,$2) ON CONFLICT (batch_id, trainer_id) DO NOTHING",
        [batch.id, trainerId]
      );

      await client.query("COMMIT");
      res.status(201).json(batch);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

app.get(
  "/trainer/batches",
  checkRole(["trainer"]),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT batches.*,
              COUNT(batch_students.student_id)::int AS student_count
       FROM batches
       INNER JOIN batch_trainers ON batch_trainers.batch_id = batches.id
       LEFT JOIN batch_students ON batch_students.batch_id = batches.id
       WHERE batch_trainers.trainer_id = $1
       GROUP BY batches.id
       ORDER BY batches.id DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  })
);

app.get(
  "/batches/:batchId",
  asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    const result = await pool.query("SELECT * FROM batches WHERE id = $1", [
      batchId,
    ]);

    if (!result.rows[0]) {
      return res.status(404).json({ message: "Batch not found" });
    }

    res.json(result.rows[0]);
  })
);

app.post(
  "/join-batch/:batchId",
  checkRole(["student"]),
  asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    const studentId = req.user.id;

    const batch = await pool.query("SELECT id, name FROM batches WHERE id = $1", [
      batchId,
    ]);

    if (!batch.rows[0]) {
      return res.status(404).json({ message: "Batch not found" });
    }

    await pool.query(
      "INSERT INTO batch_students (batch_id, student_id) VALUES ($1,$2) ON CONFLICT (batch_id, student_id) DO NOTHING",
      [batchId, studentId]
    );

    res.json({
      message: "Joined batch",
      batch: batch.rows[0],
    });
  })
);

app.post(
  "/create-session",
  checkRole(["trainer"]),
  asyncHandler(async (req, res) => {
    const { title, batch_id, date } = req.body;
    const trainerId = req.user.id;

    if (!title || !date || !batch_id) {
      return res
        .status(400)
        .json({ message: "title, date, and batch_id are required" });
    }

    const batchAccess = await pool.query(
      "SELECT id FROM batch_trainers WHERE batch_id = $1 AND trainer_id = $2",
      [batch_id, trainerId]
    );

    if (!batchAccess.rows[0]) {
      return res.status(403).json({ message: "You do not own this batch" });
    }

    const result = await pool.query(
      "INSERT INTO sessions (title, batch_id, trainer_id, date) VALUES ($1,$2,$3,$4) RETURNING *",
      [title, batch_id, trainerId, date]
    );

    res.status(201).json(result.rows[0]);
  })
);

app.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const clerkId = req.headers["clerk-id"];

    if (clerkId) {
      const userResult = await pool.query(
        "SELECT id, role FROM users WHERE clerk_user_id = $1",
        [clerkId]
      );
      const user = userResult.rows[0];

      if (user?.role === "trainer") {
        const result = await pool.query(
          `SELECT sessions.*, users.name AS trainer_name, batches.name AS batch_name
           FROM sessions
           LEFT JOIN users ON users.id = sessions.trainer_id
           LEFT JOIN batches ON batches.id = sessions.batch_id
           WHERE sessions.trainer_id = $1
           ORDER BY sessions.id DESC`,
          [user.id]
        );
        return res.json(result.rows);
      }

      if (user?.role === "student") {
        const result = await pool.query(
          `SELECT sessions.*, users.name AS trainer_name, batches.name AS batch_name
           FROM sessions
           INNER JOIN batch_students ON batch_students.batch_id = sessions.batch_id
           LEFT JOIN users ON users.id = sessions.trainer_id
           LEFT JOIN batches ON batches.id = sessions.batch_id
           WHERE batch_students.student_id = $1
           ORDER BY sessions.id DESC`,
          [user.id]
        );
        return res.json(result.rows);
      }
    }

    const result = await pool.query(
      `SELECT sessions.*, users.name AS trainer_name, batches.name AS batch_name
       FROM sessions
       LEFT JOIN users ON users.id = sessions.trainer_id
       LEFT JOIN batches ON batches.id = sessions.batch_id
       ORDER BY sessions.id DESC`
    );
    res.json(result.rows);
  })
);

app.post(
  "/mark-attendance",
  checkRole(["student"]),
  asyncHandler(async (req, res) => {
    const { session_id } = req.body;
    const studentId = req.user.id;

    if (!session_id) {
      return res.status(400).json({ message: "session_id is required" });
    }

    const existing = await pool.query(
      "SELECT id FROM attendance WHERE session_id = $1 AND student_id = $2",
      [session_id, studentId]
    );

    if (existing.rows[0]) {
      return res.status(200).json({ message: "Attendance already marked" });
    }

    const result = await pool.query(
      "INSERT INTO attendance (session_id, student_id, status) VALUES ($1,$2,$3) RETURNING *",
      [session_id, studentId, "present"]
    );

    res.status(201).json(result.rows[0]);
  })
);

app.get(
  "/session-attendance/:sessionId",
  checkRole(["trainer", "institution"]),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    const result = await pool.query(
      `SELECT attendance.*, users.name AS student_name
       FROM attendance
       LEFT JOIN users ON users.id = attendance.student_id
       WHERE attendance.session_id = $1
       ORDER BY attendance.id DESC`,
      [sessionId]
    );

    res.json(result.rows);
  })
);

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ message: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
