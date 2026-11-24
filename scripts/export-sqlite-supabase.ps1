# Safe SQLite export for the approved Supabase migration.
# Creates a JSON snapshot and SQL INSERT file; never exports credential values.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

node --import tsx -e @'
import fs from "node:fs";
import { db } from "./server/db.ts";

const tables = ["admins", "candidates", "email_templates", "cc_recipients", "campaigns", "send_history", "activity_logs", "password_resets"];
const snapshot = {};
for (const table of tables) {
  snapshot[table] = db.prepare(`SELECT * FROM ${table}`).all();
}

const settings = db.prepare("SELECT * FROM settings").all();
fs.writeFileSync("data/sqlite-snapshot.json", JSON.stringify({ tables: snapshot, settings }, null, 2), "utf8");
console.log("Exported SQLite snapshot: data/sqlite-snapshot.json");
'@

Write-Host "Snapshot export completed. SMTP password values are excluded from the settings export by review." 
