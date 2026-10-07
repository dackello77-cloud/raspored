// Admin → Dolasci: dnevni pregled prijava dolaska i mesečni izveštaj (kašnjenja, smene bez prijave).
// Prijave upisuje check_in() kad radnik skenira QR kod sa tableta (sql/migration_009_attendance.sql).

const DL = { shiftTypes: null, startDate: null, month: null, ym: null, view: "day" };
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
const DL_DOW = ["Nedelja", "Ponedeljak", "Utorak", "Sreda", "Četvrtak", "Petak", "Subota"];
function dlLongDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return `${DL_DOW[d.getDay()]}, ${d.getDate()}. ${MONTH_NAMES_SR[d.getMonth()].toLowerCase()}`;
}

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
  const list = document.getElementById("dl-day-list");
  const summary = document.getElementById("dl-day-summary");
  const today = dlIso(belgradeNow());
  document.getElementById("dl-day-label").textContent =
    date === today ? `Danas · ${dlLongDate(date).split(", ")[1]}` : dlLongDate(date);
  list.innerHTML = `<div class="dl-empty">Učitavanje…</div>`;

  const [{ data: sched, error: e1 }, { data: att, error: e2 }] = await Promise.all([
    sb.from("schedule")
      .select("id, date, shift_code, is_medju_smena, is_leader, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name))")
      .eq("date", date),
    sb.from("attendance")
      .select("id, employee_id, checked_at, shift_code, is_medju_smena, late_minutes, employees(profiles(full_name))")
      .eq("work_date", date),
  ]);
  if (e1 || e2) { list.innerHTML = `<div class="dl-empty dl-bad">Greška: ${dlEsc((e1 || e2).message)}</div>`; return; }

  const now = belgradeNow();
  const tracked = date >= DL.startDate;
  const attByKey = new Map();
  const extra = [];
  (att || []).forEach(a => {
    if (a.shift_code) attByKey.set(`${a.employee_id}|${a.shift_code}`, a);
    else extra.push(a);
  });

  const counts = { ok: 0, late: 0, miss: 0, wait: 0 };
  const row = (name, details, status, attId) => `<div class="dl-row">
      <div class="dl-who"><b>${dlEsc(name)}</b><small>${details}</small></div>
      ${status}
      ${attId && !window.DL_READONLY ? `<button class="dl-del" data-id="${attId}" type="button" title="Obriši prijavu" aria-label="Obriši prijavu">×</button>` : ""}
    </div>`;
  let html = "";

  DL_SHIFT_ORDER.forEach(code => {
    const rows = (sched || []).filter(r => r.shift_code === code)
      .sort((a, b) => (a.is_medju_smena - b.is_medju_smena) || (dlIsLeader(b) - dlIsLeader(a)) || dlName(a).localeCompare(dlName(b), "sr"));
    if (!rows.length) return;
    const came = rows.filter(r => attByKey.has(`${r.employee_id}|${code}`)).length;
    html += `<div class="dl-group"><div class="dl-group-head shift-${code}"><span>${DL.shiftTypes[code]?.label || code}</span><small>prijavljeno ${came}/${rows.length}</small></div>`;
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
        status = `<span class="dl-st wait">Pre prijava</span>`;
      } else {
        counts.miss++; status = `<span class="dl-st miss">Bez prijave</span>`;
      }
      const role = r.is_medju_smena ? "Međusmena · " : dlIsLeader(r) ? "Lider · " : "";
      const details = `${role}početak ${dlHHMM(start)}${a ? ` · došao/la ${DL_TIME_FMT.format(new Date(a.checked_at))}` : ""}`;
      html += row(dlName(r), details, status, a && a.id);
    });
    html += `</div>`;
  });

  // Prijave za smene koje su u međuvremenu skinute iz rasporeda + dolasci van rasporeda.
  const others = [...attByKey.values(), ...extra];
  if (others.length) {
    html += `<div class="dl-group"><div class="dl-group-head"><span>Van rasporeda</span><small>${others.length}</small></div>`;
    others.forEach(a => {
      html += row(dlName(a), `došao/la ${DL_TIME_FMT.format(new Date(a.checked_at))}${a.shift_code ? ` · ${dlShiftLabel(a.shift_code, a.is_medju_smena)}` : ""}`,
        `<span class="dl-st extra">Nije u rasporedu</span>`, a.id);
    });
    html += `</div>`;
  }

  list.innerHTML = html || `<div class="dl-empty">Za ovaj dan nema rasporeda ni prijava.</div>`;
  summary.innerHTML = html ? [
    `<span class="dl-st ok">Na vreme ${counts.ok}</span>`,
    `<span class="dl-st late">Kasnili ${counts.late}</span>`,
    `<span class="dl-st miss">Bez prijave ${counts.miss}</span>`,
    counts.wait ? `<span class="dl-st wait">Tek dolaze ${counts.wait}</span>` : "",
    others.length ? `<span class="dl-st extra">Van rasporeda ${others.length}</span>` : "",
  ].join("") : "";
}

