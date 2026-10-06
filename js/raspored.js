function pad2(n) { return String(n).padStart(2, "0"); }

function monthRange(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  return { start, end, lastDay };
}

function shiftTimeLabel(shiftType) {
  return `${shiftType.start_time.slice(0, 5)}–${shiftType.end_time.slice(0, 5)}`;
}

function currentShiftCode(shiftTypes, now) {
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const st of shiftTypes) {
    const [sh, sm] = st.start_time.split(":").map(Number);
    const [eh, em] = st.end_time.split(":").map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    if (startMins < endMins) {
      if (mins >= startMins && mins < endMins) return st.code;
    } else {
      // smena koja prelazi preko ponoći (npr. III smena 23:00–07:00)
      if (mins >= startMins || mins < endMins) return st.code;
    }
  }
  return null;
}

// Korisničko ime prijavljenog zaposlenog — on je markiran i prvi u svakoj svojoj smeni.
let RASPORED_ME = null;
// Prijavljeni zaposleni (radnik, lider, monitoring): desni klik na sebe -> slobodan dan,
// a radnik desnim klikom na drugog radnika traži zamenu.
let RASPORED_ME_EMP = null;

function renderChip(person, shiftCode) {
  const funkcija = person.funkcija || "radnik";
  const dot = person.isLeader ? DOT_LEADER : person.isMS ? DOT_MS : (DOT_BY_FUNKCIJA[funkcija] || DOT_BY_FUNKCIJA.radnik);
  const name = (person.full_name || person.username || "").toUpperCase();
  const ms = person.isMS && MS_LABEL[shiftCode] ? `<span class="ms-tag">${MS_LABEL[shiftCode]}</span>` : "";
  // shift lider / monitoring / postavljeni lider uvek ostaju na početku smene
  const fixed = person.isLeader || funkcija === "shift_lider" || funkcija === "monitoring";
  const isMe = RASPORED_ME && person.username && person.username.toLowerCase() === RASPORED_ME;
  return `<span class="chip on-white emp-chip${isMe ? " is-me" : ""}${RASPORED_ME_EMP ? " can-swap" : ""}" data-name="${name.toLowerCase()}" data-emp="${person.employee_id}" data-shift="${person.shift_code}" data-funkcija="${funkcija}"${fixed ? ' data-fixed="1"' : ""}>
    <span class="dot" style="background:${dot}"></span>${name}${ms}
  </span>`;
}

// Lider prvi, pa ostali. Međusmena ima svoju kolonu (između I i II, i između II i III).
function renderShiftPeople(list, shiftCode) {
  const main = list.filter(p => !p.isMS);
  if (!main.length) return '<span class="empty">—</span>';
  return main.map(p => renderChip(p, shiftCode)).join("");
}

const MS_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>';

// Kolone u redu: I, MS (13–21), II, MS (21–05), III
function scheduleColumns(shiftTypes) {
  const cols = [];
  shiftTypes.forEach(st => {
    cols.push({ kind: "shift", st });
    if (MS_LABEL[st.code]) cols.push({ kind: "ms", code: st.code, time: MS_LABEL[st.code].replace("MS ", "") });
  });
  return cols;
}

async function fetchShiftTypes() {
  const { data } = await sb.from("shift_types").select("*").order("sort_order");
  return data || [];
}

