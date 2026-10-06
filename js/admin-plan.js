const PLAN_BASE_COLS = ["40px", "minmax(190px,1.6fr)", "minmax(90px,0.7fr)", "minmax(150px,1.1fr)", "minmax(140px,1fr)", "64px", "minmax(90px,0.7fr)"];
const PLAN_WEEK_COL = "minmax(150px,1fr)";

const FUNKCIJA_FOR_WEEK_LABELS = {
  shift_lider: "Shift lider",
  monitoring: "Monitoring",
  radnik: "Radnik",
  slobodan: "Slobodan",
  ne_radi: "Ne radi",
};

const GROUP_DEFS = [
  { key: "shift_lider", title: "Shift lideri" },
  { key: "monitoring", title: "Monitoring" },
  { key: "radnik", title: "Radnici" },
];

function planGridTemplate(weekCount) {
  return [...PLAN_BASE_COLS, ...Array(weekCount).fill(PLAN_WEEK_COL)].join(" ");
}

function computeWeeksOfMonth(year, month) {
  const last = new Date(year, month, 0);
  const weeks = [];
  let cursor = new Date(year, month - 1, 1);
  let num = 1;
  while (cursor <= last) {
    const weekEnd = new Date(cursor);
    while (weekEnd.getDay() !== 0 && weekEnd < last) {
      weekEnd.setDate(weekEnd.getDate() + 1);
    }
    weeks.push({
      number: num,
      start: toISODate(cursor),
      end: toISODate(weekEnd),
    });
    cursor = new Date(weekEnd);
    cursor.setDate(cursor.getDate() + 1);
    num++;
  }
  return weeks;
}