// ---------------- Mesečni izveštaj ----------------

async function dlLoadMonth() {
  if (!(await dlEnsureBase())) return;
  const { year, month } = DL.ym;
  document.getElementById("dl-month-label").textContent = `${MONTH_NAMES_SR[month - 1]} ${year}.`;
  const listEl = document.getElementById("dl-month-list");
  const totalsEl = document.getElementById("dl-month-totals");
  const noteEl = document.getElementById("dl-month-note");
  listEl.innerHTML = `<div class="dl-empty">Učitavanje…</div>`;
  totalsEl.innerHTML = "";
  DL.month = null;
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
  if (e1 || e2) { listEl.innerHTML = `<div class="dl-empty dl-bad">Greška: ${dlEsc((e1 || e2).message)}</div>`; return; }
  if (DL.ym.year !== year || DL.ym.month !== month) return; // korisnik je u međuvremenu promenio mesec

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
  list.forEach(p => {
    p.late.sort((a, b) => a.work_date.localeCompare(b.work_date));
    p.missed.sort((a, b) => a.date.localeCompare(b.date));
    p.extra.sort((a, b) => a.work_date.localeCompare(b.work_date));
  });
  DL.month = { year, month, list };

  const sum = (f) => list.reduce((n, p) => n + f(p), 0);
  const planned = sum(p => p.planned), onTime = sum(p => p.onTime);
  totalsEl.innerHTML = list.length ? `
    <div class="dl-tile"><b>${planned ? Math.round(onTime / planned * 100) : 0}%</b><span>na vreme</span><small>${onTime} od ${planned} smena</small></div>
    <div class="dl-tile late"><b>${sum(p => p.lateN)}</b><span>kašnjenja</span><small>ukupno ${sum(p => p.lateMin)} min</small></div>
    <div class="dl-tile miss"><b>${sum(p => p.missed.length)}</b><span>bez prijave</span><small>smena</small></div>` : "";
  noteEl.textContent = from <= DL.startDate && DL.startDate <= to
    ? `Prijave se vode od ${dlShortDate(DL.startDate)} — ranije smene se ne računaju.` : "";
  document.getElementById("dl-pdf").disabled = !list.length;

  listEl.innerHTML = list.length ? list.map((p, i) => {
    const badges = [
      p.lateN ? `<span class="dl-st late">Kasnio ${p.lateN}× · ${p.lateMin} min</span>` : "",
      p.missed.length ? `<span class="dl-st miss">Bez prijave ${p.missed.length}</span>` : "",
      p.extra.length ? `<span class="dl-st extra">Van rasporeda ${p.extra.length}</span>` : "",
    ].join("") || `<span class="dl-st ok">Uredno</span>`;
    const detail = [
      p.late.length ? `<b>Kašnjenja:</b> ${p.late.map(a => `${dlShortDate(a.work_date)} ${dlShiftLabel(a.shift_code, a.is_medju_smena)} (${a.late_minutes} min)`).join(", ")}` : "",
      p.missed.length ? `<b>Bez prijave:</b> ${p.missed.map(r => `${dlShortDate(r.date)} ${dlShiftLabel(r.shift_code, r.is_medju_smena)}`).join(", ")}` : "",
      p.extra.length ? `<b>Van rasporeda:</b> ${p.extra.map(a => `${dlShortDate(a.work_date)} u ${DL_TIME_FMT.format(new Date(a.checked_at))}`).join(", ")}` : "",
    ].filter(Boolean).join("<br>") || "Sve smene na vreme.";
    return `<div class="dl-person" data-i="${i}">
      <div class="dl-p-head">
        <div class="dl-who"><b>${dlEsc(p.name)}</b><small>${p.planned} smena · prijavljen ${p.came} · na vreme ${p.onTime}</small></div>
        <div class="dl-p-badges">${badges}</div>
        <span class="dl-chev">›</span>
      </div>
      <div class="dl-p-detail" hidden>${detail}</div>
    </div>`;
  }).join("") : `<div class="dl-empty">Nema podataka za ovaj mesec.</div>`;
}