async function fetchScheduleForMonth(year, month) {
  const { start, end } = monthRange(year, month);
  const { data, error } = await sb
    .from("schedule")
    .select("date, shift_code, is_leader, is_medju_smena, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name, username))")
    .gte("date", start)
    .lte("date", end)
    .order("date");
  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

function groupByDateAndShift(rows) {
  const map = {};
  for (const row of rows) {
    if (!map[row.date]) map[row.date] = { I: [], II: [], III: [] };
    const emp = row.employees;
    map[row.date][row.shift_code].push({
      employee_id: row.employee_id,
      shift_code: row.shift_code,
      isLeader: !!row.is_leader,
      isMS: !!row.is_medju_smena,
      funkcija: emp ? emp.funkcija : "radnik",
      full_name: emp && emp.profiles ? emp.profiles.full_name : "",
      username: emp && emp.profiles ? emp.profiles.username : "",
    });
  }
  Object.values(map).forEach(day => {
    Object.values(day).forEach(list => list.sort((a, b) => (b.isLeader - a.isLeader) || (funkcijaSortValue(a.funkcija) - funkcijaSortValue(b.funkcija))));
  });
  return map;
}

function buildMonthSectionEl(year, month, byDate, shiftTypes, isRealToday) {
  const { lastDay } = monthRange(year, month);
  const todayStr = isRealToday ? `${isRealToday.getFullYear()}-${pad2(isRealToday.getMonth() + 1)}-${pad2(isRealToday.getDate())}` : null;
  const isCurrentMonth = isRealToday && isRealToday.getFullYear() === year && (isRealToday.getMonth() + 1) === month;

  const wrap = document.createElement("div");
  wrap.className = "month-wrap";

  const header = document.createElement("div");
  header.className = "month-header";
  header.innerHTML = `<span>${MONTH_NAMES_SR[month - 1]} ${year}</span><span class="toggle-label">Sakrij</span>`;
  wrap.appendChild(header);

  const body = document.createElement("div");

  const subheader = document.createElement("div");
  subheader.className = "shift-subheader";
  const columns = scheduleColumns(shiftTypes);
  subheader.innerHTML = `<div></div>` + columns.map(col => col.kind === "shift" ? `
    <div class="shift-col shift-${col.st.code}">
      <span class="shift-icon">${SHIFT_ICON_SVG[col.st.code] || ""}</span>
      <span><div class="shift-name">${col.st.label}</div><div class="shift-part">${SHIFT_PART_OF_DAY[col.st.code] || ""}</div></span>
      <span class="shift-time">${shiftTimeLabel(col.st)}</span>
    </div>` : `
    <div class="shift-col ms-col shift-MS">
      <span class="shift-icon">${MS_ICON_SVG}</span>
      <span><div class="shift-name">Međusmena</div><div class="shift-time">${col.time}</div></span>
    </div>`
  ).join("");
  body.appendChild(subheader);

  let prevDaysCount = 0;
  const dayRows = [];

  for (let d = 1; d <= lastDay; d++) {
    const dateObj = new Date(year, month - 1, d);
    const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
    const isToday = todayStr === dateStr;
    const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
    const isPast = isCurrentMonth && isRealToday && dateObj < new Date(isRealToday.getFullYear(), isRealToday.getMonth(), isRealToday.getDate());

    if (isPast) prevDaysCount++;

    const row = document.createElement("div");
    row.className = `day-row ${isWeekend ? "weekend" : ""} ${isToday ? "today" : ""}`;
    row.dataset.date = dateStr;
    if (isPast) row.dataset.prevDay = "1";

    const dayData = byDate[dateStr] || { I: [], II: [], III: [] };
    const activeCode = isToday ? currentShiftCode(shiftTypes, belgradeNow()) : null;

    row.innerHTML = `
      <div class="date-label">
        <span class="dnum">${pad2(d)}</span>
        <span class="dmeta">
          <span class="dow">${DOW_SR[dateObj.getDay()]}</span>
          <span class="dmon">${MONTH_NAMES_SR[month - 1].slice(0, 3)}</span>
          ${isToday ? '<span class="today-badge">Danas</span>' : ""}
        </span>
      </div>
      ${columns.map(col => {
        if (col.kind === "shift") {
          const st = col.st;
          return `<div class="shift-cell shift-${st.code} ${activeCode === st.code ? "active-shift" : ""}" data-label="${st.label} · ${shiftTimeLabel(st)}">
            ${renderShiftPeople(dayData[st.code] || [], st.code)}
          </div>`;
        }
        const ms = (dayData[col.code] || []).filter(p => p.isMS);
        return `<div class="shift-cell ms-cell shift-MS ${ms.length ? "" : "is-empty"}" data-label="Međusmena · ${col.time}">
          ${ms.length ? ms.map(p => renderChip(p, null)).join("") : '<span class="empty">—</span>'}
        </div>`;
      }).join("")}
    `;
    // zapamti prvobitni redosled u svakoj smeni (pretraga ga privremeno menja)
    row.querySelectorAll(".shift-cell").forEach(cell => {
      cell.querySelectorAll(":scope > .emp-chip").forEach((chip, i) => { chip.dataset.order = i; });
    });
    dayRows.push(row);
  }

  if (prevDaysCount > 0) {
    const toggle = document.createElement("div");
    toggle.className = "prev-days-toggle";
    toggle.textContent = `Prikaži prethodne dane (${prevDaysCount})`;
    let shown = false;
    toggle.addEventListener("click", () => {
      shown = !shown;
      dayRows.forEach(r => {
        if (r.dataset.prevDay === "1") r.style.display = shown ? "grid" : "none";
      });
      toggle.textContent = shown ? "Sakrij prethodne dane" : `Prikaži prethodne dane (${prevDaysCount})`;
    });
    body.appendChild(toggle);
  }

  dayRows.forEach(r => {
    if (r.dataset.prevDay === "1") r.style.display = "none";
    body.appendChild(r);
  });

  wrap.appendChild(body);

  let collapsed = false;
  header.addEventListener("click", () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? "none" : "";
    header.querySelector(".toggle-label").textContent = collapsed ? "Prikaži" : "Sakrij";
  });

  return wrap;
}