function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDM(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}`;
}

function monthFond(year, month) {
  const days = new Date(year, month, 0).getDate();
  if (days === 31) return 21;
  if (days === 30) return 20;
  return 19;
}

function planShowBanner(message, type) {
  const box = document.getElementById("plan-banner");
  box.innerHTML = `<div class="banner ${type}">${message}</div>`;
  if (type === "success") setTimeout(() => { box.innerHTML = ""; }, 6000);
}

async function fetchPlanEmployees() {
  const { data, error } = await sb
    .from("employees")
    .select("id, funkcija, monitoring_smena, ne_zajedno, active, slava_date, profiles(full_name, username)")
    .eq("active", true)
    .in("funkcija", ["shift_lider", "monitoring", "radnik"])
    .order("created_at");
  if (error) {
    console.error(error);
    return [];
  }
  return data;
}

async function fetchDaysOffMap(employeeIds, year, month) {
  if (!employeeIds.length) return {};
  const last = new Date(year, month, 0).getDate();
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  const { data } = await sb
    .from("days_off")
    .select("*")
    .in("employee_id", employeeIds)
    .gte("off_date", start)
    .lte("off_date", end);
  const map = {};
  (data || []).forEach(row => { map[row.employee_id] = row; });
  return map;
}

async function fetchWeeklyPlansMap(employeeIds, year, month) {
  if (!employeeIds.length) return {};
  const { data } = await sb
    .from("weekly_plans")
    .select("*")
    .in("employee_id", employeeIds)
    .eq("year", year)
    .eq("month", month);
  const map = {};
  (data || []).forEach(row => {
    if (!map[row.employee_id]) map[row.employee_id] = {};
    map[row.employee_id][row.week_number] = row;
  });
  return map;
}

async function fetchVacationsMap(employeeIds) {
  if (!employeeIds.length) return {};
  const { data } = await sb.from("vacations").select("*").in("employee_id", employeeIds);
  const map = {};
  (data || []).forEach(v => {
    if (!map[v.employee_id]) map[v.employee_id] = [];
    map[v.employee_id].push(v);
  });
  return map;
}

function weekOverlapsVacation(week, vacationList) {
  if (!vacationList) return false;
  return vacationList.some(v => v.start_date <= week.end && v.end_date >= week.start);
}

// Pronalazi, za svaku (zaposleni, nedelja) kombinaciju gde je neko NA ODMORU,
// ko ga te nedelje menja — iz weekly_plans.replacing_employee_id na REDU ZAMENIKA.
function buildReplacementIndex(allWeeklyPlansMap, employeesById) {
  const byVacationer = {}; // vacationerId -> { weekNumber: {replacerId, replacerName, rowId} }
  Object.entries(allWeeklyPlansMap).forEach(([replacerId, weeksObj]) => {
    Object.values(weeksObj).forEach(row => {
      if (!row.replacing_employee_id) return;
      if (!byVacationer[row.replacing_employee_id]) byVacationer[row.replacing_employee_id] = {};
      byVacationer[row.replacing_employee_id][row.week_number] = {
        replacerId,
        replacerName: (employeesById[replacerId]?.profiles?.full_name || "").toUpperCase(),
        rowId: row.id,
      };
    });
  });
  return byVacationer;
}

// Osobe čekirane kao zamena (checkbox ispred imena), po mesecu "godina-mesec".
// Čuvaju se u tabeli settings pod ključem "zamene_GGGG_M" (niz employee id-jeva);
// generator ih ne računa u osnovni krug. Osobe koje već nekog menjaju su uvek čekirane.
const planReplacerChecks = {};
let planCtx = null;

function planCheckKey(ctx) {
  return `${ctx.year}-${ctx.month}`;
}

function zameneSettingsKey(year, month) {
  return `zamene_${year}_${month}`;
}

async function fetchZameneIds(year, month) {
  const { data } = await sb.from("settings").select("value").eq("key", zameneSettingsKey(year, month)).maybeSingle();
  return Array.isArray(data && data.value) ? data.value : [];
}

// Vikend lideri važe stalno (ne po mesecu) — settings "vikend_lideri".
let planVikendLideri = new Set();

async function fetchVikendLideri() {
  const { data } = await sb.from("settings").select("value").eq("key", "vikend_lideri").maybeSingle();
  return new Set(Array.isArray(data && data.value) ? data.value : []);
}

async function saveVikendLideri() {
  const { error } = await sb.from("settings").upsert(
    { key: "vikend_lideri", value: [...planVikendLideri], updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) planShowBanner("Vikend lider nije sačuvan: " + error.message, "error");
}

async function saveZameneIds(year, month, ids) {
  const { error } = await sb.from("settings").upsert(
    { key: zameneSettingsKey(year, month), value: ids, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) planShowBanner("Zamena nije sačuvana: " + error.message, "error");
}

// Ko je već zamena u toj nedelji (za bilo koga) — ne nudi se ponovo.
function replacersInWeek(weekNumber, ctx) {
  const taken = new Set();
  Object.values(ctx.replacementIndexByVacationer).forEach(weeksObj => {
    const r = weeksObj[weekNumber];
    if (r) taken.add(r.replacerId);
  });
  return taken;
}

// Ko sve može da menja osobu na odmoru te nedelje: čekirani kao zamena, nisu već zauzeti, nisu i sami na odmoru.
function replacementCandidates(vacationerId, week, ctx) {
  const checked = planReplacerChecks[planCheckKey(ctx)] || new Set();
  const taken = replacersInWeek(Number(week.number), ctx);
  return ctx.allEmployees.filter(c =>
    c.id !== vacationerId && checked.has(c.id) && !taken.has(c.id) &&
    !weekOverlapsVacation(week, ctx.vacationsMap[c.id])
  );
}

// Posle dodele/uklanjanja zamene: ponovo nacrtaj samo te redove (bez osvežavanja cele tabele,
// da ostale nesačuvane izmene i pozicija na stranici ostanu).
function planRerenderRows(employeeIds) {
  const ctx = planCtx;
  if (!ctx) return;
  ctx.replacementIndexByVacationer = buildReplacementIndex(ctx.weeklyPlansMap, ctx.employeesById);
  const scrollY = window.scrollY;
  [...new Set(employeeIds)].forEach(id => {
    const emp = ctx.employeesById[id];
    const oldRow = document.querySelector(`#plan-table-wrap .plan-row[data-employee-id="${id}"]`);
    if (!emp || !oldRow) return;
    oldRow.replaceWith(buildPlanRow(emp, ctx.weeks, ctx.dayOffMap[id], ctx.weeklyPlansMap[id], ctx.fond, ctx.gridTemplate, ctx));
  });
  window.scrollTo(0, scrollY);
}

