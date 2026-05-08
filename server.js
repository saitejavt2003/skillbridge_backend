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
  checkRole(["trainer", "institution"]),
  asyncHandler(async (req, res) => {
    const { name, trainer_id } = req.body;
    const ownerId = req.user.id;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Batch name is required" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const batchResult = await client.query(
        "INSERT INTO batches (name, institution_id) VALUES ($1,$2) RETURNING *",
        [name.trim(), req.user.role === "institution" ? ownerId : null]
      );
      const batch = batchResult.rows[0];

      if (req.user.role === "trainer") {
        await client.query(
          "INSERT INTO batch_trainers (batch_id, trainer_id) VALUES ($1,$2) ON CONFLICT (batch_id, trainer_id) DO NOTHING",
          [batch.id, ownerId]
        );
      }

      if (req.user.role === "institution" && trainer_id) {
        const trainer = await client.query(
          "SELECT id FROM users WHERE id = $1 AND role = 'trainer' AND institution_id = $2",
          [trainer_id, ownerId]
        );

        if (!trainer.rows[0]) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ message: "Trainer is not linked to this institution" });
        }

        await client.query(
          "INSERT INTO batch_trainers (batch_id, trainer_id) VALUES ($1,$2) ON CONFLICT (batch_id, trainer_id) DO NOTHING",
          [batch.id, trainer_id]
        );
      }

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
  "/batches/institution",
  checkRole(["institution"]),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `WITH batch_stats AS (
         SELECT batches.id,
                COUNT(DISTINCT batch_students.student_id)::int AS student_count,
                COUNT(DISTINCT sessions.id)::int AS session_count,
                COUNT(DISTINCT attendance.id)::int AS attended_count
         FROM batches
         LEFT JOIN batch_students ON batch_students.batch_id = batches.id
         LEFT JOIN sessions ON sessions.batch_id = batches.id
         LEFT JOIN attendance ON attendance.session_id = sessions.id
          AND attendance.student_id = batch_students.student_id
         WHERE batches.institution_id = $1
         GROUP BY batches.id
       )
       SELECT batches.*,
              batch_stats.student_count,
              batch_stats.session_count,
              CASE
                WHEN batch_stats.student_count * batch_stats.session_count = 0 THEN 0
                ELSE ROUND(
                  batch_stats.attended_count::numeric /
                  (batch_stats.student_count * batch_stats.session_count) * 100,
                  2
                )
              END AS attendance_percentage
       FROM batches
       INNER JOIN batch_stats ON batch_stats.id = batches.id
       ORDER BY batches.id DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  })
);

app.get(
  "/institution/trainers",
  checkRole(["institution"]),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT users.id,
              users.clerk_user_id,
              users.name,
              COUNT(DISTINCT batch_trainers.batch_id)::int AS batch_count
       FROM users
       LEFT JOIN batch_trainers ON batch_trainers.trainer_id = users.id
       LEFT JOIN batches ON batches.id = batch_trainers.batch_id
       WHERE users.role = 'trainer'
         AND users.institution_id = $1
       GROUP BY users.id
       ORDER BY users.id DESC`,
      [req.user.id]
    );

    res.json(result.rows);
  })
);