function applySearchFilter(term) {
  const chips = document.querySelectorAll(".emp-chip");
  const t = term.trim().toLowerCase();

  // Prijavljeni zaposleni je uvek prvi u svojoj smeni (ispred lidera). Tražena osoba
  // se samo markira drugom bojom — ostaje na svom mestu.
  document.querySelectorAll(".day-row .shift-cell").forEach(cell => {
    const list = [...cell.querySelectorAll(":scope > .emp-chip")];
    list.sort((a, b) => a.dataset.order - b.dataset.order).forEach(c => cell.appendChild(c));
    const me = list.find(c => c.classList.contains("is-me"));
    if (me) cell.prepend(me);
  });
  let count = 0;
  chips.forEach(chip => {
    const match = !t || chip.dataset.name === t;
    chip.classList.toggle("search-hit", !!t && match);
    if (t && match) count++;
  });

  // Obeleži dane kad traženi radnik NE RADI (nema ni jednu smenu tog dana) drugom bojom.
  document.querySelectorAll(".day-row").forEach(row => {
    const hasMatch = !t || row.querySelector(`.emp-chip[data-name="${t}"]`);
    row.classList.toggle("day-off-for-search", !!t && !hasMatch);
  });

  const info = document.getElementById("filter-search-info");
  if (info) {
    if (!t) info.textContent = "";
    else if (count) info.textContent = `${term.trim().toUpperCase()}: ${count} smena u prikazanom periodu`;
    else info.textContent = "Nema rezultata";
  }
}

async function loadAndRenderMonths() {
  const container = document.getElementById("months-container");
  container.innerHTML = '<div class="empty-note">Učitavanje rasporeda...</div>';

  const shiftTypes = await fetchShiftTypes();
  const now = belgradeNow();
  const year = parseInt(document.getElementById("filter-year").value, 10);
  const month = parseInt(document.getElementById("filter-month").value, 10);

  container.innerHTML = "";

  const showUpcoming = container.dataset.showUpcoming === "1";
  const monthsToRender = [{ year, month }];

  if (showUpcoming) {
    const { data } = await sb
      .from("schedule")
      .select("date")
      .gte("date", `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`)
      .order("date");
    const seen = new Set(monthsToRender.map(m => `${m.year}-${m.month}`));
    (data || []).forEach(row => {
      const [y, m] = row.date.split("-").map(Number);
      const key = `${y}-${m}`;
      if (!seen.has(key)) {
        seen.add(key);
        monthsToRender.push({ year: y, month: m });
      }
    });
    monthsToRender.sort((a, b) => a.year - b.year || a.month - b.month);
  }

  for (const m of monthsToRender) {
    const rows = await fetchScheduleForMonth(m.year, m.month);
    const byDate = groupByDateAndShift(rows);
    container.appendChild(buildMonthSectionEl(m.year, m.month, byDate, shiftTypes, now));
  }

  applySearchFilter(document.getElementById("filter-search").value);
}

