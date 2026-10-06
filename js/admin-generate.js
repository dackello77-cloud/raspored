function genShowBanner(message, type) {
  const box = document.getElementById("rasporedi-banner");
  box.innerHTML = `<div class="banner ${type}">${message}</div>`;
}

async function genFetchEmployees() {
  const { data, error } = await sb
    .from("employees")
    .select("id, funkcija, monitoring_smena, slava_date, profiles(full_name)")
    .eq("active", true)
    .in("funkcija", ["radnik", "shift_lider", "monitoring"]);
  if (error) {
    console.error(error);
    return [];
  }
  return data;
}

async function genFetchOverridesAndForcedOff(employeeIds, year, month, weeks) {
  const forcedOff = {};
  const weeklyOverridesMap = {};
  if (!employeeIds.length) return { forcedOff, weeklyOverridesMap, weeklyPlans: [] };

  const monthStart = weeks[0].start;
  const monthEnd = weeks[weeks.length - 1].end;

  const [{ data: vacations }, { data: daysOff }, { data: weeklyPlans }] = await Promise.all([
    sb.from("vacations").select("*").in("employee_id", employeeIds),
    sb.from("days_off").select("*").in("employee_id", employeeIds).gte("off_date", monthStart).lte("off_date", monthEnd),
    sb.from("weekly_plans").select("*").in("employee_id", employeeIds).eq("year", year).eq("month", month),
  ]);

  employeeIds.forEach(id => { forcedOff[id] = new Set(); });

  (vacations || []).forEach(v => {
    let d = new Date(v.start_date + "T00:00:00");
    const end = new Date(v.end_date + "T00:00:00");
    while (d <= end) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (key >= monthStart && key <= monthEnd) forcedOff[v.employee_id].add(key);
      d.setDate(d.getDate() + 1);
    }
  });

  (daysOff || []).forEach(row => {
    if (!forcedOff[row.employee_id]) forcedOff[row.employee_id] = new Set();
    forcedOff[row.employee_id].add(row.off_date);
  });

  (weeklyPlans || []).forEach(row => {
    if (!weeklyOverridesMap[row.employee_id]) weeklyOverridesMap[row.employee_id] = {};
    weeklyOverridesMap[row.employee_id][row.week_number] = row.funkcija_for_week;
  });

  return { forcedOff, weeklyOverridesMap, weeklyPlans: weeklyPlans || [] };
}

// Poslednjih 7 dana prethodnog meseca iz sačuvanog rasporeda — da se niz nastavi na prelazu.
// Vraća employeeId -> { 0: smena poslednjeg dana, -1: dan pre, ..., -6 } ("OFF" ako nema smene).
async function genFetchPrevTail(employeeIds, year, month) {
  const lastPrev = new Date(year, month - 1, 0); // poslednji dan prethodnog meseca
  const firstTail = new Date(lastPrev);
  firstTail.setDate(firstTail.getDate() - 6);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const { data, error } = await sb
    .from("schedule")
    .select("employee_id, date, shift_code")
    .in("employee_id", employeeIds)
    .gte("date", iso(firstTail))
    .lte("date", iso(lastPrev));
  if (error) {
    console.error(error);
    return {};
  }
  const tail = {};
  employeeIds.forEach(id => {
    tail[id] = {};
    for (let x = 0; x >= -6; x--) tail[id][x] = "OFF";
  });
  (data || []).forEach(row => {
    const offset = Math.round((new Date(row.date + "T00:00:00") - lastPrev) / 86400000);
    if (tail[row.employee_id] && offset <= 0 && offset >= -6) tail[row.employee_id][offset] = row.shift_code;
  });
  return tail;
}

// Zamenski radnici meseca: čekirani u "Plan zaposlenih" (settings "zamene_GGGG_M")
// + svi koji imaju dodeljenu zamenu u weekly_plans tog meseca.
async function genFetchZameneIds(year, month) {
  const [{ data: setting }, { data: assigned }] = await Promise.all([
    sb.from("settings").select("value").eq("key", `zamene_${year}_${month}`).maybeSingle(),
    sb.from("weekly_plans").select("employee_id").eq("year", year).eq("month", month).not("replacing_employee_id", "is", null),
  ]);
  const ids = new Set(Array.isArray(setting && setting.value) ? setting.value : []);
  (assigned || []).forEach(r => ids.add(r.employee_id));
  return ids;
}

// "Napravi raspored" je zaključan dok se ne klikne "Primeni predlog" za izabrani mesec/godinu.
let genSuggestApplied = false;

function genUpdateRunBtn() {
  const btn = document.getElementById("gen-run-btn");
  btn.disabled = !genSuggestApplied;
  btn.title = genSuggestApplied ? "" : "Prvo klikni \"Primeni predlog\"";
}

