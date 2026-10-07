// Admin → Dolasci: dnevni pregled prijava dolaska i mesečni izveštaj (kašnjenja, smene bez prijave).
// Prijave upisuje check_in() kad radnik skenira QR kod sa tableta (sql/migration_009_attendance.sql).

const DL = { shiftTypes: null, startDate: null, month: null };
const DL_SHIFT_ORDER = ["I", "II", "III"];
const DL_TIME_FMT = new Intl.DateTimeFormat("sr-Latn", { timeZone: "Europe/Belgrade", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function dlPad(n) { return String(n).padStart(2, "0"); }
function dlIso(d) { return `${d.getFullYear()}-${dlPad(d.getMonth() + 1)}-${dlPad(d.getDate())}`; }
function dlShortDate(iso) { const [, m, d] = iso.split("-"); return `${+d}.${+m}.`; }
function dlEsc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function dlName(row) { return row.employees?.profiles?.full_name || "—"; }

function dlBanner(html, type) {
  document.getElementById("dolasci-banner").innerHTML = html ? `<div class="banner ${type || "error"}">${html}</div>` : "";
}

// Planirani početak smene po beogradskom vremenu (međusmena počinje 6 h posle smene: 13 ili 21 h;
// lideri — shift lider ili "Lider" u smeni — sat ranije: 6, 14 ili 22 h).
function dlIsLeader(row) { return !!row.is_leader || row.employees?.funkcija === "shift_lider"; }
function dlPlannedStart(date, code, isMS, isLeader) {
  const st = DL.shiftTypes[code];
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = st.start_time.split(":").map(Number);
  return new Date(y, m - 1, d, h + (isMS ? 6 : isLeader ? -1 : 0), min);
}
function dlHHMM(dt) { return `${dlPad(dt.getHours())}:${dlPad(dt.getMinutes())}`; }
function dlShiftLabel(code, isMS) { return isMS ? `${code} · MS` : code; }

async function dlEnsureBase() {
  if (DL.shiftTypes) return true;
  const [{ data: st }, { data: start }, { error: attErr }] = await Promise.all([
    sb.from("shift_types").select("code, label, start_time"),
    sb.from("settings").select("value").eq("key", "dolasci_start").maybeSingle(),
    sb.from("attendance").select("id").limit(1),
  ]);
  if (attErr) {
    dlBanner("Tabela za dolaske još ne postoji — pokreni <b>sql/migration_009_attendance.sql</b> u Supabase SQL Editor-u.");
    return false;
  }
  DL.shiftTypes = Object.fromEntries((st || []).map(s => [s.code, s]));
  DL.startDate = start ? start.value : dlIso(belgradeNow());
  return true;
}

// ---------------- Dnevni pregled ----------------

async function dlLoadDay() {
  if (!(await dlEnsureBase())) return;
  const date = document.getElementById("dl-date").value;
  const table = document.getElementById("dl-day-table");
  const summary = document.getElementById("dl-day-summary");
  table.innerHTML = `<tr><td class="muted">Učitavanje…</td></tr>`;

  const [{ data: sched, error: e1 }, { data: att, error: e2 }] = await Promise.all([
    sb.from("schedule")
      .select("id, date, shift_code, is_medju_smena, is_leader, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name))")
      .eq("date", date),
    sb.from("attendance")
      .select("id, employee_id, checked_at, shift_code, is_medju_smena, late_minutes, employees(profiles(full_name))")
      .eq("work_date", date),
  ]);
  if (e1 || e2) { table.innerHTML = `<tr><td class="dl-bad">Greška: ${dlEsc((e1 || e2).message)}</td></tr>`; return; }

  const now = belgradeNow();
  const tracked = date >= DL.startDate;
  const attByKey = new Map();
  const extra = [];
  (att || []).forEach(a => {
    if (a.shift_code) attByKey.set(`${a.employee_id}|${a.shift_code}`, a);
    else extra.push(a);
  });

  const counts = { ok: 0, late: 0, miss: 0, wait: 0 };
  let html = `<tr><th>Zaposleni</th><th>Smena</th><th>Početak</th><th>Dolazak</th><th>Status</th><th></th></tr>`;

  DL_SHIFT_ORDER.forEach(code => {
    const rows = (sched || []).filter(r => r.shift_code === code)
      .sort((a, b) => (a.is_medju_smena - b.is_medju_smena) || dlName(a).localeCompare(dlName(b), "sr"));
    if (!rows.length) return;
    const came = rows.filter(r => attByKey.has(`${r.employee_id}|${code}`)).length;
    html += `<tr class="dl-shift-row"><td colspan="6">${DL.shiftTypes[code]?.label || code} — prijavljeno ${came} od ${rows.length}</td></tr>`;
    rows.forEach(r => {
      const start = dlPlannedStart(r.date, code, r.is_medju_smena, dlIsLeader(r));
      const a = attByKey.get(`${r.employee_id}|${code}`);
      attByKey.delete(`${r.employee_id}|${code}`);
      let status;
      if (a) {
        status = a.late_minutes > 0
          ? (counts.late++, `<span class="dl-st late">Kasni ${a.late_minutes} min</span>`)
          : (counts.ok++, `<span class="dl-st ok">Na vreme</span>`);
      } else if (start > now) {
        counts.wait++; status = `<span class="dl-st wait">Još nije počela</span>`;
      } else if (!tracked) {
        status = `<span class="dl-st wait">Pre uvođenja prijava</span>`;
      } else {
        counts.miss++; status = `<span class="dl-st miss">Bez prijave</span>`;
      }
      html += `<tr>
        <td>${dlEsc(dlName(r))}</td>
        <td>${dlShiftLabel(code, r.is_medju_smena)}${dlIsLeader(r) ? " · Lider" : ""}</td>
        <td>${dlHHMM(start)}</td>
        <td>${a ? DL_TIME_FMT.format(new Date(a.checked_at)) : "—"}</td>
        <td>${status}</td>
        <td>${a ? `<button class="dl-del" data-id="${a.id}" title="Obriši prijavu">×</button>` : ""}</td>
      </tr>`;
    });
  });

  // Prijave za smene koje su u međuvremenu skinute iz rasporeda + dolasci van rasporeda.
  const others = [...attByKey.values(), ...extra];
  if (others.length) {
    html += `<tr class="dl-shift-row"><td colspan="6">Van rasporeda</td></tr>`;
    others.forEach(a => {
      html += `<tr>
        <td>${dlEsc(dlName(a))}</td>
        <td>${a.shift_code ? dlShiftLabel(a.shift_code, a.is_medju_smena) : "—"}</td>
        <td>—</td>
        <td>${DL_TIME_FMT.format(new Date(a.checked_at))}</td>
        <td><span class="dl-st extra">Nije u rasporedu</span></td>
        <td><button class="dl-del" data-id="${a.id}" title="Obriši prijavu">×</button></td>
      </tr>`;
    });
  }

  if (!(sched || []).length && !others.length) html += `<tr><td colspan="6" class="muted">Za ovaj dan nema rasporeda ni prijava.</td></tr>`;
  table.innerHTML = html;
  summary.innerHTML = [
    `<span class="dl-st ok">Na vreme: ${counts.ok}</span>`,
    `<span class="dl-st late">Kasnili: ${counts.late}</span>`,
    `<span class="dl-st miss">Bez prijave: ${counts.miss}</span>`,
    counts.wait ? `<span class="dl-st wait">Tek dolaze: ${counts.wait}</span>` : "",
    others.length ? `<span class="dl-st extra">Van rasporeda: ${others.length}</span>` : "",
  ].join("");
}

// ---------------- Mesečni izveštaj ----------------

async function dlLoadMonth() {
  if (!(await dlEnsureBase())) return;
  const year = parseInt(document.getElementById("dl-year").value, 10);
  const month = parseInt(document.getElementById("dl-month").value, 10);
  const table = document.getElementById("dl-month-table");
  table.innerHTML = `<tr><td class="muted">Učitavanje…</td></tr>`;
  const from = `${year}-${dlPad(month)}-01`;
  const to = dlIso(new Date(year, month, 0));

  const [{ data: sched, error: e1 }, { data: att, error: e2 }] = await Promise.all([
    sb.from("schedule")
      .select("date, shift_code, is_medju_smena, is_leader, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name))")
      .gte("date", from).lte("date", to).range(0, 4999),
    sb.from("attendance")
      .select("employee_id, checked_at, work_date, shift_code, is_medju_smena, late_minutes, employees(profiles(full_name))")
      .gte("work_date", from).lte("work_date", to).range(0, 4999),
  ]);
  if (e1 || e2) { table.innerHTML = `<tr><td class="dl-bad">Greška: ${dlEsc((e1 || e2).message)}</td></tr>`; return; }

  const now = belgradeNow();
  const people = new Map();
  const person = (id, name) => {
    if (!people.has(id)) people.set(id, { name, planned: 0, came: 0, onTime: 0, lateN: 0, lateMin: 0, missed: [], late: [], extra: [] });
    return people.get(id);
  };
  const attByKey = new Map();
  (att || []).forEach(a => {
    if (a.shift_code) attByKey.set(`${a.employee_id}|${a.work_date}|${a.shift_code}`, a);
    else person(a.employee_id, dlName(a)).extra.push(a);
  });

  (sched || []).forEach(r => {
    const p = person(r.employee_id, dlName(r));
    const key = `${r.employee_id}|${r.date}|${r.shift_code}`;
    const a = attByKey.get(key);
    attByKey.delete(key);
    const started = dlPlannedStart(r.date, r.shift_code, r.is_medju_smena, dlIsLeader(r)) <= now;
    if (!a && (!started || r.date < DL.startDate)) return;
    p.planned++;
    if (!a) { p.missed.push(r); return; }
    p.came++;
    if (a.late_minutes > 0) { p.lateN++; p.lateMin += a.late_minutes; p.late.push(a); }
    else p.onTime++;
  });
  attByKey.forEach(a => person(a.employee_id, dlName(a)).extra.push(a));

  const list = [...people.values()].filter(p => p.planned || p.extra.length)
    .sort((a, b) => a.name.localeCompare(b.name, "sr"));
  DL.month = { year, month, list };

  let html = `<tr><th>Zaposleni</th><th class="num">Smena</th><th class="num">Prijavljen</th><th class="num">Na vreme</th>
    <th class="num">Kasnio</th><th class="num">Ukupno kašnjenje</th><th class="num">Bez prijave</th><th class="num">Van rasporeda</th></tr>`;
  if (from <= DL.startDate && DL.startDate <= to) {
    html += `<tr><td colspan="8" class="muted" style="white-space:normal;">Prijave dolaska se vode od ${dlShortDate(DL.startDate)}${DL.startDate.slice(0, 4)}. — ranije smene se ne računaju.</td></tr>`;
  }
  if (!list.length) html += `<tr><td colspan="8" class="muted">Nema podataka za ovaj mesec.</td></tr>`;
  list.forEach((p, i) => {
    const detail = [
      p.late.length ? `<b>Kašnjenja:</b> ${p.late.sort((a, b) => a.work_date.localeCompare(b.work_date)).map(a => `${dlShortDate(a.work_date)} ${dlShiftLabel(a.shift_code, a.is_medju_smena)} (${a.late_minutes} min)`).join(", ")}` : "",
      p.missed.length ? `<b>Bez prijave:</b> ${p.missed.sort((a, b) => a.date.localeCompare(b.date)).map(r => `${dlShortDate(r.date)} ${dlShiftLabel(r.shift_code, r.is_medju_smena)}`).join(", ")}` : "",
      p.extra.length ? `<b>Van rasporeda:</b> ${p.extra.map(a => `${dlShortDate(a.work_date)} u ${DL_TIME_FMT.format(new Date(a.checked_at))}`).join(", ")}` : "",
    ].filter(Boolean).join("<br>") || "Sve smene na vreme.";
    html += `<tr data-i="${i}">
      <td class="dl-name">${dlEsc(p.name)}</td>
      <td class="num">${p.planned}</td>
      <td class="num">${p.came}</td>
      <td class="num">${p.onTime}</td>
      <td class="num ${p.lateN ? "dl-warn" : ""}">${p.lateN}</td>
      <td class="num ${p.lateMin ? "dl-warn" : ""}">${p.lateMin ? p.lateMin + " min" : "—"}</td>
      <td class="num ${p.missed.length ? "dl-bad" : ""}">${p.missed.length}</td>
      <td class="num">${p.extra.length}</td>
    </tr>
    <tr class="dl-detail" data-detail="${i}" hidden><td colspan="8">${detail}</td></tr>`;
  });
  table.innerHTML = html;
}

function dlDownloadCsv() {
  if (!DL.month) return;
  const { year, month, list } = DL.month;
  const lines = [["Zaposleni", "Smena", "Prijavljen", "Na vreme", "Kasnio (puta)", "Ukupno kašnjenje (min)", "Bez prijave", "Van rasporeda", "Datumi kašnjenja", "Datumi bez prijave"]];
  list.forEach(p => lines.push([
    p.name, p.planned, p.came, p.onTime, p.lateN, p.lateMin, p.missed.length, p.extra.length,
    p.late.map(a => `${dlShortDate(a.work_date)} ${a.shift_code} (${a.late_minutes} min)`).join(", "),
    p.missed.map(r => `${dlShortDate(r.date)} ${r.shift_code}`).join(", "),
  ]));
  const csv = "﻿" + lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `dolasci_${MONTH_NAMES_SR[month - 1].toLowerCase()}_${year}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------- Kontrole (kače se odmah, podaci tek posle admin-ready) ----------------

(() => {
  const dateInput = document.getElementById("dl-date");
  const shiftDay = (delta) => {
    const d = new Date(dateInput.value + "T00:00:00");
    d.setDate(d.getDate() + delta);
    dateInput.value = dlIso(d);
    dlLoadDay();
  };
  dateInput.addEventListener("change", dlLoadDay);
  document.getElementById("dl-day-prev").addEventListener("click", () => shiftDay(-1));
  document.getElementById("dl-day-next").addEventListener("click", () => shiftDay(1));
  document.getElementById("dl-month").addEventListener("change", dlLoadMonth);
  document.getElementById("dl-year").addEventListener("change", dlLoadMonth);
  document.getElementById("dl-csv").addEventListener("click", dlDownloadCsv);

  document.getElementById("dl-day-table").addEventListener("click", async (e) => {
    const btn = e.target.closest(".dl-del");
    if (!btn || !confirm("Obrisati ovu prijavu dolaska?")) return;
    const { error } = await sb.from("attendance").delete().eq("id", btn.dataset.id);
    if (error) return dlBanner("Brisanje nije uspelo: " + dlEsc(error.message));
    dlLoadDay();
    dlLoadMonth();
  });
  document.getElementById("dl-month-table").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-i]");
    if (!row) return;
    const detail = document.querySelector(`#dl-month-table tr[data-detail="${row.dataset.i}"]`);
    detail.hidden = !detail.hidden;
    row.classList.toggle("open", !detail.hidden);
  });

  const now = belgradeNow();
  dateInput.value = dlIso(now);
  const monthSelect = document.getElementById("dl-month");
  MONTH_NAMES_SR.forEach((name, idx) => {
    const opt = document.createElement("option");
    opt.value = idx + 1;
    opt.textContent = name;
    if (idx === now.getMonth()) opt.selected = true;
    monthSelect.appendChild(opt);
  });
  document.getElementById("dl-year").value = now.getFullYear();
})();

function dlRefresh() { dlLoadDay(); dlLoadMonth(); }
document.addEventListener("admin-ready", () => { if (adminCurrentTab === "dolasci") dlRefresh(); });
document.addEventListener("admin-tab-change", (e) => { if (e.detail.to === "dolasci") dlRefresh(); });
