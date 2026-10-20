#!/usr/bin/env node
/*
 * Auto-import for the Printer PO Board.
 *
 *   node import.js "C:\MAS Exports\Whiteboard_Upload.xlsx"
 *   node import.js export.csv --dry-run              (show what would change, write nothing)
 *   node import.js export.xlsx --vendors "Vendors and Vendor Numbers.xlsx"   (also add vendor names, first run)
 *   node import.js export.xlsx --key "C:\po-board\service-account.json"
 *
 * Uses the same rules as the Import button on the site (../import-core.js):
 * new POs are added, changed POs are updated, nothing is deleted, notes/ETAs are never touched.
 */
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const admin = require("firebase-admin");
const ImportCore = require("../import-core.js");

function parseArgs(argv) {
  const out = { file: null, vendors: null, dryRun: false, key: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--vendors") out.vendors = argv[++i];
    else if (a === "--key") out.key = argv[++i];
    else if (!out.file) out.file = a;
  }
  return out;
}

// Minimal CSV reader: handles quoted fields, embedded commas and quotes. Every cell stays text.
function parseCSV(text) {
  const rows = []; let row = []; let cell = ""; let q = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const plain = v => {
  if (v && typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
    if ("result" in v) return v.result;
    if ("text" in v) return v.text;
  }
  return v;
};

// Every sheet in the file, as [{ name, rows }]. A CSV is one sheet.
async function readSheets(file) {
  if (/\.(csv|txt)$/i.test(file)) return [{ name: path.basename(file), rows: parseCSV(fs.readFileSync(file, "utf8")) }];
  if (/\.xls$/i.test(file)) throw new Error("Old .xls files aren't supported by the auto-import. Export as .xlsx or .csv.");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map(ws => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (r, n) => { rows[n - 1] = (r.values || []).slice(1).map(plain); });
    return { name: ws.name, rows };
  });
}
// First sheet only (used for the vendor list).
async function readRows(file) { return (await readSheets(file))[0].rows; }

function initFirebase(keyPath) {
  const key = keyPath || process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, "service-account.json");
  if (!fs.existsSync(key)) throw new Error(`Service account key not found at ${key}. See README, step 6.`);
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(key, "utf8"))) });
  return admin.firestore();
}

async function importVendors(db, file) {
  const rows = await readRows(file);
  const snap = await db.collection("vendors").get();
  const have = new Set(snap.docs.map(d => d.id));
  const order = { "luchador": 1, "lady luck": 2, "amigo": 3, "new image": 4 };
  let added = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(plain(r[0]) ?? "").trim(), no = String(plain(r[1]) ?? "").trim();
    if (!name || !no || /vendor/i.test(no)) continue;
    const id = no.replace(/[^A-Za-z0-9_\-.~:@+]/g, "_");
    if (have.has(id)) continue; // keep names already edited on the site
    await db.doc(`vendors/${id}`).set({ no, name, order: order[name.toLowerCase()] ?? 10 + i });
    added++;
  }
  console.log(`Vendors: ${added} added, ${have.size} already on the board.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) { console.error('Usage: node import.js <export.xlsx|.csv> [--dry-run] [--vendors vendors.xlsx] [--key service-account.json]'); process.exit(2); }
  if (!fs.existsSync(args.file)) throw new Error(`File not found: ${args.file}`);

  const { incoming, rows, sheets } = ImportCore.sheetsToIncoming(await readSheets(args.file));
  console.log(`Read ${rows} lines on ${incoming.size} POs from ${path.basename(args.file)} (sheets: ${sheets.join(", ")}).`);

  const db = initFirebase(args.key);
  if (args.vendors && !args.dryRun) await importVendors(db, args.vendors);

  const [monthSnap, vendorSnap] = await Promise.all([db.collection("po_months").get(), db.collection("vendors").get()]);
  const months = new Map(monthSnap.docs.map(d => { const x = d.data(); return [d.id, { ...x, pos: ImportCore.fromStorePos(x.pos) }]; }));
  const vendors = new Map(vendorSnap.docs.map(d => { const v = d.data(); return [v.no || d.id, v]; }));

  const plan = ImportCore.planImport(incoming, months, vendors);
  console.log(`New active POs: ${plan.added}   Updated: ${plan.changed}   Unchanged: ${plan.same}`);
  if (plan.toCompleted || plan.toCancelled) console.log(`  Moving to Received (completed in MAS): ${plan.toCompleted}   Moving to Cancelled: ${plan.toCancelled}`);
  if (plan.skipped) console.log(`Skipped ${plan.skipped} completed/cancelled POs that aren't on the board (${plan.skippedCompleted} completed, ${plan.skippedCancelled} cancelled).`);
  if (plan.newVendors.length) console.log(`Vendor numbers with no name yet: ${plan.newVendors.join(", ")} (name them in Settings on the site)`);
  if (args.dryRun) { console.log("Dry run: nothing written."); return; }
  if (!plan.added && !plan.changed) { console.log("Board already up to date."); return; }

  const next = ImportCore.buildMonthWrites(incoming, plan, months);
  const now = new Date().toISOString();
  const batch = db.batch();
  for (const [mid, pos] of next) batch.set(db.doc(`po_months/${mid}`), { pos: ImportCore.toStorePos(pos), updatedAt: now });
  batch.set(db.doc("settings/lastImport"), {
    at: now, file: path.basename(args.file), rows, pos: incoming.size,
    added: plan.added, changed: plan.changed, skipped: plan.skipped, by: null, byName: "Auto-import", source: "auto",
  });
  await batch.commit();
  console.log(`Done. Wrote ${next.size} month${next.size === 1 ? "" : "s"} of POs.`);
}

if (require.main === module) main().catch(err => { console.error("Import failed:", err.message || err); process.exit(1); });
module.exports = { readRows, readSheets, parseCSV };