function genResetSuggest() {
  genSuggestApplied = false;
  document.getElementById("gen-suggestion").innerHTML = "";
  genUpdateRunBtn();
}

async function genHandleSuggest() {
  const year = parseInt(document.getElementById("gen-year").value, 10);
  const month = parseInt(document.getElementById("gen-month").value, 10);
  const [{ data: radniciRows }, zameneIds] = await Promise.all([
    sb.from("employees").select("id").eq("active", true).eq("funkcija", "radnik"),
    genFetchZameneIds(year, month),
  ]);
  // Zamenski radnici se ne računaju u fond — oni samo popunjavaju odmore i rupe.
  const count = (radniciRows || []).filter(r => !zameneIds.has(r.id)).length;
  const zameneCount = (radniciRows || []).length - count;

  const fond = monthFond(year, month);
  const nDays = daysInMonth(year, month);
  const totalFond = (count || 0) * fond;
  const avgPerDay = nDays ? totalFond / nDays : 0;

  // Po primerima iz doc/RASPORED.xlsx: do 12 radnika (≈8.1 po danu) 2/3,2/3,2/3;
  // 13 radnika (≈8.8) 2/3,3/4,2/3; 14 radnika (≈9.5) 2/3,3/4,3/4; 15+ (≈10.2) 3/4,3/4,3/4.
  let bands;
  if (avgPerDay < 8.5) bands = ["2/3", "2/3", "2/3"];
  else if (avgPerDay < 9.15) bands = ["2/3", "3/4", "2/3"];
  else if (avgPerDay < 9.8) bands = ["2/3", "3/4", "3/4"];
  else bands = ["3/4", "3/4", "3/4"];

  document.getElementById("gen-i").value = bands[0];
  document.getElementById("gen-ii").value = bands[1];
  document.getElementById("gen-iii").value = bands[2];

  const label = (b) => (b === "3/4" ? "3 ili 4" : "2 ili 3");
  document.getElementById("gen-suggestion").innerHTML =
    `Predlog: I = ${label(bands[0])}, II = ${label(bands[1])}, III = ${label(bands[2])}. ` +
    `Radnika ${count || 0}${zameneCount ? ` (+ ${zameneCount} zamen${zameneCount === 1 ? "a" : "e"}, ne računaju se)` : ""}, ` +
    `fond ${totalFond} / ${nDays} dana = ${avgPerDay.toFixed(2)} po danu.`;

  genSuggestApplied = true;
  genUpdateRunBtn();
}

function genBuildCombinedMap(radniciMap, fixedMap, allEmployees) {
  const combined = {};
  allEmployees.forEach(emp => {
    combined[emp.id] = radniciMap[emp.id] || fixedMap[emp.id] || {};
  });
  return combined;
}

