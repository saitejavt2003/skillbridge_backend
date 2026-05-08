const { Pool } = require("pg");

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error(
    "Missing required DATABASE_URL environment variable. Set it to your PostgreSQL connection string."
  );
}

const useSsl = process.env.DB_SSL !== "false";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 30000),
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", error);
});

module.exports = pool;
