import { pool } from "./db.pg.js";
await pool.query(`TRUNCATE TABLE imports RESTART IDENTITY;`);
console.log("import truncated");
await pool.end();
process.exit(0);