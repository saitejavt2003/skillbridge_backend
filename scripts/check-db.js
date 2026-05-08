require("dotenv").config();

const pool = require("../db/pool");

async function checkDatabase() {
  try {
    const result = await pool.query("SELECT NOW() AS connected_at");
    console.log("Database connected:", result.rows[0].connected_at);
  } finally {
    await pool.end();
  }
}

checkDatabase().catch((error) => {
  console.error("Database connection failed:", error.message);
  process.exit(1);
});