// ---------- Zamene: desni klik na radnika -> "Zamena" ----------
function zmChipMenu(ev, chip) {
  if (!RASPORED_ME_EMP) return; // nije prijavljen zaposleni — običan meni pregledača
  ev.preventDefault();
  const row = chip.closest(".day-row, .day-sheet");
  const date = row.dataset.date;
  const targetName = chip.dataset.name.toUpperCase();
  const mine = row.querySelector(`[data-emp="${RASPORED_ME_EMP.id}"]`);
  const today = (() => { const n = belgradeNow(); return `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}`; })();

  // Klik na sebe -> slobodan dan (ide direktno HR-u).
  if (chip.dataset.emp === RASPORED_ME_EMP.id) {
    zmOpenMenu(ev.clientX, ev.clientY, `${targetName} · ${zmFmtDate(date)}`, [{
      label: "Slobodan dan",
      note: date < today ? "Dan je prošao." : "",
      disabled: date < today,
      run: () => zmOpenDayOffDialog(date, chip.dataset.shift),
    }]);
    return;
  }

  let note = "";
  if (RASPORED_ME_EMP.funkcija !== "radnik") note = "Zamenu mogu da traže samo radnici.";
  else if (date < today) note = "Dan je prošao.";
  else if (!mine) note = "Tog dana ne radiš.";
  else if (chip.dataset.funkcija !== "radnik") note = "Zamena je moguća samo sa radnikom.";
  else if (mine.dataset.shift === chip.dataset.shift) note = "Radite istu smenu.";

  zmOpenMenu(ev.clientX, ev.clientY, `${targetName} · ${zmFmtDate(date)}`, [{
    label: `Zamena sa ${targetName}`,
    note,
    disabled: !!note,
    run: () => zmOpenSwapDialog(date,
      { id: RASPORED_ME_EMP.id, shift: mine.dataset.shift },
      { id: chip.dataset.emp, name: targetName, shift: chip.dataset.shift }),
  }]);
}

// Radnik u rasporedu: čip u tabeli, ili red u prozoru "ceo dan" na telefonu.
const ZM_CHIP_SELECTOR = ".day-row .emp-chip, .day-sheet .mob-person[data-emp]";

document.addEventListener("contextmenu", (ev) => {
  const chip = ev.target.closest && ev.target.closest(ZM_CHIP_SELECTOR);
  if (chip) zmChipMenu(ev, chip);
});
// Telefon/tablet nemaju desni klik — tamo isti meni otvara običan dodir na radnika.
if (window.matchMedia("(hover: none)").matches) {
  document.addEventListener("click", (ev) => {
    const chip = ev.target.closest && ev.target.closest(ZM_CHIP_SELECTOR);
    if (chip) { ev.stopPropagation(); zmChipMenu(ev, chip); }
  }, true);
}

// Poruke na vrhu: zahtevi koji čekaju moj odgovor, a za HR i zahtevi za odobrenje.
let ZM_PROFILE = null;
async function zmLoadInbox(profile) {
  if (profile) ZM_PROFILE = profile;
  const box = document.getElementById("zm-inbox");
  const isHR = !!(ZM_PROFILE && (ZM_PROFILE.hr_manager || ZM_PROFILE.role === "admin"));
  const myId = RASPORED_ME_EMP && RASPORED_ME_EMP.id;
  if (!myId && !isHR) { box.hidden = true; return; }
  const { data, error } = await sb.from("swap_requests").select("*")
    .in("status", ["pending_worker", "pending_hr"]).order("date");
  if (error) { box.hidden = true; return; }
  const forMe = (data || []).filter(r => r.status === "pending_worker" && r.target_id === myId);
  const forHR = isHR ? (data || []).filter(r => r.status === "pending_hr") : [];
  if (!forMe.length && !forHR.length) { box.hidden = true; return; }
  const { names } = await zmFetchNames();
  document.getElementById("zm-inbox-list").innerHTML =
    forMe.map(r => zmItemHtml(r, names, ZM_ACTIONS.incoming)).join("") +
    forHR.map(r => zmItemHtml(r, names, ZM_ACTIONS.hr)).join("");
  box.hidden = false;
}

