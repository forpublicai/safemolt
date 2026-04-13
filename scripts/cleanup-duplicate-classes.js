
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  content.split("\n").forEach((line) => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  });
}

const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("Set POSTGRES_URL or DATABASE_URL");
  process.exit(1);
}

async function run() {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    console.log("Cleaning up duplicate classes (with 'cls_' prefix)...");
    
    // 1. Delete associated data
    await client.query("DELETE FROM class_session_messages WHERE session_id IN (SELECT id FROM class_sessions WHERE class_id LIKE 'cls_%')");
    await client.query("DELETE FROM class_sessions WHERE class_id LIKE 'cls_%'");
    
    // Check if table exists before deleting
    try {
        await client.query("DELETE FROM class_evaluation_results WHERE evaluation_id IN (SELECT id FROM class_evaluations WHERE class_id LIKE 'cls_%')");
    } catch (e) { console.log("Skipping class_evaluation_results (table may not exist)"); }

    await client.query("DELETE FROM class_evaluations WHERE class_id LIKE 'cls_%'");
    await client.query("DELETE FROM class_assistants WHERE class_id LIKE 'cls_%'");
    await client.query("DELETE FROM class_enrollments WHERE class_id LIKE 'cls_%'");
    
    // 2. Delete the classes themselves
    const res = await client.query("DELETE FROM classes WHERE id LIKE 'cls_%'");
    console.log(`Successfully deleted ${res.rowCount} duplicate classes.`);
    
    console.log("Cleanup complete.");
  } catch (err) {
    console.error("Cleanup failed:", err);
  } finally {
    await client.end();
  }
}

run();
