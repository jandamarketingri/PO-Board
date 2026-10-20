/*
 * import-core.js — turns a MAS "Whiteboard PO Query" export into board data.
 * Shared by the web page (index.html) and the auto-import script (tools/import.js),
 * so both read files the same way and PO numbers always match.
 *
 * Storage shape (Firestore):
 *   po_months/{YYYY-MM}  { pos: { "<PO#>": { d: "YYYY-MM-DD", v: "<VendorNo>", l: [[print, item, desc, productLine, ordered, received, backordered], ...] } }, updatedAt }
 * Notes, stars, steps and ETAs live in notes/{PO#} and are never touched by an import.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ImportCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Header names MAS might use for each column. Add spellings here if the query changes.
  const ALIASES = {
    po: ["purchaseorderno", "pono", "purchaseorder", "po"],
    date: ["purchaseorderdate", "podate", "orderdate", "date"],
    status: ["orderstatus", "status", "postatus"],
    vendor: ["vendorno", "vendor", "vendornumber"],
    print: ["print", "printcode"],
    item: ["itemcode", "item", "finishedgood"],
    desc: ["description", "itemdescription", "itemcodedesc"],
    line: ["productline"],
    ord: ["quantityorderedrevised", "quantityordered", "qtyordered"],
    rec: ["quantityreceived", "quantityshipped", "qtyreceived", "qtyshipped"],
    bo: ["quantitybackordered", "qtybackordered"],
    shipto: ["shiptoname", "shipto"],
  };
  // Column positions used when the file has no header row (A..K).
  const DEFAULT_MAP = { po: 0, date: 1, status: 2, vendor: 3, print: 4, item: 5, desc: 6, line: 7, ord: 8, rec: 9, bo: 10, shipto: -1 };

  // MAS order status: A = active, C = completed (received and invoiced), X = cancelled.
  // A file without an OrderStatus column is treated as all active.
  const normStatus = v => { const s = String(cellText(v) ?? "").trim().toUpperCase().charAt(0); return s === "C" || s === "X" ? s : "A"; };

  const norm = v => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const num = v => { const n = Number(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : 0; };
  const pad = n => String(n).padStart(2, "0");
  const cellText = v => (v && typeof v === "object" && "text" in v) ? v.text : (v && typeof v === "object" && "result" in v) ? v.result : v;

  // All-digit PO numbers lose leading zeros: 0002075 -> 2075 (how the team refers to them).
  function normPO(v) {
    let po = String(cellText(v) ?? "").trim();
    if (/^\d+(\.0+)?$/.test(po)) po = po.replace(/\.0+$/, "").replace(/^0+(?=\d)/, "");
    return po;
  }

  // Accepts a JS Date (treated as a calendar date in UTC), an Excel serial number, or text like 6/22/2026 or 2026-06-22.
  function toISO(v) {
    v = cellText(v);
    if (v instanceof Date && !isNaN(v)) {
      const d = new Date(v.getTime() + 12 * 3600e3 * (v.getUTCHours() >= 12 ? 1 : 0));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    if (typeof v === "number" && v > 20000 && v < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    const s = String(v ?? "").trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${pad(m[1])}-${pad(m[2])}`; }
    return "undated";
  }
  const monthOf = iso => iso === "undated" ? "undated" : iso.slice(0, 7);

  // rows: array of arrays (first sheet). Returns { incoming: Map(po -> record), rows: lineCount }.
  function rowsToIncoming(rows) {
    const map = { ...DEFAULT_MAP }; let start = 0; let hasStatus = true;
    const h = rows.findIndex(r => Array.isArray(r) && r.some(c => ALIASES.po.includes(norm(cellText(c)))));
    if (h >= 0) {
      const hdr = rows[h].map(c => norm(cellText(c)));
      // With a header row, only columns found by name are used (a sheet without "Print" leaves print codes blank).
      // Aliases are tried in order, so QuantityOrderedRevised wins over QuantityOrdered when both exist.
      for (const [k, names] of Object.entries(ALIASES)) {
        let i = -1; for (const n of names) { i = hdr.indexOf(n); if (i >= 0) break; }
        map[k] = i; if (i < 0 && k === "status") hasStatus = false;
      }
      start = h + 1;
    }
    const incoming = new Map(); let n = 0;
    const str = v => String(cellText(v) ?? "").trim();
    if (map.po < 0) throw new Error("No PO number column found. The header row needs a column like PurchaseOrderNo.");
    for (let i = start; i < rows.length; i++) {
      const r = rows[i]; if (!r) continue;
      const po = normPO(r[map.po]); if (!po) continue;
      n++;
      let rec = incoming.get(po);
      if (!rec) {
        rec = { d: toISO(r[map.date]), v: str(r[map.vendor]), s: hasStatus ? normStatus(r[map.status]) : "A", l: [] };
        const t = map.shipto >= 0 ? str(r[map.shipto]) : ""; if (t) rec.t = t;
        incoming.set(po, rec);
      }
      rec.l.push([str(r[map.print]), str(r[map.item]), str(r[map.desc]), str(r[map.line]), num(cellText(r[map.ord])), num(cellText(r[map.rec])), num(cellText(r[map.bo]))]);
    }
    if (!incoming.size) throw new Error("No PO rows found. The first column should be the PO number, with a header row like PurchaseOrderNo.");
    return { incoming, rows: n };
  }

  // Several sheets in one file (e.g. "Tees POs" and "Other POs"): sheets is [{ name, rows }].
  // Sheets with no PO rows are ignored. Returns { incoming, rows, sheets: [names used] }.
  function sheetsToIncoming(sheets) {
    const incoming = new Map(); let n = 0; const used = []; let lastErr = null;
    for (const sh of sheets) {
      let res; try { res = rowsToIncoming(sh.rows || []); } catch (e) { lastErr = e; continue; }
      used.push(sh.name); n += res.rows;
      for (const [po, r] of res.incoming) {
        const cur = incoming.get(po);
        if (cur) { cur.l.push(...r.l); if (!cur.t && r.t) cur.t = r.t; } else incoming.set(po, r);
      }
    }
    if (!incoming.size) throw lastErr || new Error("No PO rows found in this file.");
    return { incoming, rows: n, sheets: used };
  }

  // Field-by-field compare (stored documents can come back with keys in a different order).
  const samePO = (a, b) => !!a && a.d === b.d && a.v === b.v && (a.s || "A") === (b.s || "A") && (a.t || "") === (b.t || "") && JSON.stringify(a.l) === JSON.stringify(b.l);

  // months: Map(monthId -> { pos }) of what's stored now. vendors: Map(vendorNo -> {name}).
  function planImport(incoming, months, vendors) {
    const where = new Map();
    for (const [mid, m] of months) for (const po of Object.keys((m && m.pos) || {})) where.set(po, mid);
    let added = 0, changed = 0, same = 0, toCompleted = 0, toCancelled = 0;
    const touched = new Set(); const moved = []; const skip = new Set();
    for (const [po, r] of incoming) {
      const mid = monthOf(r.d);
      const curM = where.get(po);
      // Rule: only ACTIVE orders are added as new cards. Completed/cancelled ones not already on the board are skipped.
      if (!curM) { if (r.s !== "A") { skip.add(po); continue; } added++; touched.add(mid); continue; }
      const cur = months.get(curM).pos[po];
      if (samePO(cur, r)) { same++; continue; }
      // Orders already on the board always take the latest quantities and status.
      if ((cur.s || "A") !== r.s) { if (r.s === "C") toCompleted++; else if (r.s === "X") toCancelled++; }
      changed++; touched.add(mid);
      if (curM !== mid) { moved.push([po, curM]); touched.add(curM); }
    }
    const newVendors = [...new Set([...incoming.values()].map(r => r.v))].filter(v => v && !(vendors && vendors.get(v) && vendors.get(v).name));
    const skippedCompleted = [...skip].filter(po => incoming.get(po).s === "C").length;
    return { added, changed, same, touched, moved, newVendors, skip, skipped: skip.size, skippedCompleted, skippedCancelled: skip.size - skippedCompleted, toCompleted, toCancelled };
  }

  // Returns Map(monthId -> full pos object to write). POs missing from the export are kept.
  function buildMonthWrites(incoming, plan, months) {
    const next = new Map();
    const get = mid => { if (!next.has(mid)) next.set(mid, { ...((months.get(mid) && months.get(mid).pos) || {}) }); return next.get(mid); };
    for (const [po, from] of plan.moved) delete get(from)[po];
    for (const [po, r] of incoming) { if (plan.skip && plan.skip.has(po)) continue; const mid = monthOf(r.d); if (plan.touched.has(mid)) get(mid)[po] = r; }
    return next;
  }

  // Firestore can't store a list inside a list, so each size line is saved as a small object:
  // { p: print, i: item, d: description, g: product line, o: ordered, r: received, b: backordered }.
  // In memory (and in the page) lines stay as arrays.
  const LKEYS = ["p", "i", "d", "g", "o", "r", "b"];
  const toStoreRec = r => ({ d: r.d, v: r.v, s: r.s || "A", ...(r.t ? { t: r.t } : {}), l: (r.l || []).map(a => Object.fromEntries(LKEYS.map((k, j) => [k, a[j]]))) });
  const fromStoreRec = r => ({ d: r.d, v: r.v, s: r.s || "A", ...(r.t ? { t: r.t } : {}), l: (r.l || []).map(x => Array.isArray(x) ? x : LKEYS.map(k => x[k])) });
  const mapPos = (pos, fn) => { const out = {}; for (const [k, v] of Object.entries(pos || {})) out[k] = fn(v); return out; };
  const toStorePos = pos => mapPos(pos, toStoreRec);
  const fromStorePos = pos => mapPos(pos, fromStoreRec);

  return { ALIASES, DEFAULT_MAP, normPO, toISO, monthOf, rowsToIncoming, sheetsToIncoming, planImport, buildMonthWrites, toStorePos, fromStorePos };
});