// ---------------- PDF ----------------

const DL_PDF_LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js",
];
const DL_PDF_FONTS = {
  normal: "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf",
  bold: "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf",
};
let dlPdfReady = null;

function dlLoadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error("Nije učitano: " + src));
    document.head.appendChild(el);
  });
}
// Font sa našim slovima (č ć đ š ž) — ugrađeni PDF fontovi ih nemaju.
async function dlFontBase64(url) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function dlPdfPrepare() {
  if (!dlPdfReady) {
    dlPdfReady = (async () => {
      for (const src of DL_PDF_LIBS) await dlLoadScript(src);
      const [normal, bold] = await Promise.all([dlFontBase64(DL_PDF_FONTS.normal), dlFontBase64(DL_PDF_FONTS.bold)]);
      return { normal, bold };
    })();
    dlPdfReady.catch(() => { dlPdfReady = null; });
  }
  return dlPdfReady;
}

async function dlDownloadPdf() {
  if (!DL.month) return;
  const btn = document.getElementById("dl-pdf");
  btn.disabled = true;
  btn.textContent = "Pravim PDF…";
  try {
    const fonts = await dlPdfPrepare();
    const { year, month, list } = DL.month;
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    doc.addFileToVFS("DejaVuSans.ttf", fonts.normal);
    doc.addFileToVFS("DejaVuSans-Bold.ttf", fonts.bold);
    doc.addFont("DejaVuSans.ttf", "DejaVu", "normal");
    doc.addFont("DejaVuSans-Bold.ttf", "DejaVu", "bold");

    const n = belgradeNow();
    const sum = (f) => list.reduce((s, p) => s + f(p), 0);
    const planned = sum(p => p.planned), onTime = sum(p => p.onTime);
    doc.setFont("DejaVu", "bold"); doc.setFontSize(16);
    doc.text(`Dolasci — ${MONTH_NAMES_SR[month - 1]} ${year}.`, 14, 18);
    doc.setFont("DejaVu", "normal"); doc.setFontSize(9); doc.setTextColor(110);
    doc.text(`Izveštaj napravljen ${n.getDate()}.${n.getMonth() + 1}.${n.getFullYear()}. u ${dlHHMM(n)}` +
      (document.getElementById("dl-month-note").textContent ? ` · ${document.getElementById("dl-month-note").textContent}` : ""), 14, 24);
    doc.setTextColor(30); doc.setFontSize(10);
    doc.text(`Na vreme: ${planned ? Math.round(onTime / planned * 100) : 0}% (${onTime} od ${planned} smena)   ·   ` +
      `Kašnjenja: ${sum(p => p.lateN)} (ukupno ${sum(p => p.lateMin)} min)   ·   Bez prijave: ${sum(p => p.missed.length)}`, 14, 31);

    const green = [30, 74, 58];
    const base = { font: "DejaVu", fontSize: 8.5, cellPadding: 1.8, lineColor: [228, 222, 208], lineWidth: 0.1 };
    doc.autoTable({
      startY: 36,
      head: [["Zaposleni", "Smena", "Prijavljen", "Na vreme", "Kasnio", "Kašnjenje (min)", "Bez prijave", "Van rasporeda"]],
      body: list.map(p => [p.name, p.planned, p.came, p.onTime, p.lateN, p.lateMin, p.missed.length, p.extra.length]),
      styles: base,
      headStyles: { fillColor: green, textColor: 255, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 52 }, 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" } },
      alternateRowStyles: { fillColor: [247, 246, 241] },
      didParseCell: (d) => {
        if (d.section !== "body") return;
        if ((d.column.index === 4 || d.column.index === 5) && +d.cell.raw > 0) d.cell.styles.textColor = [163, 90, 0];
        if (d.column.index === 6 && +d.cell.raw > 0) d.cell.styles.textColor = [192, 57, 43];
      },
    });

    const details = list.filter(p => p.late.length || p.missed.length || p.extra.length).map(p => [
      p.name,
      p.late.map(a => `${dlShortDate(a.work_date)} ${dlShiftLabel(a.shift_code, a.is_medju_smena)} (${a.late_minutes} min)`).join(", "),
      [...p.missed.map(r => `${dlShortDate(r.date)} ${dlShiftLabel(r.shift_code, r.is_medju_smena)}`),
       ...p.extra.map(a => `${dlShortDate(a.work_date)} van rasporeda`)].join(", "),
    ]);
    if (details.length) {
      let y = doc.lastAutoTable.finalY + 10;
      if (y > 260) { doc.addPage(); y = 18; }
      doc.setFont("DejaVu", "bold"); doc.setFontSize(11); doc.text("Detalji po zaposlenom", 14, y);
      doc.autoTable({
        startY: y + 3,
        head: [["Zaposleni", "Kašnjenja", "Bez prijave / van rasporeda"]],
        body: details,
        styles: base,
        headStyles: { fillColor: green, textColor: 255, fontStyle: "bold" },
        columnStyles: { 0: { cellWidth: 42 } },
      });
    }

    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFont("DejaVu", "normal"); doc.setFontSize(8); doc.setTextColor(140);
      doc.text(`Raspored App · strana ${i}/${pages}`, 196, 290, { align: "right" });
    }
    doc.save(`dolasci_${MONTH_NAMES_SR[month - 1].toLowerCase()}_${year}.pdf`);
  } catch (e) {
    console.error(e);
    dlBanner("PDF nije napravljen: " + dlEsc(e.message || e));
  }
  btn.disabled = false;
  btn.textContent = "Preuzmi PDF";
}