// Svaki par "osoba na odmoru ↔ zamena" dobija svoju boju (ista boja u oba reda).
const PAIR_COLORS = [
  { bg: "#e7efff", fg: "#1d4ed8" },
  { bg: "#fdeedd", fg: "#b45309" },
  { bg: "#e3f5e9", fg: "#15803d" },
  { bg: "#f3e8fd", fg: "#7e22ce" },
  { bg: "#fde7f1", fg: "#be185d" },
  { bg: "#dff4f3", fg: "#0f766e" },
  { bg: "#fbf3d5", fg: "#a16207" },
];

function pairStyle(vacationerId, ctx) {
  const i = Math.max(0, ctx.vacationerOrder.indexOf(vacationerId));
  const c = PAIR_COLORS[i % PAIR_COLORS.length];
  return `--pc-bg:${c.bg};--pc-fg:${c.fg};`;
}

function shortName(emp) {
  return (emp?.profiles?.full_name || "").toUpperCase();
}

function buildPlanRow(emp, weeks, dayOff, weeklyPlan, fond, gridTemplate, ctx) {
  const row = document.createElement("div");
  row.className = "plan-row";
  row.style.gridTemplateColumns = gridTemplate;
  row.dataset.employeeId = emp.id;
  if (dayOff) row.dataset.dayOffId = dayOff.id;

  const name = (emp.profiles?.full_name || "").toUpperCase();
  const username = emp.profiles?.username || "";
  const isMonitoring = emp.funkcija === "monitoring";
  // Slava (dan i mesec iz "Osobe u sistemu") — ako pada u ovaj mesec, predlaže se kao obavezno slobodan.
  const slavaThisMonth = emp.slava_date && Number(emp.slava_date.slice(5, 7)) === ctx.month
    ? `${ctx.year}-${emp.slava_date.slice(5)}`
    : null;

  const mm = String(ctx.month).padStart(2, "0");
  const monthMin = `${ctx.year}-${mm}-01`;
  const monthMax = `${ctx.year}-${mm}-${String(new Date(ctx.year, ctx.month, 0).getDate()).padStart(2, "0")}`;

  let html = `
    <div style="text-align:center;">
      <input type="checkbox" class="p-replacer" ${(planReplacerChecks[planCheckKey(ctx)] || new Set()).has(emp.id) ? "checked" : ""} title="Čekiraj kao zamenu za osobe na odmoru" />
    </div>
    <div>
      <div class="emp-name">${name}
        ${(planReplacerChecks[planCheckKey(ctx)] || new Set()).has(emp.id) ? '<span class="plan-tag plan-tag-zamena">Zamena</span>' : ""}
        ${ctx.vacationerOrder.includes(emp.id) ? '<span class="plan-tag plan-tag-odmor">Odmor</span>' : ""}
      </div>
      <div class="emp-username">${username}</div>
    </div>
    <div class="plan-ne-zajedno">
      ${emp.funkcija === "radnik" ? `<input type="checkbox" class="p-vikend-lider" ${planVikendLideri.has(emp.id) ? "checked" : ""} title="Generator ga postavlja za lidera smene vikendom i praznikom" /> Da` : ""}
    </div>
    <div>
      ${isMonitoring
        ? `<select class="p-monitoring">
            ${["I", "II", "III"].map(c => `<option value="${c}" ${emp.monitoring_smena === c ? "selected" : ""}>Monitoring ${c}</option>`).join("")}
          </select>`
        : FUNKCIJA_FOR_WEEK_LABELS[emp.funkcija] || emp.funkcija}
    </div>
    <div class="field-odmor">
      <input type="date" class="p-dayoff" min="${monthMin}" max="${monthMax}" value="${dayOff ? dayOff.off_date : (slavaThisMonth || "")}" />
      ${!dayOff && slavaThisMonth ? '<div class="plan-slava-note">Slava</div>' : ""}
    </div>
    <div class="plan-fond">${fond}</div>
    <div class="plan-ne-zajedno">
      ${emp.funkcija === "radnik" ? `<input type="checkbox" class="p-ne-zajedno" ${emp.ne_zajedno ? "checked" : ""} /> Da` : ""}
    </div>
  `;

  weeks.forEach(w => {
    const existingRow = weeklyPlan && weeklyPlan[w.number];
    const onVacation = weekOverlapsVacation(w, ctx.vacationsMap[emp.id]);
    const replacementForMe = ctx.replacementIndexByVacationer[emp.id] && ctx.replacementIndexByVacationer[emp.id][w.number];
    const iAmReplacing = existingRow && existingRow.replacing_employee_id
      ? (ctx.employeesById[existingRow.replacing_employee_id]?.profiles?.full_name || "").toUpperCase()
      : null;
    const replacingId = existingRow ? (existingRow.replacing_employee_id || "") : "";

    let cellHtml = "";

    if (onVacation) {
      // skriveni select ostaje zbog čuvanja (preskače se jer je disabled)
      cellHtml += `<select class="p-week" data-week="${w.number}" data-start="${w.start}" data-end="${w.end}" data-replacing="${replacingId}" disabled hidden><option value="ne_radi" selected>Ne radi</option></select>`;
      cellHtml += `<div class="vac-badge">Odmor</div>`;
      if (replacementForMe) {
        cellHtml += `<div class="pair-pill" style="${pairStyle(emp.id, ctx)}" title="${replacementForMe.replacerName} menja ${name} ove nedelje">
          <span class="pair-arrow">⇄</span><span class="pair-name">${replacementForMe.replacerName}</span>
          <button type="button" class="plan-repl-clear" data-row-id="${replacementForMe.rowId}" title="Ukloni zamenu">×</button>
        </div>`;
      }
      // Bez zamene piše samo "Odmor"; zamena se bira desnim klikom.
      // Monitoring nema zamenu — samo "Odmor".
      const canPick = !replacementForMe && !isMonitoring;
      html += `<div class="vac-cell${canPick ? " vac-no-repl" : ""}${!replacementForMe ? " vac-alone" : ""}" data-week="${w.number}" data-start="${w.start}" data-end="${w.end}"${canPick ? ' title="Desni klik za izbor zamene"' : ""}>${cellHtml}</div>`;
      return;
    } else {
      const value = existingRow ? existingRow.funkcija_for_week : emp.funkcija;
      cellHtml += `<select class="p-week" data-week="${w.number}" data-start="${w.start}" data-end="${w.end}" data-replacing="${replacingId}" hidden>
        ${Object.entries(FUNKCIJA_FOR_WEEK_LABELS).map(([val, label]) =>
          `<option value="${val}" ${val === value ? "selected" : ""}>${label}</option>`
        ).join("")}
      </select>`;
      // Kad osoba menja nekog, oznaka sadrži samo "menja X" — red ostaje iste visine.
      const pairHtml = iAmReplacing
        ? `<div class="pair-pill" style="${pairStyle(existingRow.replacing_employee_id, ctx)}" title="${name} menja ${iAmReplacing} ove nedelje">
          <span class="pair-label">menja</span><span class="pair-name">${iAmReplacing}</span>
          <button type="button" class="plan-repl-clear" data-row-id="${existingRow.id}" title="Ukloni zamenu">×</button>
        </div>`
        : "";
      cellHtml += `<div class="plan-week-label${iAmReplacing ? " has-pair" : ""}" data-value="${value}" data-week="${w.number}" title="Desni klik za izmenu"><span class="plan-week-text">${FUNKCIJA_FOR_WEEK_LABELS[value] || value}</span>${pairHtml}</div>`;
    }

    html += `<div>${cellHtml}</div>`;
  });

  row.innerHTML = html;
  syncAllDateInputs(row);

  row.querySelectorAll(".plan-week-label").forEach(label => {
    const select = label.previousElementSibling;
    label.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const current = select.value;
      const items = Object.entries(FUNKCIJA_FOR_WEEK_LABELS).map(([val, lbl]) => ({
        label: lbl,
        dot: DOT_BY_FUNKCIJA[val] || "var(--border)",
        disabled: val === current,
        note: val === current ? "trenutno" : "",
        run: () => {
          select.value = val;
          label.dataset.value = val;
          label.querySelector(".plan-week-text").textContent = lbl;
        },
      }));
      rdmOpenContextMenu(ev.clientX, ev.clientY, `${name} · Nedelja ${label.dataset.week}`, items, () => {});
    });
  });

  const vlBox = row.querySelector(".p-vikend-lider");
  if (vlBox) vlBox.addEventListener("change", () => {
    if (vlBox.checked) planVikendLideri.add(emp.id);
    else planVikendLideri.delete(emp.id);
    saveVikendLideri();
  });

  row.querySelector(".p-replacer").addEventListener("change", async (e) => {
    const key = planCheckKey(ctx);
    if (!planReplacerChecks[key]) planReplacerChecks[key] = new Set();
    if (e.target.checked) planReplacerChecks[key].add(emp.id);
    else planReplacerChecks[key].delete(emp.id);
    await saveZameneIds(ctx.year, ctx.month, [...planReplacerChecks[key]]);

    // Otčekirano — ukloni i sve dodeljene zamene te osobe u ovom mesecu,
    // inače bi je stranica pri sledećem učitavanju ponovo čekirala.
    if (!e.target.checked) {
      const { error } = await sb
        .from("weekly_plans")
        .update({ replacing_employee_id: null })
        .eq("employee_id", emp.id)
        .eq("year", ctx.year)
        .eq("month", ctx.month)
        .not("replacing_employee_id", "is", null);
      if (error) {
        planShowBanner("Greška pri uklanjanju zamene: " + error.message, "error");
        return;
      }
      await loadPlan();
    }
  });

  row.querySelectorAll(".vac-no-repl").forEach(cell => {
    cell.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const week = { number: cell.dataset.week, start: cell.dataset.start, end: cell.dataset.end };
      const items = replacementCandidates(emp.id, week, ctx).map(c => ({
        label: shortName(c),
        dot: "var(--dot-radnik)",
        run: () => assignReplacement(c.id, week),
      }));
      const title = items.length
        ? `Zamena za ${name} · Nedelja ${week.number}`
        : `Zamena za ${name} — prvo čekiraj zamenu ispred imena`;
      rdmOpenContextMenu(ev.clientX, ev.clientY, title, items, () => {});
    });
  });

  async function assignReplacement(replacerId, week) {
    const { data: saved, error } = await sb.from("weekly_plans").upsert(
      {
        employee_id: replacerId,
        year: ctx.year,
        month: ctx.month,
        week_number: parseInt(week.number, 10),
        week_start: week.start,
        week_end: week.end,
        funkcija_for_week: emp.funkcija,
        replacing_employee_id: emp.id,
      },
      { onConflict: "employee_id,year,month,week_number" }
    ).select().single();
    if (error) {
      planShowBanner("Greška pri dodeli zamene: " + error.message, "error");
      return;
    }
    if (!ctx.weeklyPlansMap[replacerId]) ctx.weeklyPlansMap[replacerId] = {};
    ctx.weeklyPlansMap[replacerId][saved.week_number] = saved;
    planRerenderRows([emp.id, replacerId]);
  }

  row.querySelectorAll(".plan-repl-clear").forEach(btn => {
    btn.addEventListener("click", async () => {
      const { error } = await sb.from("weekly_plans").update({ replacing_employee_id: null }).eq("id", btn.dataset.rowId);
      if (error) {
        planShowBanner("Greška: " + error.message, "error");
        return;
      }
      // nađi red u lokalnim podacima i osveži samo zamenu i osobu na odmoru
      const touched = [];
      Object.entries(ctx.weeklyPlansMap).forEach(([empId, weeksObj]) => {
        Object.values(weeksObj).forEach(wp => {
          if (wp.id === btn.dataset.rowId) {
            touched.push(empId, wp.replacing_employee_id);
            wp.replacing_employee_id = null;
          }
        });
      });
      planRerenderRows(touched.filter(Boolean));
    });
  });

  return row;
}

