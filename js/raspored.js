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
// Office manager / Accounting: nisu u rasporedu, ali vide svoje radne dane (pon–pet bez praznika).
let RASPORED_ME_OFFICE = null;
// Ceo raspored vide samo Administrator (i "Admin pristup"), Office manager i HR manager.
// Ostali (radnici, lideri, monitoring, Accounting, bez prijave) vide zamagljenu stranu i obaveštenje;
// zaposleni na telefonu vide svoje smene, a dodir na dan otvara listu kolega za zamenu.
let RASPORED_FULL = false;
function canSeeFullSchedule(p) { return !!p && (isAdminProfile(p) || !!p.hr_manager || p.role === "office_manager"); }
const LOCK_TEXT = "Ceo raspored mogu da vide samo Administrator, Office manager i HR manager.";

function renderChip(person, shiftCode) {
  const funkcija = person.funkcija || "radnik";
  const dot = person.isLeader ? DOT_LEADER : person.isMS ? DOT_MS : (DOT_BY_FUNKCIJA[funkcija] || DOT_BY_FUNKCIJA.radnik);
  const name = (person.full_name || person.username || "").toUpperCase();
  const ms = person.isMS && MS_LABEL[shiftCode] ? `<span class="ms-tag">${MS_LABEL[shiftCode]}</span>` : "";
  // shift lider / monitoring / postavljeni lider uvek ostaju na početku smene
  const fixed = !person.isSick && (person.isLeader || funkcija === "shift_lider" || funkcija === "monitoring");
  const isMe = RASPORED_ME && person.username && person.username.toLowerCase() === RASPORED_ME;
  const sick = person.isSick ? ' title="Bolovanje"' : "";
  return `<span class="chip on-white emp-chip${isMe ? " is-me" : ""}${person.isSick ? " is-sick" : ""}${RASPORED_ME_EMP ? " can-swap" : ""}"${sick} data-name="${name.toLowerCase()}" data-emp="${person.employee_id}" data-shift="${person.shift_code}" data-funkcija="${funkcija}"${fixed ? ' data-fixed="1"' : ""}>
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

// sick = bolovanja (sickFetch) — osoba ostaje u smeni, samo je označena kao na bolovanju.
function groupByDateAndShift(rows, sick = []) {
  const map = {};
  for (const row of rows) {
    if (!map[row.date]) map[row.date] = { I: [], II: [], III: [] };
    const emp = row.employees;
    const isSick = !!sickOn(sick, row.employee_id, row.date);
    map[row.date][row.shift_code].push({
      employee_id: row.employee_id,
      shift_code: row.shift_code,
      isLeader: !!row.is_leader && !isSick, // lider na bolovanju — vođstvo je preuzeo drugi (migration_015)
      isMS: !!row.is_medju_smena,
      isSick,
      funkcija: emp ? emp.funkcija : "radnik",
      full_name: emp && emp.profiles ? emp.profiles.full_name : "",
      username: emp && emp.profiles ? emp.profiles.username : "",
    });
  }
  Object.values(map).forEach(day => {
    Object.values(day).forEach(list => list.sort((a, b) => (a.isSick - b.isSick) || (b.isLeader - a.isLeader) || (funkcijaSortValue(a.funkcija) - funkcijaSortValue(b.funkcija))));
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
  const searchVal = (document.getElementById("filter-search")?.value || "").replace(/"/g, "&quot;");
  subheader.innerHTML = `<div class="sub-search-wrap"><input type="text" class="sub-search" placeholder="🔍" title="Pronađi zaposlenog" value="${searchVal}" /></div>` + columns.map(col => col.kind === "shift" ? `
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

  // Prijavljeni zaposleni: on je uvek prvi u svojoj smeni (ispred lidera), a tražena osoba
  // se samo markira drugom bojom i ostaje na svom mestu.
  // Bez prijave i za administratora: tražena osoba ide prva u smeni.
  const workerView = !!RASPORED_ME_EMP;
  document.querySelectorAll(".day-row .shift-cell").forEach(cell => {
    const list = [...cell.querySelectorAll(":scope > .emp-chip")];
    list.sort((a, b) => a.dataset.order - b.dataset.order).forEach(c => cell.appendChild(c));
    const first = workerView
      ? list.find(c => c.classList.contains("is-me"))
      : t && list.find(c => c.dataset.name === t);
    if (first) cell.prepend(first);
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
    const { start, end } = monthRange(m.year, m.month);
    const [rows, sick] = await Promise.all([fetchScheduleForMonth(m.year, m.month), sickFetch(start, end)]);
    const byDate = groupByDateAndShift(rows, sick);
    container.appendChild(buildMonthSectionEl(m.year, m.month, byDate, shiftTypes, now));
  }

  applySearchFilter(document.getElementById("filter-search").value);
}

// Zaključan raspored: vidi se samo ko radi danas, ispod plava površina sa obaveštenjem.
async function renderLockedSchedule(session, shiftTypes) {
  const sub = !session
    ? `<a class="btn lock-btn" href="${APP_BASE}login.html">Prijava</a>`
    : RASPORED_ME_EMP || RASPORED_ME_OFFICE
      ? "<p>Svoje smene vidiš na početnoj strani u aplikaciji na telefonu. Dodirom na dan otvaraš listu kolega sa kojima možeš da se zameniš.</p>"
      : "";
  const container = document.getElementById("months-container");
  container.innerHTML = `<div class="lock-today"></div><div class="lock-wrap">
      <div class="lock-icon">🔒</div>
      <b>Ceo raspored nije dostupan</b>
      <p>${LOCK_TEXT}</p>
      ${sub}
    </div>`;
  // Danas: pravi raspored samo za današnji dan.
  const now = belgradeNow();
  const today = mobIso(now);
  const [{ data }, sick] = await Promise.all([
    sb.from("schedule")
      .select("date, shift_code, is_leader, is_medju_smena, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name, username))")
      .eq("date", today),
    sickFetch(today, today),
  ]);
  const section = buildMonthSectionEl(now.getFullYear(), now.getMonth() + 1, groupByDateAndShift(data || [], sick), shiftTypes, now);
  section.querySelectorAll(".day-row").forEach(r => { if (r.dataset.date !== today) r.remove(); });
  section.querySelector(".prev-days-toggle")?.remove();
  section.querySelector(".month-header span").textContent = "Danas rade";
  container.querySelector(".lock-today").appendChild(section);
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

  // zamena za shift lidera na odmoru je tih nedelja i ovde shift lider
  const myF = effFunkcija(RASPORED_ME_EMP.id, RASPORED_ME_EMP.funkcija, date);
  const theirF = effFunkcija(chip.dataset.emp, chip.dataset.funkcija, date);
  const target = { id: chip.dataset.emp, name: targetName, shift: chip.dataset.shift };
  // Monitoring i shift lideri menjaju za jedan dan ili celu nedelju; radnici samo za jedan dan.
  const weekly = myF === theirF && (myF === "monitoring" || myF === "shift_lider");
  let note = "";
  if (!["radnik", "monitoring", "shift_lider"].includes(myF)) note = "Zamenu mogu da traže radnici, monitoring i shift lideri.";
  else if (theirF !== myF) note = myF === "monitoring" ? "Monitoring menja samo sa monitoringom."
    : myF === "shift_lider" ? "Shift lider menja samo sa shift liderom." : "Zamena je moguća samo sa radnikom.";
  else if (date < today) note = "Dan je prošao.";
  else if (!mine) note = "Tog dana ne radiš.";
  else if (mine.dataset.shift === chip.dataset.shift) note = "Radite istu smenu.";

  const items = [{
    label: weekly ? `Zamena sa ${targetName} — samo ovaj dan` : `Zamena sa ${targetName}`,
    note,
    disabled: !!note,
    run: () => zmOpenSwapDialog(date, { id: RASPORED_ME_EMP.id, shift: mine.dataset.shift }, target),
  }];
  // Monitoring i shift lideri: i zamena za celu nedelju (pon–ned), od danas ako je nedelja već počela.
  if (weekly) {
    const sunday = zmWeekRange(date).to;
    items.push({
      label: `Zamena sa ${targetName} — cela nedelja`,
      note: sunday < today ? "Nedelja je prošla." : zmWeekLabel(date),
      disabled: sunday < today,
      run: () => zmOpenSwapDialog(date, { id: RASPORED_ME_EMP.id, shift: mine ? mine.dataset.shift : "" }, target, true),
    });
  }
  zmOpenMenu(ev.clientX, ev.clientY, `${targetName} · ${zmFmtDate(date)}`, items);
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
  const isHR = !!(ZM_PROFILE && (ZM_PROFILE.hr_manager || isAdminProfile(ZM_PROFILE)));
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
  zmFillStaffInfo(box);
}

zmOnDone = async (msg, isError) => {
  const box = document.getElementById("zm-banner");
  box.innerHTML = `<div class="banner ${isError ? "error" : "success"}">${zmEsc(msg)}</div>`;
  if (!isError) setTimeout(() => { box.innerHTML = ""; }, 6000);
  await zmLoadInbox();
  if (!isError) {
    // posle odobrenja raspored je promenjen
    document.querySelector(".day-sheet-overlay")?.remove();
    await Promise.all([RASPORED_FULL ? loadAndRenderMonths() : null, mobLoad()]);
  }
};

// ---------- Mobilni prikaz (telefon) ----------
// Bez prijave: ko sada radi. Prijavljeni zaposleni: naredne 3 smene, ko sada radi,
// i njegovih narednih 30 dana. Dodir na dan: ceo raspored tog dana (Admin/OM/HR) ili lista za zamenu.
const MOB = { byDate: {}, shiftTypes: [], officeOff: new Set(), vacRound: null };
// Koliko narednih dana zaposleni vidi na telefonu ("Tvojih narednih 30 dana").
const MOB_DAYS = 30;

// Kartica "Termini za odmor aktivni" (sql/migration_025_odmori.sql): od datuma objave dok ne počne
// prvi termin, dok zaposleni ne izabere termin ili ne klikne na karticu (pamti se po terminima).
const MOB_VAC_ROLES = ["radnik", "shift_lider", "monitoring", "accounting", "office_manager"];
function mobVacSeenKey(id) { return `odmori-videno-${id}`; }
async function mobLoadVacCard(me) {
  if (!me || !MOB_VAC_ROLES.includes(me.funkcija)) return;
  const { data: rounds } = await sb.from("vacation_rounds").select("id, publish_date, start_date")
    .eq("active", true).order("created_at", { ascending: false }).limit(1);
  const r = rounds && rounds[0];
  const today = mobIso(belgradeNow());
  if (!r || today < r.publish_date || today >= r.start_date) return;
  try { if (localStorage.getItem(mobVacSeenKey(r.id))) return; } catch (e) { /* bez pamćenja */ }
  const { data: pick } = await sb.from("vacation_picks").select("id").eq("round_id", r.id).eq("employee_id", me.id).maybeSingle();
  if (pick) return;
  MOB.vacRound = r;
  mobRender();
}
// Klik na karticu: više se ne prikazuje, link vodi na stranicu Odmori.
document.addEventListener("click", (ev) => {
  const card = ev.target.closest(".mob-vac-card");
  if (!card) return;
  try { localStorage.setItem(mobVacSeenKey(card.dataset.round), "1"); } catch (e) { /* bez pamćenja */ }
  MOB.vacRound = null;
});

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
// Kancelarijski radni dani (Office manager / Accounting) u obliku "mojih smena".
function mobOfficeDays(now, today) {
  const me = RASPORED_ME_OFFICE, o = me && OFFICE_ROLES[me.funkcija];
  if (!o) return [];
  const out = [];
  for (let i = -1; i <= MOB_DAYS + 1; i++) {
    const date = mobIso(mobAddDays(now, i));
    if (!officeIsWorkday(date) || MOB.officeOff.has(date)) continue;
    const a = o.startHour * 60;
    out.push({ date, code: o.code, office: o, start: i * 1440 + a, end: i * 1440 + a + 480 });
  }
  return out;
}
// Šta piše na slobodan dan: kancelarija razlikuje praznik i odobren slobodan dan.
function mobOffText(iso) {
  if (!RASPORED_ME_OFFICE) return "Slobodan";
  if (MOB.officeOff.has(iso)) return "Slobodan dan";
  const d = new Date(iso + "T00:00:00");
  return d.getDay() >= 1 && d.getDay() <= 5 ? "Praznik" : "Slobodan";
}
function mobBadge(m) { return m.office ? m.office.hours.replace(/:00/g, "") : m.isMS ? "MS" : m.code; }
function mobShiftName(m) { return m.office ? m.office.label : m.isMS ? "Međusmena" : (MOB.shiftTypes.find(s => s.code === m.code) || {}).label || ""; }
function mobMineTime(m) { return m.office ? m.office.hours : mobTimeLabel(m.code, m.isMS); }

function mobTimeLabel(code, isMS) {
  if (isMS && MS_LABEL[code]) return MS_LABEL[code].replace("MS ", "") + " h";
  const st = MOB.shiftTypes.find(s => s.code === code);
  return st ? shiftTimeLabel(st) : "";
}

async function mobLoad() {
  const now = belgradeNow();
  const from = mobIso(mobAddDays(now, -1)), to = mobIso(mobAddDays(now, MOB_DAYS + 1));
  const [{ data }, sick] = await Promise.all([
    sb.from("schedule")
      .select("date, shift_code, is_leader, is_medju_smena, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name, username))")
      .gte("date", from).lte("date", to).order("date"),
    sickFetch(from, to),
  ]);
  MOB.byDate = groupByDateAndShift(data || [], sick);
  mobRender();
}

function mobPeopleHtml(list, withData) {
  if (!list.length) return '<div class="mob-empty">Niko nije u rasporedu.</div>';
  // prijavljeni zaposleni je prvi u svojoj smeni (isto kao u tabeli)
  const meId = RASPORED_ME_EMP && RASPORED_ME_EMP.id;
  list = [...list].sort((a, b) => (a.isSick - b.isSick) || ((b.employee_id === meId) - (a.employee_id === meId)));
  return list.map(p => {
    const dot = p.isLeader ? DOT_LEADER : p.isMS ? DOT_MS : (DOT_BY_FUNKCIJA[p.funkcija] || DOT_BY_FUNKCIJA.radnik);
    const name = (p.full_name || p.username || "").toUpperCase();
    const isMe = RASPORED_ME_EMP && p.employee_id === RASPORED_ME_EMP.id;
    const role = p.isSick ? "Bolovanje" : p.isLeader ? "Lider" : p.funkcija === "shift_lider" ? "Shift lider" : p.funkcija === "monitoring" ? "Monitoring" : "";
    const data = withData
      ? ` data-emp="${p.employee_id}" data-shift="${p.shift_code}" data-funkcija="${p.funkcija}" data-name="${name.toLowerCase()}"`
      : "";
    return `<div class="mob-person${isMe ? " is-me" : ""}${p.isSick ? " is-sick" : ""}"${data}><span class="dot" style="background:${dot}"></span>${name}<span class="role">${role}</span></div>`;
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

  // Moje smene (sa početkom/krajem) — za "naredne 3" i "narednih 30 dana".
  const mine = mobOfficeDays(now, today);
  if (MOB.vacRound) {
    const [y, m, d] = MOB.vacRound.start_date.split("-");
    html += `<a class="mob-card mob-vac-card" href="${APP_BASE}odmori.html" data-round="${MOB.vacRound.id}">
        <span class="mob-vac-icon">🏖️</span>
        <span class="mob-vac-text"><b>Termini za odmor aktivni</b><small>Odmori od ${+d}.${+m}.${y}. — izaberi svoj termin</small></span>
        <span class="mob-vac-go">›</span>
      </a>`;
  }
  if (RASPORED_ME_EMP || RASPORED_ME_OFFICE) {
    if (RASPORED_ME_EMP) Object.entries(MOB.byDate).forEach(([date, day]) => {
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
        return `<div class="mob-next-item is-off" data-day="${iso}"><div class="d">${lbl}</div><div class="s">S</div><div class="t">${mobOffText(iso)}</div></div>`;
      }
      const running = m.start <= nowM && nowM < m.end;
      return `<div class="mob-next-item shift-${m.isMS ? "MS" : m.code}${m.office ? " is-office" : ""}" data-day="${iso}">
          <div class="d">${lbl}</div>
          <div class="s">${mobBadge(m)}</div>
          <div class="t">${m.office ? m.office.label : mobTimeLabel(m.code, m.isMS)}</div>
          ${running ? '<span class="now">U toku</span>' : ""}
        </div>`;
    }).join("")}</div></section>`;
  }

  // Ko sada radi — samo za one koji vide ceo raspored.
  if (RASPORED_FULL) {
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
  }

  // Zaključan raspored: na telefonu se vidi samo ko radi danas (sve tri smene).
  if (!RASPORED_FULL && MOB.shiftTypes.length) {
    const day = MOB.byDate[today] || { I: [], II: [], III: [] };
    html += `<section class="mob-card"><div class="mob-title">Danas rade</div>${MOB.shiftTypes.map(st => {
      const list = day[st.code] || [];
      return `<div class="mob-now-head shift-${st.code}"><span class="shift-icon">${SHIFT_ICON_SVG[st.code] || ""}</span>
          <span class="n">${st.label}</span><span class="t">${shiftTimeLabel(st)}</span></div>
        <div class="mob-people">${mobPeopleHtml(list.filter(p => !p.isMS), false)}</div>
        ${MS_LABEL[st.code] && list.some(p => p.isMS)
          ? `<div class="mob-sub shift-MS">Međusmena ${MS_LABEL[st.code].replace("MS ", "")}</div><div class="mob-people">${mobPeopleHtml(list.filter(p => p.isMS), false)}</div>`
          : ""}`;
    }).join("")}</section>`;
  }

  // Mojih narednih 30 dana.
  if (RASPORED_ME_EMP || RASPORED_ME_OFFICE) {
    let days = "";
    for (let i = 0; i < MOB_DAYS; i++) {
      const d = mobAddDays(now, i);
      const iso = mobIso(d);
      const m = mine.find(x => x.date === iso);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      days += `<div class="mob-day${weekend ? " weekend" : ""}${iso === today ? " today" : ""}" data-day="${iso}">
        <span class="dn">${d.getDate()}</span>
        <span class="dm">${DOW_SR[d.getDay()]}<br>${MONTH_NAMES_SR[d.getMonth()].slice(0, 3)}</span>
        ${m
          ? `<span class="sh shift-${m.isMS ? "MS" : m.code}"><span class="shift-tag mob-day-badge${m.office ? " is-office" : ""}">${mobBadge(m)}</span><span><span class="lbl">${mobShiftName(m)}</span><br><span class="tm">${mobMineTime(m)}</span></span></span>`
          : `<span class="off">${mobOffText(iso)}</span>`}
        <span class="chev">›</span>
      </div>`;
    }
    html += `<section class="mob-card"><div class="mob-title">Tvojih narednih ${MOB_DAYS} dana</div><div class="mob-days">${days}</div></section>`;
  }

  mobRenderWeek(mine, now);

  if (RASPORED_FULL) html += `<button type="button" class="btn btn-ghost mob-full-btn" id="mob-full-btn">${document.body.classList.contains("show-full") ? "Sakrij ceo raspored" : "Prikaži ceo raspored"}</button>`;
  box.innerHTML = html;
}

// Računar: "Tvojih narednih 7 dana" između "Ko radi danas?" i "Raspored po danima".
function mobRenderWeek(mine, now) {
  const box = document.getElementById("my-week");
  if (!RASPORED_ME_EMP && !RASPORED_ME_OFFICE) { box.hidden = true; return; }
  const today = mobIso(now);
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = mobAddDays(now, i);
    const iso = mobIso(d);
    const m = mine.find(x => x.date === iso);
    const when = i === 0 ? "Danas" : i === 1 ? "Sutra" : `${DOW_SR[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
    html += m
      ? `<div class="wk-day shift-${m.isMS ? "MS" : m.code}${m.office ? " is-office" : ""}${iso === today ? " today" : ""}" data-week-day="${iso}">
          <div class="d">${when}</div><div class="s">${mobBadge(m)}</div><div class="t">${m.office ? m.office.label : mobTimeLabel(m.code, m.isMS)}</div></div>`
      : `<div class="wk-day is-off${iso === today ? " today" : ""}" data-week-day="${iso}">
          <div class="d">${when}</div><div class="s">S</div><div class="t">${mobOffText(iso)}</div></div>`;
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

// Kolege sa kojima zaposleni može da se zameni tog dana (prozor odozdo, bez celog rasporeda).
//  - Radnik: samo radnici iz drugih smena. Iz III se vide samo oni kojima je ta III jedina
//    ili prva od dve zaredom (ko je prethodni dan radio III — tog dana mu je druga III — ne vidi se).
//  - Monitoring / shift lider: kao do sada — samo iste funkcije, za jedan dan ili celu nedelju.
// Dodir na sebe i dalje otvara "Slobodan dan".
function mobSwapCandidates(date, me, mine) {
  const day = MOB.byDate[date] || { I: [], II: [], III: [] };
  const prevDay = MOB.byDate[mobIso(mobAddDays(new Date(date + "T00:00:00"), -1))] || { III: [] };
  const myF = effFunkcija(me.id, me.funkcija, date);
  const out = {};
  MOB.shiftTypes.forEach(st => {
    if (mine && st.code === mine.shift_code) return;
    out[st.code] = (day[st.code] || []).filter(p => {
      if (p.employee_id === me.id || p.isSick) return false;
      if (effFunkcija(p.employee_id, p.funkcija, date) !== myF) return false;
      if (myF === "radnik" && st.code === "III" && (prevDay.III || []).some(x => x.employee_id === p.employee_id)) return false;
      return true;
    });
  });
  return out;
}

// ---------- Ograničenje: lista za zamenu najviše 2 puta u 24h (sql/migration_048_zamene_ulasci.sql) ----------
function swapFmtWhen(iso) {
  const p = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).forEach(x => { p[x.type] = x.value; });
  return `${+p.day}.${+p.month}.${p.year}. u ${p.hour}:${p.minute}`;
}
function swapGateDialog(title, html, okLabel, onOk) {
  document.getElementById("zm-dialog")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "zm-dialog";
  overlay.className = "pw-overlay";
  overlay.innerHTML = `<div class="pw-box swap-gate">
      <h3>${title}</h3>
      ${html}
      <div class="pw-actions">
        <button type="button" class="btn btn-ghost pw-cancel">${onOk ? "Odustani" : "U redu"}</button>
        ${onOk ? `<button type="button" class="btn btn-primary pw-save">${okLabel}</button>` : ""}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".pw-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  if (onOk) overlay.querySelector(".pw-save").addEventListener("click", async (e) => {
    e.target.disabled = true;
    await onOk();
    close();
  });
}
function swapBlocked(availableAt) {
  swapGateDialog("Lista za zamenu nije dostupna",
    `<p class="swap-gate-text">Iskoristio/la si oba ulaska u toku 24 sata. Možeš ponovo da pogledaš za 24h.</p>
     <p class="swap-gate-when">Opcija je dostupna od<br><b>${swapFmtWhen(availableAt)}</b></p>`);
}
// Upisuje ulazak u bazi i otvara listu (ili poruku ako su ulasci potrošeni).
async function swapOpenCounted(date) {
  const { data, error } = await sb.rpc("swap_view_open");
  if (error) { console.error(error); mobOpenSwapDay(date); return; } // SQL 048 još nije pokrenut
  if (!data.ok) { swapBlocked(data.available_at); return; }
  mobOpenSwapDay(date, data.limited
    ? (data.used >= 2 ? "Ovo ti je 2. (poslednji) ulazak u 24h." : "Ovo ti je 1. od 2 ulaska u 24h.")
    : "");
}
async function mobSwapGate(date) {
  const me = RASPORED_ME_EMP;
  if (!me) { mobOpenSwapDay(date); return; }
  // Radnik koji tog dana ne radi dobija samo poruku — to se ne računa kao ulazak.
  const day = MOB.byDate[date] || {};
  const works = ["I", "II", "III"].some(c => (day[c] || []).some(p => p.employee_id === me.id));
  if (!works && effFunkcija(me.id, me.funkcija, date) === "radnik") { mobOpenSwapDay(date); return; }
  const { data: st, error } = await sb.rpc("swap_view_status");
  if (error || !st || !st.limited) { if (error) console.error(error); mobOpenSwapDay(date); return; }
  if (st.used >= 2) { swapBlocked(st.available_at); return; }
  if (st.used === 0) {
    swapGateDialog("Kolege dostupne za zamenu",
      `<p class="swap-gate-text">U toku 24 sata možeš <b>2 puta</b> da uđeš i pogledaš ko je dostupan za zamenu (za bilo koji dan).</p>
       <p class="swap-gate-text">Ako uđeš i treći put, lista neće biti dostupna dok ne prođe 24h od prvog ulaska.</p>`,
      "Pogledaj (1/2)", () => swapOpenCounted(date));
    return;
  }
  await swapOpenCounted(date);
}

function mobOpenSwapDay(date, note) {
  document.querySelector(".day-sheet-overlay")?.remove();
  const me = RASPORED_ME_EMP;
  let body = note ? `<div class="swap-gate-note">${note}</div>` : "";
  if (!me) {
    // Office manager / Accounting nisu u rasporedu smena.
    body = `<section class="mob-card"><div class="mob-empty">${LOCK_TEXT} Slobodan dan tražiš na stranici <a href="${APP_BASE}zamene.html">Zamene</a>.</div></section>`;
  } else {
    const day = MOB.byDate[date] || { I: [], II: [], III: [] };
    const mine = ["I", "II", "III"].map(c => (day[c] || []).find(p => p.employee_id === me.id)).find(Boolean) || null;
    const myF = effFunkcija(me.id, me.funkcija, date);
    const st = mine && MOB.shiftTypes.find(s => s.code === mine.shift_code);
    body += `<section class="mob-card"><div class="mob-title">Tvoja smena</div>
      ${mine
        ? `<div class="mob-now-head shift-${mine.isMS ? "MS" : mine.shift_code}"><span class="shift-icon">${SHIFT_ICON_SVG[mine.shift_code] || ""}</span>
            <span class="n">${mine.isMS ? "Međusmena" : st ? st.label : mine.shift_code}</span><span class="t">${mobTimeLabel(mine.shift_code, mine.isMS)}</span></div>
           <div class="mob-people">${mobPeopleHtml([mine], true)}</div>`
        : '<div class="mob-empty">Tog dana ne radiš.</div>'}
    </section>`;
    // Radnik koji tog dana ne radi nema sa kim da se menja; monitoring i lideri i dalje mogu celu nedelju.
    if (mine || myF !== "radnik") {
      const cand = mobSwapCandidates(date, me, mine);
      body += `<p class="mob-hint">${mine ? "Dodir na sebe: slobodan dan · dodir na kolegu: zahtev za zamenu." : "Dodir na kolegu: zamena za celu nedelju."}</p>`;
      MOB.shiftTypes.forEach(s => {
        if (!cand[s.code]) return;
        body += `<section class="mob-card">
          <div class="mob-now-head shift-${s.code}"><span class="shift-icon">${SHIFT_ICON_SVG[s.code] || ""}</span>
            <span class="n">${s.label}</span><span class="t">${shiftTimeLabel(s)}</span></div>
          <div class="mob-people">${cand[s.code].length ? mobPeopleHtml(cand[s.code], true) : '<div class="mob-empty">Nema nikoga za zamenu.</div>'}</div>
        </section>`;
      });
    }
  }
  const overlay = document.createElement("div");
  overlay.className = "day-sheet-overlay";
  overlay.innerHTML = `<div class="day-sheet" data-date="${date}">
      <div class="day-sheet-head"><h3>${zmFmtDate(date)}</h3><button type="button" class="day-sheet-close" aria-label="Zatvori">✕</button></div>
      ${body}
    </div>`;
  document.body.appendChild(overlay);
}

// Ceo raspored za jedan dan (prozor odozdo) — Admin, Office manager, HR manager.
function mobOpenDay(date) {
  if (!RASPORED_FULL) { mobSwapGate(date); return; }
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
  RASPORED_FULL = canSeeFullSchedule(profile);
  document.body.classList.toggle("schedule-locked", !RASPORED_FULL);
  if (!RASPORED_FULL) {
    const hero = document.querySelector(".hero-card p");
    if (hero) hero.textContent = session ? "Tvoje smene su na početnoj strani u aplikaciji na telefonu." : "Prijavite se da vidite svoje smene.";
  }
  if (profile && !isAdminProfile(profile) && profile.username) RASPORED_ME = profile.username.toLowerCase();
  if (session) {
    const { data: me } = await sb.from("employees").select("id, funkcija").eq("profile_id", session.user.id).maybeSingle();
    if (me && ["radnik", "shift_lider", "monitoring"].includes(me.funkcija)) {
      RASPORED_ME_EMP = me;
      const n = belgradeNow();
      leadWeeksLoad(mobIso(mobAddDays(n, -7)), mobIso(mobAddDays(n, 100)));
    }
    else if (me && OFFICE_ROLES[me.funkcija]) {
      RASPORED_ME_OFFICE = me;
      const { data: off } = await sb.from("swap_requests").select("date")
        .eq("requester_id", me.id).eq("kind", "day_off").eq("status", "approved");
      MOB.officeOff = new Set((off || []).map(r => r.date));
    }
    zmLoadInbox(profile);
    mobLoadVacCard(me);
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

  if (!RASPORED_FULL) { renderLockedSchedule(session, shiftTypes); return; }

  document.getElementById("months-container").dataset.showUpcoming = "0";
  await loadAndRenderMonths();

  yearSelect.addEventListener("change", loadAndRenderMonths);
  monthSelect.addEventListener("change", loadAndRenderMonths);
  // Glavna pretraga i pretraga u fiksiranom zaglavlju su uvek iste
  const syncSearch = (val, src) => {
    const main = document.getElementById("filter-search");
    if (main !== src) main.value = val;
    document.querySelectorAll(".sub-search").forEach(el => { if (el !== src) el.value = val; });
    applySearchFilter(val);
  };
  document.getElementById("filter-search").addEventListener("input", (e) => syncSearch(e.target.value, e.target));
  document.getElementById("months-container").addEventListener("input", (e) => {
    if (e.target.classList.contains("sub-search")) syncSearch(e.target.value, e.target);
  });
  document.getElementById("filter-upcoming").addEventListener("click", () => {
    const container = document.getElementById("months-container");
    container.dataset.showUpcoming = container.dataset.showUpcoming === "1" ? "0" : "1";
    loadAndRenderMonths();
  });
})();