async function genHandleRun() {
  const btn = document.getElementById("gen-run-btn");
  btn.disabled = true;
  btn.textContent = "Generisanje...";

  try {
    const year = parseInt(document.getElementById("gen-year").value, 10);
    const month = parseInt(document.getElementById("gen-month").value, 10);
    const iBand = document.getElementById("gen-i").value;
    const iiBand = document.getElementById("gen-ii").value;
    const iiiBand = document.getElementById("gen-iii").value;
    const variant = findVariant(iBand, iiBand, iiiBand);

    const [employees, zameneIds] = await Promise.all([genFetchEmployees(), genFetchZameneIds(year, month)]);
    const radnici = employees.filter(e => e.funkcija === "radnik" && !zameneIds.has(e.id));
    const zamene = employees.filter(e => e.funkcija === "radnik" && zameneIds.has(e.id));
    const liderMonitoring = employees.filter(e => e.funkcija === "shift_lider" || e.funkcija === "monitoring");
    const allIds = employees.map(e => e.id);

    const weeks = computeWeeksOfMonth(year, month);
    const { forcedOff, weeklyOverridesMap, weeklyPlans } = await genFetchOverridesAndForcedOff(allIds, year, month, weeks);

    // Slava je uvek slobodan dan (ako pada u ovaj mesec).
    employees.forEach(e => {
      if (e.slava_date && Number(e.slava_date.slice(5, 7)) === month) {
        forcedOff[e.id].add(`${year}-${e.slava_date.slice(5)}`);
      }
    });

    const liderIndexOffset = {};
    // Redni broj SAMO među shift liderima (0, 1, 2...) — tako svake nedelje svaki lider
    // dobija drugu smenu (I / II / III), uz rotaciju iz nedelje u nedelju.
    let li = 0;
    employees
      .filter(e => e.funkcija === "shift_lider")
      .sort((a, b) => (a.profiles?.full_name || "").localeCompare(b.profiles?.full_name || ""))
      .forEach(e => { liderIndexOffset[e.id] = li++; });

    const fixedMapAll = generateFixedFunctionSchedule(employees, weeks, forcedOff, weeklyOverridesMap, liderIndexOffset);

    // Dani odmora koje zamena preuzima: dodeljene nedelje (weekly_plans.replacing_employee_id),
    // samo dani kada je osoba zaista na odmoru/slobodna.
    const replacements = weeklyPlans
      .filter(row => row.replacing_employee_id && zameneIds.has(row.employee_id))
      // monitoring nema zamenu
      .filter(row => (employees.find(e => e.id === row.replacing_employee_id) || {}).funkcija !== "monitoring")
      .map(row => {
        const w = weeks.find(x => x.number === row.week_number);
        const off = forcedOff[row.replacing_employee_id] || new Set();
        const dates = w ? [...off].filter(k => k >= w.start && k <= w.end) : [];
        return { replacerId: row.employee_id, vacationerId: row.replacing_employee_id, dates };
      });

    // Raspored lidera/monitoringa kao da nisu na odmoru — da zamena zna koje smene preuzima.
    const noForcedOff = {};
    allIds.forEach(id => { noForcedOff[id] = new Set(); });
    const overridesNoVac = {};
    Object.entries(weeklyOverridesMap).forEach(([id, wk]) => {
      overridesNoVac[id] = {};
      Object.entries(wk).forEach(([n, f]) => { if (f !== "ne_radi" && f !== "slobodan") overridesNoVac[id][n] = f; });
    });
    const fixedNoVac = generateFixedFunctionSchedule(employees, weeks, noForcedOff, overridesNoVac, liderIndexOffset);

    const prevTail = await genFetchPrevTail([...radnici, ...zamene].map(e => e.id), year, month);

    const { scheduleMap: radniciMap, fondByEmployee, fondTarget, overfond, handoverFor } = generateRadniciSchedule(
      radnici, variant, year, month, weeks, weeklyOverridesMap, forcedOff, fixedMapAll,
      { zamene, replacements, fixedNoVac, prevTail }
    );

    const combined = genBuildCombinedMap(radniciMap, fixedMapAll, employees);

    const { start, end } = (() => {
      const last = daysInMonth(year, month);
      return { start: `${year}-${String(month).padStart(2, "0")}-01`, end: `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}` };
    })();

    const { data: vlRow } = await sb.from("settings").select("value").eq("key", "vikend_lideri").maybeSingle();
    const vikendLiderIds = new Set(Array.isArray(vlRow && vlRow.value) ? vlRow.value : []);
    // Zamena za shift lidera na odmoru preuzima i liderstvo u tim smenama.
    const liderIds = new Set(employees.filter(e => e.funkcija === "shift_lider").map(e => e.id));
    const handoverLeaders = new Set();
    Object.entries(handoverFor || {}).forEach(([zamenaId, days]) => {
      Object.entries(days).forEach(([date, vacationerId]) => {
        if (liderIds.has(vacationerId)) handoverLeaders.add(`${zamenaId}|${date}`);
      });
    });
    const leaderKeys = assignWeekendLeaders(combined, employees, vikendLiderIds, Math.random, handoverLeaders);
    handoverLeaders.forEach(k => leaderKeys.add(k));

    await sb.from("schedule").delete().gte("date", start).lte("date", end);

    const rows = [];
    Object.entries(combined).forEach(([employeeId, dayMap]) => {
      Object.entries(dayMap).forEach(([date, state]) => {
        if (state === "I" || state === "II" || state === "III") {
          const forId = handoverFor && handoverFor[employeeId] && handoverFor[employeeId][date];
          rows.push({
            date, shift_code: state, employee_id: employeeId, replacement_for: forId || null,
            is_leader: leaderKeys.has(`${employeeId}|${date}`),
          });
        }
      });
    });

    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400);
      const { error } = await sb.from("schedule").insert(chunk);
      if (error) {
        genShowBanner("Greška pri upisu rasporeda: " + error.message, "error");
        return;
      }
    }

    genRenderResults(employees, radnici, liderMonitoring, combined, fondByEmployee, fondTarget, year, month, overfond, zamene);
    genShowBanner(`Raspored za ${MONTH_NAMES_SR[month - 1]} ${year} je generisan i sačuvan.`, "success");

    const container = document.getElementById("rasporedi-months");
    delete container.dataset.loaded;
    await rdmLoadAllMonths();
  } catch (err) {
    console.error(err);
    genShowBanner("Raspored nije napravljen: " + err.message, "error");
  } finally {
    btn.textContent = "Napravi raspored";
    genUpdateRunBtn();
  }
}