// ---------------- Kontrole (kače se odmah, podaci tek posle admin-ready) ----------------

function dlSetView(view) {
  DL.view = view;
  document.querySelectorAll(".dl-tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  document.getElementById("dl-view-day").hidden = view !== "day";
  document.getElementById("dl-view-month").hidden = view !== "month";
  try { localStorage.setItem("dl-view", view); } catch (e) { /* nije bitno */ }
}

(() => {
  const dateInput = document.getElementById("dl-date");
  const shiftDay = (delta) => {
    const d = new Date(dateInput.value + "T00:00:00");
    d.setDate(d.getDate() + delta);
    dateInput.value = dlIso(d);
    dlLoadDay();
  };
  const shiftMonth = (delta) => {
    const d = new Date(DL.ym.year, DL.ym.month - 1 + delta, 1);
    DL.ym = { year: d.getFullYear(), month: d.getMonth() + 1 };
    dlLoadMonth();
  };
  dateInput.addEventListener("change", () => { if (dateInput.value) dlLoadDay(); });
  document.getElementById("dl-day-prev").addEventListener("click", () => shiftDay(-1));
  document.getElementById("dl-day-next").addEventListener("click", () => shiftDay(1));
  document.getElementById("dl-month-prev").addEventListener("click", () => shiftMonth(-1));
  document.getElementById("dl-month-next").addEventListener("click", () => shiftMonth(1));
  document.getElementById("dl-pdf").addEventListener("click", dlDownloadPdf);
  document.querySelectorAll(".dl-tab").forEach(t => t.addEventListener("click", () => dlSetView(t.dataset.view)));

  document.getElementById("dl-day-list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".dl-del");
    if (!btn || !confirm("Obrisati ovu prijavu dolaska?")) return;
    const { error } = await sb.from("attendance").delete().eq("id", btn.dataset.id);
    if (error) return dlBanner("Brisanje nije uspelo: " + dlEsc(error.message));
    dlLoadDay();
    dlLoadMonth();
  });
  document.getElementById("dl-month-list").addEventListener("click", (e) => {
    const head = e.target.closest(".dl-p-head");
    if (!head) return;
    const card = head.parentElement;
    const detail = card.querySelector(".dl-p-detail");
    detail.hidden = !detail.hidden;
    card.classList.toggle("open", !detail.hidden);
  });

  const now = belgradeNow();
  dateInput.value = dlIso(now);
  DL.ym = { year: now.getFullYear(), month: now.getMonth() + 1 };
  let saved = null;
  try { saved = localStorage.getItem("dl-view"); } catch (e) { /* nije bitno */ }
  dlSetView(saved === "month" ? "month" : "day");
})();

function dlRefresh() { dlLoadDay(); dlLoadMonth(); }
document.addEventListener("admin-ready", () => { if (adminCurrentTab === "dolasci") dlRefresh(); });
document.addEventListener("admin-tab-change", (e) => { if (e.detail.to === "dolasci") dlRefresh(); });