async function loadPlan() {
  const year = parseInt(document.getElementById("plan-year").value, 10);
  const month = parseInt(document.getElementById("plan-month").value, 10);
  const wrap = document.getElementById("plan-table-wrap");
  wrap.innerHTML = '<div class="empty-note muted">Učitavanje...</div>';

  const weeks = computeWeeksOfMonth(year, month);
  const gridTemplate = planGridTemplate(weeks.length);
  const fond = monthFond(year, month);

  const employees = await fetchPlanEmployees();
  const ids = employees.map(e => e.id);
  const [dayOffMap, weeklyPlansMap, vacationsMap, zameneIds, vikendLideri] = await Promise.all([
    fetchDaysOffMap(ids, year, month),
    fetchWeeklyPlansMap(ids, year, month),
    fetchVacationsMap(ids),
    fetchZameneIds(year, month),
    fetchVikendLideri(),
  ]);
  planVikendLideri = vikendLideri;

  const employeesById = {};
  employees.forEach(e => { employeesById[e.id] = e; });
  const replacementIndexByVacationer = buildReplacementIndex(weeklyPlansMap, employeesById);

  const ctx = {
    allEmployees: employees, employeesById, vacationsMap, replacementIndexByVacationer, year, month,
    weeks, dayOffMap, weeklyPlansMap, fond, gridTemplate,
    // ko je na odmoru u ovom mesecu (redosled određuje boju para)
    vacationerOrder: employees
      .filter(e => weeks.some(w => weekOverlapsVacation(w, vacationsMap[e.id])))
      .sort((a, b) => shortName(a).localeCompare(shortName(b)))
      .map(e => e.id),
  };
  planCtx = ctx;

  // Sačuvana čekiranja + ko već nekog menja ovog meseca (automatski čekiran).
  const checkKey = planCheckKey(ctx);
  planReplacerChecks[checkKey] = new Set(zameneIds);
  let addedAssigned = false;
  Object.values(replacementIndexByVacationer).forEach(weeksObj =>
    Object.values(weeksObj).forEach(r => {
      if (!planReplacerChecks[checkKey].has(r.replacerId)) {
        planReplacerChecks[checkKey].add(r.replacerId);
        addedAssigned = true;
      }
    })
  );
  if (addedAssigned) saveZameneIds(year, month, [...planReplacerChecks[checkKey]]);

  document.getElementById("plan-subtitle").textContent =
    `${MONTH_NAMES_SR[month - 1]} ${year} · svaka kolona prikazuje samo datume tog meseca.`;

  wrap.innerHTML = "";

  const head = document.createElement("div");
  head.className = "plan-head-row";
  head.style.gridTemplateColumns = gridTemplate;
  head.innerHTML = `
    <div></div><div>Zaposleni</div><div>Vikend lider</div><div>Osnovna rola</div>
    <div>Obavezno slobodan</div><div>Fond</div><div>Ne zajedno</div>
    ${weeks.map(w => `<div>Nedelja ${w.number}<br/><span style="font-weight:500;">${fmtDM(w.start)}–${fmtDM(w.end)}</span></div>`).join("")}
  `;
  wrap.appendChild(head);

  GROUP_DEFS.forEach(group => {
    const members = employees.filter(e => e.funkcija === group.key);
    if (!members.length) return;
    const groupHeader = document.createElement("div");
    groupHeader.className = `plan-group-header plan-group-${group.key}`;
    groupHeader.textContent = group.title;
    wrap.appendChild(groupHeader);
    members.forEach(emp => {
      wrap.appendChild(buildPlanRow(emp, weeks, dayOffMap[emp.id], weeklyPlansMap[emp.id], fond, gridTemplate, ctx));
    });
  });

  if (!employees.length) {
    wrap.innerHTML += '<div class="empty-note muted">Nema aktivnih zaposlenih sa funkcijom Shift lider / Monitoring / Radnik.</div>';
  }
}