zmOnDone = async (msg, isError) => {
  const box = document.getElementById("zm-banner");
  box.innerHTML = `<div class="banner ${isError ? "error" : "success"}">${zmEsc(msg)}</div>`;
  if (!isError) setTimeout(() => { box.innerHTML = ""; }, 6000);
  await zmLoadInbox();
  if (!isError) {
    // posle odobrenja raspored je promenjen
    document.querySelector(".day-sheet-overlay")?.remove();
    await Promise.all([loadAndRenderMonths(), mobLoad()]);
  }
};

// ---------- Mobilni prikaz (telefon) ----------
// Bez prijave: ko sada radi. Prijavljeni zaposleni: naredne 3 smene, ko sada radi,
// i njegovih narednih 20 dana. Dodir na dan otvara ceo raspored za taj dan.
const MOB = { byDate: {}, shiftTypes: [] };

function mobIso(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function mobAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function mobMins(hhmm) { const [h, m] = hhmm.split(":").map(Number); return h * 60 + (m || 0); }

// Vreme smene (ili međusmene) kao [početak, kraj] u minutama od ponoći tog datuma (kraj može preći 24h).
function mobShiftSpan(code, isMS) {
  if (isMS && MS_LABEL[code]) {
    const [a, b] = MS_LABEL[code].replace("MS ", "").split("–").map(Number);
    return [a * 60, (b <= a ? b + 24 : b) * 60];
  }
  const st = MOB.shiftTypes.find(s => s.code === code);
  if (!st) return [0, 0];
  const a = mobMins(st.start_time), b = mobMins(st.end_time);
  return [a, b <= a ? b + 1440 : b];
}
function mobTimeLabel(code, isMS) {
  if (isMS && MS_LABEL[code]) return MS_LABEL[code].replace("MS ", "") + " h";
  const st = MOB.shiftTypes.find(s => s.code === code);
  return st ? shiftTimeLabel(st) : "";
}

async function mobLoad() {
  const now = belgradeNow();
  const { data } = await sb
    .from("schedule")
    .select("date, shift_code, is_leader, is_medju_smena, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name, username))")
    .gte("date", mobIso(mobAddDays(now, -1)))
    .lte("date", mobIso(mobAddDays(now, 21)))
    .order("date");
  MOB.byDate = groupByDateAndShift(data || []);
  mobRender();
}

function mobPeopleHtml(list, withData) {
  if (!list.length) return '<div class="mob-empty">Niko nije u rasporedu.</div>';
  // prijavljeni zaposleni je prvi u svojoj smeni (isto kao u tabeli)
  const meId = RASPORED_ME_EMP && RASPORED_ME_EMP.id;
  list = [...list].sort((a, b) => (b.employee_id === meId) - (a.employee_id === meId));
  return list.map(p => {
    const dot = p.isLeader ? DOT_LEADER : p.isMS ? DOT_MS : (DOT_BY_FUNKCIJA[p.funkcija] || DOT_BY_FUNKCIJA.radnik);
    const name = (p.full_name || p.username || "").toUpperCase();
    const isMe = RASPORED_ME_EMP && p.employee_id === RASPORED_ME_EMP.id;
    const role = p.isLeader ? "Lider" : p.funkcija === "shift_lider" ? "Shift lider" : p.funkcija === "monitoring" ? "Monitoring" : "";
    const data = withData
      ? ` data-emp="${p.employee_id}" data-shift="${p.shift_code}" data-funkcija="${p.funkcija}" data-name="${name.toLowerCase()}"`
      : "";
    return `<div class="mob-person${isMe ? " is-me" : ""}"${data}><span class="dot" style="background:${dot}"></span>${name}<span class="role">${role}</span></div>`;
  }).join("");
}

// Koja smena je sada (III posle ponoći pripada juče započetoj smeni).
function mobCurrentShift(now) {
  const code = currentShiftCode(MOB.shiftTypes, now);
  if (!code) return null;
  const st = MOB.shiftTypes.find(s => s.code === code);
  const overnight = mobMins(st.start_time) > mobMins(st.end_time);
  const nowM = now.getHours() * 60 + now.getMinutes();
  const date = overnight && nowM < mobMins(st.end_time) ? mobIso(mobAddDays(now, -1)) : mobIso(now);
  return { code, st, date };
}

function mobRender() {
  const box = document.getElementById("mobile-home");
  const now = belgradeNow();
  const today = mobIso(now);
  const nowM = now.getHours() * 60 + now.getMinutes();
  let html = "";

  // Moje smene (sa početkom/krajem) — za "naredne 3" i "narednih 20 dana".
  const mine = [];
  if (RASPORED_ME_EMP) {
    Object.entries(MOB.byDate).forEach(([date, day]) => {
      ["I", "II", "III"].forEach(code => (day[code] || []).forEach(p => {
        if (p.employee_id !== RASPORED_ME_EMP.id) return;
        const [a, b] = mobShiftSpan(code, p.isMS);
        const dayOffset = Math.round((new Date(date + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
        mine.push({ date, code, isMS: p.isMS, start: dayOffset * 1440 + a, end: dayOffset * 1440 + b });
      }));
    });
    mine.sort((x, y) => x.start - y.start);

    // Naredna 3 dana: danas, sutra, prekosutra — smena ili S (slobodan).
    const labels = ["Danas", "Sutra", "Prekosutra"];
    html += `<section class="mob-card"><div class="mob-title">Tvoja naredna 3 dana</div><div class="mob-next">${labels.map((lbl, i) => {
      const iso = mobIso(mobAddDays(now, i));
      const m = mine.find(x => x.date === iso);
      if (!m) {
        return `<div class="mob-next-item is-off" data-day="${iso}"><div class="d">${lbl}</div><div class="s">S</div><div class="t">Slobodan</div></div>`;
      }
      const running = m.start <= nowM && nowM < m.end;
      return `<div class="mob-next-item shift-${m.isMS ? "MS" : m.code}" data-day="${iso}">
          <div class="d">${lbl}</div>
          <div class="s">${m.isMS ? "MS" : m.code}</div>
          <div class="t">${mobTimeLabel(m.code, m.isMS)}</div>
          ${running ? '<span class="now">U toku</span>' : ""}
        </div>`;
    }).join("")}</div></section>`;
  }

  // Ko sada radi.
  const cur = mobCurrentShift(now);
  const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  html += `<section class="mob-card"><div class="mob-title">Sada radi <span class="mob-clock">${clock}</span></div>`;
  if (cur) {
    const list = (MOB.byDate[cur.date] && MOB.byDate[cur.date][cur.code]) || [];
    html += `<div class="mob-now-head shift-${cur.code}">
        <span class="shift-icon">${SHIFT_ICON_SVG[cur.code] || ""}</span>
        <span class="n">${cur.st.label}</span><span class="t">${shiftTimeLabel(cur.st)}</span>
      </div>
      <div class="mob-people">${mobPeopleHtml(list.filter(p => !p.isMS), false)}</div>`;
    // međusmena koja je sada u toku (13–21 ili 21–05)
    Object.entries(MS_LABEL).forEach(([code, label]) => {
      [cur.date, mobIso(mobAddDays(new Date(cur.date + "T00:00:00"), -1))].forEach(date => {
        const msList = ((MOB.byDate[date] && MOB.byDate[date][code]) || []).filter(p => p.isMS);
        if (!msList.length) return;
        const [a, b] = mobShiftSpan(code, true);
        const off = Math.round((new Date(date + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000) * 1440;
        if (nowM >= off + a && nowM < off + b) {
          html += `<div class="mob-sub shift-MS">Međusmena ${label.replace("MS ", "")}</div><div class="mob-people">${mobPeopleHtml(msList, false)}</div>`;
        }
      });
    });
  } else {
    html += '<div class="mob-empty">Trenutno nema smene.</div>';
  }
  html += `</section>`;

  // Mojih narednih 20 dana.
  if (RASPORED_ME_EMP) {
    let days = "";
    for (let i = 0; i < 20; i++) {
      const d = mobAddDays(now, i);
      const iso = mobIso(d);
      const m = mine.find(x => x.date === iso);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      days += `<div class="mob-day${weekend ? " weekend" : ""}${iso === today ? " today" : ""}" data-day="${iso}">
        <span class="dn">${d.getDate()}</span>
        <span class="dm">${DOW_SR[d.getDay()]}<br>${MONTH_NAMES_SR[d.getMonth()].slice(0, 3)}</span>
        ${m
          ? `<span class="sh shift-${m.isMS ? "MS" : m.code}"><span class="shift-tag" style="background:var(--sc);color:#fff;border-radius:6px;padding:2px 8px;font-weight:800;font-size:12px;">${m.isMS ? "MS" : m.code}</span><span><span class="lbl">${m.isMS ? "Međusmena" : (MOB.shiftTypes.find(s => s.code === m.code) || {}).label || ""}</span><br><span class="tm">${mobTimeLabel(m.code, m.isMS)}</span></span></span>`
          : '<span class="off">Slobodan</span>'}
        <span class="chev">›</span>
      </div>`;
    }
    html += `<section class="mob-card"><div class="mob-title">Tvojih narednih 20 dana</div><div class="mob-days">${days}</div></section>`;
  }

  mobRenderWeek(mine, now);

  html += `<button type="button" class="btn btn-ghost mob-full-btn" id="mob-full-btn">${document.body.classList.contains("show-full") ? "Sakrij ceo raspored" : "Prikaži ceo raspored"}</button>`;
  box.innerHTML = html;
}

// Računar: "Tvojih narednih 7 dana" između "Ko radi danas?" i "Raspored po danima".
function mobRenderWeek(mine, now) {
  const box = document.getElementById("my-week");
  if (!RASPORED_ME_EMP) { box.hidden = true; return; }
  const today = mobIso(now);
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = mobAddDays(now, i);
    const iso = mobIso(d);
    const m = mine.find(x => x.date === iso);
    const when = i === 0 ? "Danas" : i === 1 ? "Sutra" : `${DOW_SR[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
    html += m
      ? `<div class="wk-day shift-${m.isMS ? "MS" : m.code}${iso === today ? " today" : ""}" data-week-day="${iso}">
          <div class="d">${when}</div><div class="s">${m.isMS ? "MS" : m.code}</div><div class="t">${mobTimeLabel(m.code, m.isMS)}</div></div>`
      : `<div class="wk-day is-off${iso === today ? " today" : ""}" data-week-day="${iso}">
          <div class="d">${when}</div><div class="s">S</div><div class="t">Slobodan</div></div>`;
  }
  document.getElementById("my-week-grid").innerHTML = html;
  box.hidden = false;
}

// Klik na dan u "7 dana" — skrol do tog dana u tabeli (ako je prikazan).
document.addEventListener("click", (ev) => {
  const day = ev.target.closest && ev.target.closest("[data-week-day]");
  if (!day) return;
  const row = document.querySelector(`.day-row[data-date="${day.dataset.weekDay}"]`);
  if (!row) return;
  row.style.display = "grid"; // i ako je među sakrivenim prethodnim danima
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
});

// Ceo raspored za jedan dan (prozor odozdo).
function mobOpenDay(date) {
  document.querySelector(".day-sheet-overlay")?.remove();
  const day = MOB.byDate[date] || { I: [], II: [], III: [] };
  const d = new Date(date + "T00:00:00");
  const sections = [];
  MOB.shiftTypes.forEach(st => {
    const list = day[st.code] || [];
    sections.push(`<section class="mob-card">
      <div class="mob-now-head shift-${st.code}"><span class="shift-icon">${SHIFT_ICON_SVG[st.code] || ""}</span>
        <span class="n">${st.label}</span><span class="t">${shiftTimeLabel(st)}</span></div>
      <div class="mob-people">${mobPeopleHtml(list.filter(p => !p.isMS), true)}</div>
      ${MS_LABEL[st.code] && list.some(p => p.isMS)
        ? `<div class="mob-sub shift-MS">Međusmena ${MS_LABEL[st.code].replace("MS ", "")}</div><div class="mob-people">${mobPeopleHtml(list.filter(p => p.isMS), true)}</div>`
        : ""}
    </section>`);
  });
  const overlay = document.createElement("div");
  overlay.className = "day-sheet-overlay";
  overlay.innerHTML = `<div class="day-sheet" data-date="${date}">
      <div class="day-sheet-head"><h3>${zmFmtDate(date)}</h3><button type="button" class="day-sheet-close" aria-label="Zatvori">✕</button></div>
      ${RASPORED_ME_EMP ? '<p class="mob-hint">Dodir na sebe: slobodan dan · dodir na radnika iz druge smene: zamena.</p>' : ""}
      ${sections.join("")}
    </div>`;
  document.body.appendChild(overlay);
}

document.addEventListener("click", (ev) => {
  const t = ev.target;
  if (!t.closest) return;
  const day = t.closest("#mobile-home [data-day]");
  if (day) { mobOpenDay(day.dataset.day); return; }
  if (t.closest("#mob-full-btn")) {
    document.body.classList.toggle("show-full");
    t.closest("#mob-full-btn").textContent = document.body.classList.contains("show-full") ? "Sakrij ceo raspored" : "Prikaži ceo raspored";
    return;
  }
  if (t.closest(".day-sheet-close") || t.classList.contains("day-sheet-overlay")) {
    document.querySelector(".day-sheet-overlay")?.remove();
  }
});

function startClock(shiftTypes) {
  const timeEl = document.getElementById("clock-time");
  const dateEl = document.getElementById("clock-date");
  const shiftEl = document.getElementById("clock-shift");

  function tick() {
    const now = belgradeNow();
    timeEl.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const dowFull = ["Nedelja", "Ponedeljak", "Utorak", "Sreda", "Četvrtak", "Petak", "Subota"][now.getDay()];
    dateEl.textContent = `${dowFull}, ${now.getDate()}. ${MONTH_NAMES_SR[now.getMonth()]}`;
    const code = currentShiftCode(shiftTypes, now);
    const label = shiftTypes.find(s => s.code === code);
    shiftEl.textContent = label ? `Sada: ${label.label}` : "Sada: —";
  }
  tick();
  setInterval(tick, 1000 * 15);
}

(async () => {
  const { session, profile } = await mountHeader("raspored");
  if (profile && profile.role !== "admin" && profile.username) RASPORED_ME = profile.username.toLowerCase();
  if (session) {
    const { data: me } = await sb.from("employees").select("id, funkcija").eq("profile_id", session.user.id).maybeSingle();
    if (me && ["radnik", "shift_lider", "monitoring"].includes(me.funkcija)) RASPORED_ME_EMP = me;
    zmLoadInbox(profile);
  }

  const now = belgradeNow();
  const yearSelect = document.getElementById("filter-year");
  const monthSelect = document.getElementById("filter-month");

  for (let y = now.getFullYear() - 1; y <= now.getFullYear() + 1; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    if (y === now.getFullYear()) opt.selected = true;
    yearSelect.appendChild(opt);
  }
  MONTH_NAMES_SR.forEach((name, idx) => {
    const opt = document.createElement("option");
    opt.value = idx + 1;
    opt.textContent = name;
    if (idx === now.getMonth()) opt.selected = true;
    monthSelect.appendChild(opt);
  });

  const shiftTypes = await fetchShiftTypes();
  startClock(shiftTypes);
  MOB.shiftTypes = shiftTypes;
  await mobLoad();
  setInterval(mobRender, 60 * 1000);      // "Sada radi" i "u toku" prate sat
  setInterval(mobLoad, 10 * 60 * 1000);   // povremeno osveži podatke

  document.getElementById("months-container").dataset.showUpcoming = "0";
  await loadAndRenderMonths();

  yearSelect.addEventListener("change", loadAndRenderMonths);
  monthSelect.addEventListener("change", loadAndRenderMonths);
  document.getElementById("filter-search").addEventListener("input", (e) => applySearchFilter(e.target.value));
  document.getElementById("filter-upcoming").addEventListener("click", () => {
    const container = document.getElementById("months-container");
    container.dataset.showUpcoming = container.dataset.showUpcoming === "1" ? "0" : "1";
    loadAndRenderMonths();
  });
})();