function genRenderResults(employees, radnici, liderMonitoring, combined, fondByEmployee, fondTarget, year, month, overfond, zamene = []) {
  document.getElementById("gen-results").style.display = "grid";

  const nDays = daysInMonth(year, month);
  let dailyHtml = "<thead><tr><th>Datum</th><th>I</th><th>II</th><th>III</th><th>Ukupno</th></tr></thead><tbody>";
  for (let d = 1; d <= nDays; d++) {
    const key = dateKey(year, month, d);
    let I = 0, II = 0, III = 0;
    employees.forEach(e => {
      const v = combined[e.id] && combined[e.id][key];
      if (v === "I") I++; else if (v === "II") II++; else if (v === "III") III++;
    });
    dailyHtml += `<tr><td>${String(d).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}</td><td>${I}</td><td>${II}</td><td>${III}</td><td class="total">${I + II + III}</td></tr>`;
  }
  dailyHtml += "</tbody>";
  document.getElementById("gen-daily-table").innerHTML = dailyHtml;

  let fondHtml = "<thead><tr><th>Zaposleni</th><th>I</th><th>II</th><th>III</th><th>Ukupno</th></tr></thead><tbody>";
  const underfond = [];

  radnici.forEach(e => {
    const f = fondByEmployee[e.id] || { I: 0, II: 0, III: 0, total: 0 };
    const name = (e.profiles?.full_name || "").toUpperCase();
    fondHtml += `<tr><td>${name}</td><td>${f.I}</td><td>${f.II}</td><td>${f.III}</td><td class="total">${f.total}</td></tr>`;
    if (f.total < fondTarget) underfond.push(`${name} (${f.total}/${fondTarget})`);
  });

  zamene.forEach(e => {
    const f = fondByEmployee[e.id] || { I: 0, II: 0, III: 0, total: 0 };
    const name = (e.profiles?.full_name || "").toUpperCase();
    fondHtml += `<tr><td>${name}<br/><span class="muted" style="font-weight:500;">Zamena</span></td><td>${f.I}</td><td>${f.II}</td><td>${f.III}</td><td class="total">${f.total}</td></tr>`;
  });

  liderMonitoring.forEach(e => {
    const vals = Object.values(combined[e.id] || {});
    const f = {
      I: vals.filter(v => v === "I").length,
      II: vals.filter(v => v === "II").length,
      III: vals.filter(v => v === "III").length,
    };
    f.total = f.I + f.II + f.III;
    const name = (e.profiles?.full_name || "").toUpperCase();
    const tag = e.funkcija === "shift_lider" ? "Lider" : `Monitoring ${e.monitoring_smena || ""}`;
    fondHtml += `<tr><td>${name}<br/><span class="muted" style="font-weight:500;">${tag}</span></td><td>${f.I}</td><td>${f.II}</td><td>${f.III}</td><td class="total">${f.total}</td></tr>`;
  });

  fondHtml += "</tbody>";
  document.getElementById("gen-fond-table").innerHTML = fondHtml;

  const overNames = [...radnici, ...zamene]
    .filter(e => (overfond || []).includes(e.id))
    .map(e => `${(e.profiles?.full_name || "").toUpperCase()} (${fondByEmployee[e.id].total}/${fondTarget})`);

  document.getElementById("gen-underfond").innerHTML =
    (underfond.length
      ? `<div class="field-label" style="margin-bottom:6px;">Nemaju pun fond — dopuniti ručno:</div>` +
        underfond.map(n => `<span class="underfond-chip">${n}</span>`).join("")
      : "") +
    (overNames.length
      ? `<div class="field-label" style="margin:10px 0 6px;">Imaju višak smena — skinuti ručno:</div>` +
        overNames.map(n => `<span class="underfond-chip">${n}</span>`).join("")
      : "");
}

document.addEventListener("admin-ready", () => {
  const monthSelect = document.getElementById("gen-month");
  const yearInput = document.getElementById("gen-year");
  const now = new Date();

  MONTH_NAMES_SR.forEach((name, idx) => {
    const opt = document.createElement("option");
    opt.value = idx + 1;
    opt.textContent = name;
    if (idx === now.getMonth()) opt.selected = true;
    monthSelect.appendChild(opt);
  });
  yearInput.value = now.getFullYear();

  document.getElementById("gen-suggest-btn").addEventListener("click", genHandleSuggest);
  document.getElementById("gen-run-btn").addEventListener("click", genHandleRun);
  monthSelect.addEventListener("change", genResetSuggest);
  yearInput.addEventListener("input", genResetSuggest);
  genUpdateRunBtn();
});