app.post(
  "/trainers/assign",
  checkRole(["institution"]),
  asyncHandler(async (req, res) => {
    const { clerk_user_id, name, batch_id } = req.body;

    if (!clerk_user_id || !name) {
      return res
        .status(400)
        .json({ message: "Trainer clerk_user_id and name are required" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const trainerResult = await client.query(
        `INSERT INTO users (clerk_user_id, name, role, institution_id)
         VALUES ($1,$2,'trainer',$3)
         ON CONFLICT (clerk_user_id)
         DO UPDATE SET name = EXCLUDED.name,
                       role = 'trainer',
                       institution_id = EXCLUDED.institution_id
         RETURNING *`,
        [clerk_user_id, name, req.user.id]
      );
      const trainer = trainerResult.rows[0];

      if (batch_id) {
        const batch = await client.query(
          "SELECT id FROM batches WHERE id = $1 AND institution_id = $2",
          [batch_id, req.user.id]
        );

        if (!batch.rows[0]) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ message: "Batch does not belong to this institution" });
        }

        await client.query(
          "INSERT INTO batch_trainers (batch_id, trainer_id) VALUES ($1,$2) ON CONFLICT (batch_id, trainer_id) DO NOTHING",
          [batch_id, trainer.id]
        );
      }

      await client.query("COMMIT");
      res.status(201).json(trainer);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

app.get(
  "/batches/:id/summary",
  checkRole(["institution", "trainer"]),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const params = [id];
    let accessClause = "";

    if (req.user.role === "institution") {
      params.push(req.user.id);
      accessClause = "AND batches.institution_id = $2";
    }

    if (req.user.role === "trainer") {
      params.push(req.user.id);
      accessClause =
        "AND EXISTS (SELECT 1 FROM batch_trainers WHERE batch_trainers.batch_id = batches.id AND batch_trainers.trainer_id = $2)";
    }

    const result = await pool.query(
      `SELECT batches.id,
              batches.name,
              COUNT(DISTINCT batch_students.student_id)::int AS student_count,
              COUNT(DISTINCT sessions.id)::int AS session_count,
              COUNT(DISTINCT attendance.id)::int AS attended_count,
              CASE
                WHEN COUNT(DISTINCT batch_students.student_id) * COUNT(DISTINCT sessions.id) = 0 THEN 0
                ELSE ROUND(
                  COUNT(DISTINCT attendance.id)::numeric /
                  (COUNT(DISTINCT batch_students.student_id) * COUNT(DISTINCT sessions.id)) * 100,
                  2
                )
              END AS attendance_percentage
       FROM batches
       LEFT JOIN batch_students ON batch_students.batch_id = batches.id
       LEFT JOIN sessions ON sessions.batch_id = batches.id
       LEFT JOIN attendance ON attendance.session_id = sessions.id
        AND attendance.student_id = batch_students.student_id
       WHERE batches.id = $1 ${accessClause}
       GROUP BY batches.id`,
      params
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: "Batch summary not found" });
    }

    res.json(result.rows[0]);
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

app.get(
  "/programme/summary",
  checkRole(["monitoring_officer"]),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `WITH possible AS (
         SELECT COALESCE(SUM(batch_counts.student_count * batch_counts.session_count), 0)::int AS total_possible
         FROM (
           SELECT batches.id,
                  COUNT(DISTINCT batch_students.student_id) AS student_count,
                  COUNT(DISTINCT sessions.id) AS session_count
           FROM batches
           LEFT JOIN batch_students ON batch_students.batch_id = batches.id
           LEFT JOIN sessions ON sessions.batch_id = batches.id
           GROUP BY batches.id
         ) batch_counts
       ),
       attended AS (
         SELECT COUNT(DISTINCT attendance.id)::int AS total_attended
         FROM attendance
         INNER JOIN sessions ON sessions.id = attendance.session_id
         INNER JOIN batch_students ON batch_students.batch_id = sessions.batch_id
          AND batch_students.student_id = attendance.student_id
       )
       SELECT
         (SELECT COUNT(*)::int FROM users WHERE role = 'institution') AS total_institutions,
         (SELECT COUNT(*)::int FROM batches) AS total_batches,
         (SELECT COUNT(*)::int FROM sessions) AS total_sessions,
         (SELECT COUNT(*)::int FROM users WHERE role = 'student') AS total_students,
         CASE
           WHEN possible.total_possible = 0 THEN 0
           ELSE ROUND(attended.total_attended::numeric / possible.total_possible * 100, 2)
         END AS overall_attendance_percentage
       FROM possible, attended`
    );

    res.json(result.rows[0]);
  })
);

app.get(
  "/institutions/summary",
  checkRole(["monitoring_officer"]),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `WITH institution_stats AS (
         SELECT institutions.id,
                institutions.name,
                COUNT(DISTINCT batches.id)::int AS batch_count,
                COUNT(DISTINCT trainers.id)::int AS trainer_count,
                COUNT(DISTINCT batch_students.student_id)::int AS student_count,
                COUNT(DISTINCT sessions.id)::int AS session_count,
                COUNT(DISTINCT attendance.id)::int AS attended_count,
                (
                  COUNT(DISTINCT batch_students.student_id) *
                  COUNT(DISTINCT sessions.id)
                )::int AS possible_count
         FROM users institutions
         LEFT JOIN batches ON batches.institution_id = institutions.id
         LEFT JOIN users trainers ON trainers.institution_id = institutions.id
           AND trainers.role = 'trainer'
         LEFT JOIN batch_students ON batch_students.batch_id = batches.id
         LEFT JOIN sessions ON sessions.batch_id = batches.id
         LEFT JOIN attendance ON attendance.session_id = sessions.id
          AND attendance.student_id = batch_students.student_id
         WHERE institutions.role = 'institution'
         GROUP BY institutions.id
       )
       SELECT id,
              name,
              batch_count,
              trainer_count,
              student_count,
              session_count,
              CASE
                WHEN possible_count = 0 THEN 0
                ELSE ROUND(attended_count::numeric / possible_count * 100, 2)
              END AS attendance_percentage
       FROM institution_stats
       ORDER BY name`
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
