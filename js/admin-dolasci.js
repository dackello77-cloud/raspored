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
function dlShiftLabel(code, isMS) { return OFFICE_CODE_LABEL[code] || (isMS ? `${code} · MS` : code); }
const DL_DOW = ["Nedelja", "Ponedeljak", "Utorak", "Sreda", "Četvrtak", "Petak", "Subota"];
function dlLongDate(iso) {
  const d = new Date(iso + "T00:00:00");
  return `${DL_DOW[d.getDay()]}, ${d.getDate()}. ${MONTH_NAMES_SR[d.getMonth()].toLowerCase()}`;
}

// Smena koja je sada u toku (kao "Sada:" na Rasporedu: I 7–15, II 15–23, III 23–7).
// III posle ponoći pripada prethodnom danu.
function dlCurrentShift() {
  const now = belgradeNow();
  const h = now.getHours();
  if (h >= 7 && h < 15) return { date: dlIso(now), code: "I" };
  if (h >= 15 && h < 23) return { date: dlIso(now), code: "II" };
  if (h >= 23) return { date: dlIso(now), code: "III" };
  return { date: dlIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)), code: "III" };
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

// Zaposleni (aktivni) sa imenom, HR oznakom i funkcijom — za grupe Office manager / HR / Accounting.
async function dlFetchPeople() {
  const { data } = await sb.from("employees")
    .select("id, funkcija, active, profiles(full_name, hr_manager, role)").eq("active", true);
  return (data || []).map(e => ({ id: e.id, funkcija: e.funkcija, name: e.profiles?.full_name || "—", hr: !!e.profiles?.hr_manager }));
}
// Odobreni slobodni dani u periodu: Set "employeeId|datum".
async function dlFetchDaysOff(from, to) {
  const { data } = await sb.from("swap_requests").select("requester_id, date")
    .eq("kind", "day_off").eq("status", "approved").gte("date", from).lte("date", to);
  return new Set((data || []).map(r => `${r.requester_id}|${r.date}`));
}
// Pitanja za izostanak (sql/migration_016_absence_queries.sql): Map "employeeId|datum|smena" -> red.
async function dlFetchAbsence(from, to) {
  const { data, error } = await sb.from("absence_queries")
    .select("id, employee_id, work_date, shift_code, question, asked_at, answer, answered_at")
    .gte("work_date", from).lte("work_date", to);
  return new Map((error ? [] : data || []).map(q => [`${q.employee_id}|${q.work_date}|${q.shift_code}`, q]));
}
// HR / admin mogu da pitaju; Management samo čita.
function dlCanAsk() { return window.DL_CAN_ASK !== undefined ? !!window.DL_CAN_ASK : !window.DL_READONLY; }
// Ispod reda "Bez prijave": dugme "Pitaj zašto", ili poslato pitanje i odgovor.
function dlAbsHtml(q, empId, date, code, name) {
  if (!q) {
    return dlCanAsk()
      ? `<div class="dl-abs"><button type="button" class="dl-ask" data-emp="${empId}" data-date="${date}" data-code="${code}" data-name="${dlEsc(name)}">✉ Pitaj zašto nije došao/la</button></div>`
      : "";
  }
  const asked = DL_TIME_FMT.format(new Date(q.asked_at));
  return `<div class="dl-abs${q.answer ? " answered" : ""}">
    <div><b>Pitanje:</b> ${dlEsc(q.question)}</div>
    ${q.answer
      ? `<div><b>Odgovor:</b> ${dlEsc(q.answer)} <small>(${dlShortDate(q.answered_at.slice(0, 10))} ${DL_TIME_FMT.format(new Date(q.answered_at))})</small></div>`
      : `<div class="dl-abs-wait">Čeka odgovor · poslato ${dlShortDate(q.asked_at.slice(0, 10))} u ${asked}</div>`}
    ${dlCanAsk() && !q.answer ? `<button type="button" class="dl-ask-del" data-id="${q.id}">Povuci pitanje</button>` : ""}
  </div>`;
}

function dlOfficeStart(date, code) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, code === "OM" ? 8 : 15, 0);
}