async function handleSavePlan() {
  const btn = document.getElementById("plan-save-btn");
  btn.disabled = true;
  btn.textContent = "Čuvanje...";

  const year = parseInt(document.getElementById("plan-year").value, 10);
  const month = parseInt(document.getElementById("plan-month").value, 10);
  const rows = document.querySelectorAll("#plan-table-wrap .plan-row");
  const errors = [];

  for (const row of rows) {
    const employeeId = row.dataset.employeeId;
    const monitoringSelect = row.querySelector(".p-monitoring");
    const neZajednoEl = row.querySelector(".p-ne-zajedno");

    const empUpdate = {};
    if (monitoringSelect) empUpdate.monitoring_smena = monitoringSelect.value;
    if (neZajednoEl) empUpdate.ne_zajedno = neZajednoEl.checked;

    if (Object.keys(empUpdate).length) {
      const { error: empErr } = await sb.from("employees").update(empUpdate).eq("id", employeeId);
      if (empErr) errors.push(empErr.message);
    }

    const dayOffInput = row.querySelector(".p-dayoff");
    const dayOffId = row.dataset.dayOffId;
    if (dayOffInput.value) {
      if (dayOffId) {
        const { error } = await sb.from("days_off").update({ off_date: dayOffInput.value }).eq("id", dayOffId);
        if (error) errors.push(error.message);
      } else {
        const { data, error } = await sb
          .from("days_off")
          .insert({ employee_id: employeeId, off_date: dayOffInput.value })
          .select()
          .single();
        if (error) errors.push(error.message);
        else row.dataset.dayOffId = data.id;
      }
    } else if (dayOffId) {
      const { error } = await sb.from("days_off").delete().eq("id", dayOffId);
      if (error) errors.push(error.message);
      else delete row.dataset.dayOffId;
    }

    const weekSelects = row.querySelectorAll(".p-week");
    for (const sel of weekSelects) {
      if (sel.disabled) continue; // "Ne radi" (odmor) nedelje se ne diraju ovde — upravljaju se preko zamene
      const replacingVal = sel.dataset.replacing || null;
      const { error } = await sb.from("weekly_plans").upsert(
        {
          employee_id: employeeId,
          year,
          month,
          week_number: parseInt(sel.dataset.week, 10),
          week_start: sel.dataset.start,
          week_end: sel.dataset.end,
          funkcija_for_week: sel.value,
          replacing_employee_id: replacingVal,
        },
        { onConflict: "employee_id,year,month,week_number" }
      );
      if (error) errors.push(error.message);
    }
  }

  if (errors.length) {
    planShowBanner("Neke izmene nisu sačuvane: " + errors.slice(0, 3).join("; "), "error");
  } else {
    planShowBanner("Plan sačuvan.", "success");
  }

  btn.disabled = false;
  btn.textContent = "Sačuvaj plan";
}

document.addEventListener("admin-ready", () => {
  const monthSelect = document.getElementById("plan-month");
  const yearInput = document.getElementById("plan-year");
  const now = new Date();

  MONTH_NAMES_SR.forEach((name, idx) => {
    const opt = document.createElement("option");
    opt.value = idx + 1;
    opt.textContent = name;
    if (idx === now.getMonth()) opt.selected = true;
    monthSelect.appendChild(opt);
  });
  yearInput.value = now.getFullYear();

  monthSelect.addEventListener("change", loadPlan);
  // Svaki put kad se otvori tab — sveži podaci iz "Osobe u sistemu" (odmori, aktivni, slava).
  document.addEventListener("admin-tab-change", (e) => { if (e.detail.to === "plan") loadPlan(); });
  yearInput.addEventListener("change", loadPlan);
  document.getElementById("plan-save-btn").addEventListener("click", handleSavePlan);

  loadPlan();
});
