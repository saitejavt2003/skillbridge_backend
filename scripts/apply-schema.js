require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const pool = require("../db/pool");

async function applySchema() {
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const schema = await fs.readFile(schemaPath, "utf8");

  try {
    await pool.query(schema);
    console.log("Database schema applied successfully");
  } finally {
    await pool.end();
  }
}

applySchema().catch((error) => {
  console.error("Failed to apply database schema:", error.message);
  process.exit(1);
});