async function dlLoadDay() {
  if (!(await dlEnsureBase())) return;
  const date = document.getElementById("dl-date").value;
  const list = document.getElementById("dl-day-list");
  const summary = document.getElementById("dl-day-summary");
  const today = dlIso(belgradeNow());
  const current = dlCurrentShift();
  document.getElementById("dl-day-label").textContent =
    date === today ? `Danas · ${dlLongDate(date).split(", ")[1]}` : dlLongDate(date);
  if (!list.children.length) list.innerHTML = `<div class="dl-empty">Učitavanje…</div>`;

  const [{ data: sched, error: e1 }, { data: att, error: e2 }, people, daysOff, sick, absence] = await Promise.all([
    sb.from("schedule")
      .select("id, date, shift_code, is_medju_smena, is_leader, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name))")
      .eq("date", date),
    sb.from("attendance")
      .select("id, employee_id, checked_at, shift_code, is_medju_smena, late_minutes, employees(profiles(full_name))")
      .eq("work_date", date),
    dlFetchPeople(),
    dlFetchDaysOff(date, date),
    sickFetch(date, date),
    dlFetchAbsence(date, date),
  ]);
  if (e1 || e2) { list.innerHTML = `<div class="dl-empty dl-bad">Greška: ${dlEsc((e1 || e2).message)}</div>`; return; }

  const now = belgradeNow();
  const tracked = date >= DL.startDate;
  const attAll = new Map();   // za čitanje (HR grupa prikazuje iste dolaske još jednom)
  const attLeft = new Map();  // šta još nije prikazano -> na kraju "Van rasporeda"
  const extra = [];
  (att || []).forEach(a => {
    if (a.shift_code) { attAll.set(`${a.employee_id}|${a.shift_code}`, a); attLeft.set(`${a.employee_id}|${a.shift_code}`, a); }
    else extra.push(a);
  });

  const counts = { ok: 0, late: 0, miss: 0, wait: 0, sick: 0 };
  // Status jednog očekivanog dolaska; count=false za ponovljeni prikaz (HR grupa).
  // empId: zaposleni — na bolovanju bez prijave piše "Bolovanje" umesto "Bez prijave".
  const status = (start, a, count, empId) => {
    const c = (k) => { if (count) counts[k]++; };
    if (!a && empId && sickOn(sick, empId, date)) { c("sick"); return `<span class="dl-st sick">Bolovanje</span>`; }
    if (a) return a.late_minutes > 0 ? (c("late"), `<span class="dl-st late">Kasni ${a.late_minutes} min</span>`) : (c("ok"), `<span class="dl-st ok">Na vreme</span>`);
    if (start > now) { c("wait"); return `<span class="dl-st wait">Još nije počela</span>`; }
    if (!tracked) return `<span class="dl-st wait">Pre prijava</span>`;
    c("miss"); return `<span class="dl-st miss">Bez prijave</span>`;
  };
  // abs = [employeeId, smena] — kod "Bez prijave" ispod reda ide pitanje za izostanak.
  const row = (name, details, st, attId, abs) => `<div class="dl-row">
      <div class="dl-who"><b>${dlEsc(name)}</b><small>${details}</small></div>
      ${st}
      ${attId && !window.DL_READONLY ? `<button class="dl-del" data-id="${attId}" type="button" title="Obriši prijavu" aria-label="Obriši prijavu">×</button>` : ""}
      ${abs && st.includes("dl-st miss") ? dlAbsHtml(absence.get(`${abs[0]}|${date}|${abs[1]}`), abs[0], date, abs[1], name) : ""}
    </div>`;
  const came = (a) => a ? ` · došao/la ${DL_TIME_FMT.format(new Date(a.checked_at))}` : "";
  const group = (cls, title, sub, inner, isNow) =>
    `<div class="dl-group ${cls}${isNow ? " dl-current" : ""}"><div class="dl-group-head ${cls}">
      <span>${title}${isNow ? ` <em class="dl-now">U toku</em>` : ""}</span><small>${sub}</small></div>${inner}</div>`;
  const byName = (x, y) => x.name.localeCompare(y.name, "sr");
  const workday = officeIsWorkday(date);
  let html = "";

  // Office manager (08–16) i Accounting (15–23) — nisu u rasporedu, rade pon–pet bez praznika.
  const officeGroup = (funkcija) => {
    const o = OFFICE_ROLES[funkcija];
    const members = people.filter(p => p.funkcija === funkcija).sort(byName);
    if (!members.length) return "";
    const start = dlOfficeStart(date, o.code);
    if (!workday) return group("dl-office", o.label, "", `<div class="dl-row"><div class="dl-who"><small>Neradni dan (vikend ili praznik).</small></div></div>`, false);
    let n = 0, inner = "";
    members.forEach(p => {
      const a = attAll.get(`${p.id}|${o.code}`);
      attLeft.delete(`${p.id}|${o.code}`);
      if (a) n++;
      const st = daysOff.has(`${p.id}|${date}`) && !a ? `<span class="dl-st wait">Slobodan dan</span>` : status(start, a, true, p.id);
      inner += row(p.name, `početak ${dlHHMM(start)}${came(a)}`, st, a && a.id, [p.id, o.code]);
    });
    const isNow = date === today && now >= start && now < new Date(start.getTime() + 8 * 3600e3);
    return group("dl-office", o.label, `prijavljeno ${n}/${members.length}`, inner, isNow);
  };

  // Smene iz rasporeda (za HR grupu i za I/II/III).
  const schedRows = (sched || []).map(r => ({ ...r, start: dlPlannedStart(r.date, r.shift_code, r.is_medju_smena, dlIsLeader(r)) }));

  html += officeGroup("office_manager");

  // HR: prikazuju se ovde i (ponovo) u svojoj smeni.
  const hrPeople = people.filter(p => p.hr).sort(byName);
  if (hrPeople.length) {
    let inner = "";
    hrPeople.forEach(p => {
      const r = schedRows.find(x => x.employee_id === p.id);
      const o = OFFICE_ROLES[p.funkcija];
      if (r) {
        const a = attAll.get(`${p.id}|${r.shift_code}`);
        inner += row(p.name, `${dlShiftLabel(r.shift_code, r.is_medju_smena)} smena · početak ${dlHHMM(r.start)}${came(a)}`, status(r.start, a, false, p.id), null);
      } else if (o && workday && !daysOff.has(`${p.id}|${date}`)) {
        const start = dlOfficeStart(date, o.code);
        const a = attAll.get(`${p.id}|${o.code}`);
        inner += row(p.name, `${o.label} · početak ${dlHHMM(start)}${came(a)}`, status(start, a, false, p.id), null);
      } else {
        inner += row(p.name, daysOff.has(`${p.id}|${date}`) ? "slobodan dan" : "ne radi ovog dana", `<span class="dl-st wait">Slobodan</span>`, null);
      }
    });
    html += group("dl-hr", "HR", `${hrPeople.length}`, inner, false);
  }

  html += officeGroup("accounting");

  DL_SHIFT_ORDER.forEach(code => {
    const sickLast = (r) => sickOn(sick, r.employee_id, date) ? 1 : 0;
    const rows = schedRows.filter(r => r.shift_code === code)
      .sort((a, b) => (sickLast(a) - sickLast(b)) || (a.is_medju_smena - b.is_medju_smena) || (dlIsLeader(b) - dlIsLeader(a)) || dlName(a).localeCompare(dlName(b), "sr"));
    if (!rows.length) return;
    let n = 0, inner = "";
    rows.forEach(r => {
      const a = attAll.get(`${r.employee_id}|${code}`);
      attLeft.delete(`${r.employee_id}|${code}`);
      if (a) n++;
      const role = r.is_medju_smena ? "Međusmena · " : sickLast(r) ? "" : dlIsLeader(r) ? "Lider · " : "";
      inner += row(dlName(r), `${role}početak ${dlHHMM(r.start)}${came(a)}`, status(r.start, a, true, r.employee_id), a && a.id, [r.employee_id, code]);
    });
    const isNow = current.date === date && current.code === code;
    html += group(`shift-${code}`, DL.shiftTypes[code]?.label || code, `prijavljeno ${n}/${rows.length}`, inner, isNow);
  });

  // Prijave za smene koje su u međuvremenu skinute iz rasporeda + dolasci van rasporeda.
  const others = [...attLeft.values(), ...extra];
  if (others.length) {
    let inner = "";
    others.forEach(a => {
      inner += row(dlName(a), `došao/la ${DL_TIME_FMT.format(new Date(a.checked_at))}${a.shift_code ? ` · ${OFFICE_CODE_LABEL[a.shift_code] || dlShiftLabel(a.shift_code, a.is_medju_smena)}` : ""}`,
        `<span class="dl-st extra">Nije u rasporedu</span>`, a.id);
    });
    html += group("", "Van rasporeda", `${others.length}`, inner, false);
  }

  list.innerHTML = html || `<div class="dl-empty">Za ovaj dan nema rasporeda ni prijava.</div>`;
  summary.innerHTML = html ? [
    `<span class="dl-st ok">Na vreme ${counts.ok}</span>`,
    `<span class="dl-st late">Kasnili ${counts.late}</span>`,
    `<span class="dl-st miss">Bez prijave ${counts.miss}</span>`,
    counts.sick ? `<span class="dl-st sick">Bolovanje ${counts.sick}</span>` : "",
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

  const [{ data: sched, error: e1 }, { data: att, error: e2 }, staff, daysOff, sick, absence] = await Promise.all([
    sb.from("schedule")
      .select("date, shift_code, is_medju_smena, is_leader, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name))")
      .gte("date", from).lte("date", to).range(0, 4999),
    sb.from("attendance")
      .select("employee_id, checked_at, work_date, shift_code, is_medju_smena, late_minutes, employees(profiles(full_name))")
      .gte("work_date", from).lte("work_date", to).range(0, 4999),
    dlFetchPeople(),
    dlFetchDaysOff(from, to),
    sickFetch(from, to),
    dlFetchAbsence(from, to),
  ]);
  if (e1 || e2) { listEl.innerHTML = `<div class="dl-empty dl-bad">Greška: ${dlEsc((e1 || e2).message)}</div>`; return; }
  if (DL.ym.year !== year || DL.ym.month !== month) return; // korisnik je u međuvremenu promenio mesec

  const now = belgradeNow();
  const people = new Map();
  const person = (id, name) => {
    if (!people.has(id)) people.set(id, { name, planned: 0, came: 0, onTime: 0, lateN: 0, lateMin: 0, missed: [], late: [], extra: [], sick: [], sickDays: 0 });
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
    if (!a && (!started || r.date < DL.startDate || sickOn(sick, r.employee_id, r.date))) return;
    p.planned++;
    if (!a) { p.missed.push({ ...r, q: absence.get(key) }); return; }
    p.came++;
    if (a.late_minutes > 0) { p.lateN++; p.lateMin += a.late_minutes; p.late.push(a); }
    else p.onTime++;
  });
  // Office manager / Accounting: svaki radni dan (pon–pet, bez praznika i odobrenih slobodnih dana).
  staff.filter(e => OFFICE_ROLES[e.funkcija]).forEach(e => {
    const o = OFFICE_ROLES[e.funkcija];
    const p = person(e.id, e.name);
    for (let d = new Date(year, month - 1, 1); d.getMonth() === month - 1; d.setDate(d.getDate() + 1)) {
      const date = dlIso(d);
      if (!officeIsWorkday(date) || daysOff.has(`${e.id}|${date}`)) continue;
      if (sickOn(sick, e.id, date) && !attByKey.has(`${e.id}|${date}|${o.code}`)) continue;
      const key = `${e.id}|${date}|${o.code}`;
      const a = attByKey.get(key);
      attByKey.delete(key);
      if (!a && (dlOfficeStart(date, o.code) > now || date < DL.startDate)) continue;
      p.planned++;
      if (!a) { p.missed.push({ date, shift_code: o.code, is_medju_smena: false, q: absence.get(key) }); continue; }
      p.came++;
      if (a.late_minutes > 0) { p.lateN++; p.lateMin += a.late_minutes; p.late.push(a); }
      else p.onTime++;
    }
  });
  attByKey.forEach(a => person(a.employee_id, dlName(a)).extra.push(a));

  // Bolovanja u ovom mesecu (period skraćen na mesec, broj kalendarskih dana).
  const staffName = new Map(staff.map(e => [e.id, e.name]));
  sick.forEach(r => {
    const p = person(r.employee_id, staffName.get(r.employee_id) || "—");
    const days = sickDaysIn(r, from, to);
    p.sick.push({ from: r.date_from > from ? r.date_from : from, to: r.date_to < to ? r.date_to : to, days, whole: r });
    p.sickDays += days;
  });

  // Redosled kao u dnevnom pregledu: Office manager, HR, Accounting, pa ostali po imenu.
  const info = new Map(staff.map(e => [e.id, e]));
  const rank = (id) => { const e = info.get(id) || {}; return e.funkcija === "office_manager" ? 0 : e.hr ? 1 : e.funkcija === "accounting" ? 2 : 3; };
  people.forEach((p, id) => { p.rank = rank(id); p.tag = OFFICE_ROLES[(info.get(id) || {}).funkcija]?.label || ((info.get(id) || {}).hr ? "HR" : ""); });
  const list = [...people.values()].filter(p => p.planned || p.extra.length || p.sickDays)
    .sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name, "sr"));
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
    <div class="dl-tile miss"><b>${sum(p => p.missed.length)}</b><span>bez prijave</span><small>smena</small></div>
    <div class="dl-tile sick"><b>${sum(p => p.sickDays)}</b><span>bolovanje</span><small>dana · ${list.filter(p => p.sickDays).length} osoba</small></div>` : "";
  noteEl.textContent = from <= DL.startDate && DL.startDate <= to
    ? `Prijave se vode od ${dlShortDate(DL.startDate)} — ranije smene se ne računaju.` : "";
  document.getElementById("dl-pdf").disabled = !list.length;

  // Kategorija "Bolovanje": ko je, od kad do kad i koliko dana (u ovom mesecu).
  const sickList = list.filter(p => p.sickDays);
  const sickHtml = sickList.length ? `<div class="dl-sick-box"><div class="dl-sick-title">Bolovanje</div>${sickList.map(p =>
    `<div class="dl-sick-row"><b>${dlEsc(p.name)}</b><span class="dl-st sick">${p.sickDays} ${p.sickDays === 1 ? "dan" : "dana"}</span>
      <small>${p.sick.map(dlSickPeriod).join(", ")}</small></div>`).join("")}</div>` : "";

  listEl.innerHTML = sickHtml + (list.length ? list.map((p, i) => {
    const badges = [
      p.lateN ? `<span class="dl-st late">Kasnio ${p.lateN}× · ${p.lateMin} min</span>` : "",
      p.missed.length ? `<span class="dl-st miss">Bez prijave ${p.missed.length}</span>` : "",
      p.extra.length ? `<span class="dl-st extra">Van rasporeda ${p.extra.length}</span>` : "",
      p.sickDays ? `<span class="dl-st sick">Bolovanje ${p.sickDays} d</span>` : "",
    ].join("") || `<span class="dl-st ok">Uredno</span>`;
    const detail = [
      p.late.length ? `<b>Kašnjenja:</b> ${p.late.map(a => `${dlShortDate(a.work_date)} ${dlShiftLabel(a.shift_code, a.is_medju_smena)} (${a.late_minutes} min)`).join(", ")}` : "",
      p.missed.length ? `<b>Bez prijave:</b> ${p.missed.map(r => `${dlShortDate(r.date)} ${dlShiftLabel(r.shift_code, r.is_medju_smena)}${dlMissNote(r)}`).join(", ")}` : "",
      p.extra.length ? `<b>Van rasporeda:</b> ${p.extra.map(a => `${dlShortDate(a.work_date)} u ${DL_TIME_FMT.format(new Date(a.checked_at))}`).join(", ")}` : "",
      p.sickDays ? `<b>Bolovanje:</b> ${p.sick.map(dlSickPeriod).join(", ")}` : "",
    ].filter(Boolean).join("<br>") || "Sve smene na vreme.";
    return `<div class="dl-person" data-i="${i}">
      <div class="dl-p-head">
        <div class="dl-who"><b>${dlEsc(p.name)}${p.tag ? ` <span class="dl-tag">${p.tag}</span>` : ""}</b><small>${p.planned} smena · prijavljen ${p.came} · na vreme ${p.onTime}</small></div>
        <div class="dl-p-badges">${badges}</div>
        <span class="dl-chev">›</span>
      </div>
      <div class="dl-p-detail" hidden>${detail}</div>
    </div>`;
  }).join("") : `<div class="dl-empty">Nema podataka za ovaj mesec.</div>`);
}

// Uz izostanak: odgovor radnika ili "čeka odgovor".
function dlMissNote(r, plain) {
  if (!r.q) return "";
  const text = r.q.answer ? `odgovor: ${r.q.answer}` : "čeka odgovor";
  return plain ? ` (${text})` : ` <i class="dl-miss-note">(${dlEsc(text)})</i>`;
}

// "3.10.–7.10. (5 dana)"; ako bolovanje traje i van meseca, piše ceo period.
function dlSickPeriod(s) {
  const whole = s.whole.date_from !== s.from || s.whole.date_to !== s.to
    ? ` — ukupno ${dlShortDate(s.whole.date_from)}–${dlShortDate(s.whole.date_to)}` : "";
  return `${dlShortDate(s.from)}–${dlShortDate(s.to)} (${s.days} ${s.days === 1 ? "dan" : "dana"}${whole})`;
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
      `Kašnjenja: ${sum(p => p.lateN)} (ukupno ${sum(p => p.lateMin)} min)   ·   Bez prijave: ${sum(p => p.missed.length)}   ·   Bolovanje: ${sum(p => p.sickDays)} dana`, 14, 31);

    const green = [30, 74, 58];
    const base = { font: "DejaVu", fontSize: 8.5, cellPadding: 1.8, lineColor: [228, 222, 208], lineWidth: 0.1 };
    doc.autoTable({
      startY: 36,
      head: [["Zaposleni", "Smena", "Prijavljen", "Na vreme", "Kasnio", "Kašnjenje (min)", "Bez prijave", "Van rasporeda", "Bolovanje (dana)"]],
      body: list.map(p => [p.name, p.planned, p.came, p.onTime, p.lateN, p.lateMin, p.missed.length, p.extra.length, p.sickDays]),
      styles: base,
      headStyles: { fillColor: green, textColor: 255, fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 44 }, 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" }, 8: { halign: "right" } },
      alternateRowStyles: { fillColor: [247, 246, 241] },
      didParseCell: (d) => {
        if (d.section !== "body") return;
        if ((d.column.index === 4 || d.column.index === 5) && +d.cell.raw > 0) d.cell.styles.textColor = [163, 90, 0];
        if (d.column.index === 6 && +d.cell.raw > 0) d.cell.styles.textColor = [192, 57, 43];
        if (d.column.index === 8 && +d.cell.raw > 0) d.cell.styles.textColor = [107, 63, 184];
      },
    });

    const sickRows = list.filter(p => p.sickDays).map(p => [p.name, p.sickDays, p.sick.map(dlSickPeriod).join(", ")]);
    if (sickRows.length) {
      let y = doc.lastAutoTable.finalY + 10;
      if (y > 260) { doc.addPage(); y = 18; }
      doc.setFont("DejaVu", "bold"); doc.setFontSize(11); doc.text("Bolovanje", 14, y);
      doc.autoTable({
        startY: y + 3,
        head: [["Zaposleni", "Dana", "Period"]],
        body: sickRows,
        styles: base,
        headStyles: { fillColor: green, textColor: 255, fontStyle: "bold" },
        columnStyles: { 0: { cellWidth: 42 }, 1: { cellWidth: 16, halign: "right" } },
      });
    }

    const details = list.filter(p => p.late.length || p.missed.length || p.extra.length).map(p => [
      p.name,
      p.late.map(a => `${dlShortDate(a.work_date)} ${dlShiftLabel(a.shift_code, a.is_medju_smena)} (${a.late_minutes} min)`).join(", "),
      [...p.missed.map(r => `${dlShortDate(r.date)} ${dlShiftLabel(r.shift_code, r.is_medju_smena)}${dlMissNote(r, true)}`),
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
    const ask = e.target.closest(".dl-ask");
    if (ask) return dlOpenAskDialog(ask.dataset);
    const askDel = e.target.closest(".dl-ask-del");
    if (askDel) {
      if (!confirm("Povući pitanje? Radnik ga više neće videti.")) return;
      const { error } = await sb.from("absence_queries").delete().eq("id", askDel.dataset.id);
      if (error) return dlBanner("Nije uspelo: " + dlEsc(error.message));
      return dlRefresh();
    }
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
  dateInput.value = dlCurrentShift().date;
  // Dan sa smenom u toku se sam osvežava svakog minuta (novi dolasci, "U toku").
  setInterval(() => {
    if (document.hidden || document.getElementById("dl-view-day").offsetParent === null) return;
    const cur = dlCurrentShift();
    if (dateInput.value === cur.date || dateInput.value === dlIso(belgradeNow())) dlLoadDay();
  }, 60 * 1000);
  DL.ym = { year: now.getFullYear(), month: now.getMonth() + 1 };
  let saved = null;
  try { saved = localStorage.getItem("dl-view"); } catch (e) { /* nije bitno */ }
  dlSetView(saved === "month" ? "month" : "day");
})();

function dlRefresh() { dlLoadDay(); dlLoadMonth(); }

// Prozor "Pitaj zašto nije došao/la" — poruka ide radniku; on mora da odgovori pri sledećem otvaranju aplikacije.
function dlOpenAskDialog({ emp, date, code, name }) {
  document.getElementById("dl-ask-dialog")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "dl-ask-dialog";
  overlay.className = "pw-overlay";
  overlay.innerHTML = `
    <form class="pw-box" novalidate>
      <h3>Pitaj: ${dlEsc(name)}</h3>
      <div class="muted" style="font-size:12.5px">${dlLongDate(date)} · ${dlEsc(OFFICE_CODE_LABEL[code] || code + " smena")} — bez prijave dolaska</div>
      <label>Poruka<textarea name="q" required>Nisi prijavio/la dolazak na posao ${dlShortDate(date)} (${dlEsc(OFFICE_CODE_LABEL[code] || code + " smena")}). Zašto nisi došao/la?</textarea></label>
      <div class="pw-msg"></div>
      <div class="pw-actions">
        <button type="button" class="btn btn-ghost pw-cancel">Otkaži</button>
        <button type="submit" class="btn btn-primary">Pošalji</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);
  const form = overlay.querySelector("form");
  const close = () => overlay.remove();
  overlay.querySelector(".pw-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = form.q.value.trim();
    const msg = overlay.querySelector(".pw-msg");
    if (!text) { msg.textContent = "Upiši poruku."; msg.className = "pw-msg err"; return; }
    form.querySelector("[type=submit]").disabled = true;
    const { data: added, error } = await sb.from("absence_queries")
      .insert({ employee_id: emp, work_date: date, shift_code: code, question: text }).select("id").single();
    if (error) {
      msg.textContent = /absence_queries/.test(error.message) && /exist|schema cache/.test(error.message)
        ? "Treba jednom pokrenuti sql/migration_016_absence_queries.sql u Supabase." : error.message;
      msg.className = "pw-msg err";
      form.querySelector("[type=submit]").disabled = false;
      return;
    }
    // Obaveštenje na telefon radnika (funkcija send-push; ne čeka se odgovor).
    sb.functions.invoke("send-push", { body: { absence: added.id } }).catch(() => {});
    close();
    dlBanner(`Pitanje je poslato — ${dlEsc(name)} mora da odgovori kad sledeći put otvori aplikaciju.`, "success");
    dlRefresh();
  });
  form.q.focus();
}
document.addEventListener("admin-ready", () => { if (adminCurrentTab === "dolasci") dlRefresh(); });
document.addEventListener("admin-tab-change", (e) => { if (e.detail.to === "dolasci") dlRefresh(); });
