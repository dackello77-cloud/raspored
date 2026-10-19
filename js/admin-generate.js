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
    // Red zamene nosi funkciju osobe koju menja (npr. shift_lider) — to nije promena funkcije
    // zamene; njene smene te nedelje dolaze iz preuzimanja (opts.replacements).
    if (row.replacing_employee_id) return;
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
  // Ako prethodni mesec još nije objavljen, nastavlja se iz njegovog nacrta.
  const fetchTail = (tbl) => sb.from(tbl)
    .select("employee_id, date, shift_code")
    .in("employee_id", employeeIds)
    .gte("date", iso(firstTail))
    .lte("date", iso(lastPrev));
  const draft = await fetchTail("schedule_draft");
  const { data, error } = draft.data && draft.data.length ? draft : await fetchTail("schedule");
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

// Ravnomerna raspodela: koliko je ko u prethodnih 6 meseci prosečno mesečno radio vikend/praznik
// i III smena (generator to uzima u obzir). Meseci u kojima osoba nije radila se ne računaju.
// Mesec koji još nije objavljen čita se iz nacrta.
const GEN_HISTORY_MONTHS = 6;
async function genFetchRows(tbl, ids, from, to) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from(tbl).select("employee_id, date, shift_code")
      .in("employee_id", ids).gte("date", from).lte("date", to).order("date").range(i, i + 999);
    if (error || !data) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function genFetchHistory(ids, year, month) {
  if (!ids.length) return null;
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const from = iso(new Date(year, month - 1 - GEN_HISTORY_MONTHS, 1));
  const to = iso(new Date(year, month - 1, 0));
  const [pub, draft] = await Promise.all([genFetchRows("schedule", ids, from, to), genFetchRows("schedule_draft", ids, from, to)]);
  const draftMonths = new Set(draft.map(r => r.date.slice(0, 7)));
  const rows = [...pub.filter(r => !draftMonths.has(r.date.slice(0, 7))), ...draft];
  const per = {}; // id -> { months: Set, wk, iii }
  rows.forEach(r => {
    const h = per[r.employee_id] || (per[r.employee_id] = { months: new Set(), wk: 0, iii: 0 });
    h.months.add(r.date.slice(0, 7));
    if (isHolidayOrWeekendLike(new Date(r.date + "T00:00:00"))) h.wk++;
    if (r.shift_code === "III") h.iii++;
  });
  const history = {};
  Object.entries(per).forEach(([id, h]) => { history[id] = { wk: h.wk / h.months.size, iii: h.iii / h.months.size }; });
  return Object.keys(history).length ? history : null;
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

    // Slava je uvek slobodan dan (ako pada u ovaj mesec) — i taj mesec radnik ima jednu smenu manje
    // od fonda (31 dan: 20, 30 dana: 19, februar: 18).
    const fondReduce = {};
    employees.forEach(e => {
      if (e.slava_date && Number(e.slava_date.slice(5, 7)) === month) {
        forcedOff[e.id].add(`${year}-${e.slava_date.slice(5)}`);
        fondReduce[e.id] = 1;
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
    const history = await genFetchHistory(radnici.map(e => e.id), year, month);

    const { scheduleMap: radniciMap, fondByEmployee, fondTarget, overfond, handoverFor } = generateRadniciSchedule(
      radnici, variant, year, month, weeks, weeklyOverridesMap, forcedOff, fixedMapAll,
      { zamene, replacements, fixedNoVac, prevTail, fondReduce, history }
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
    // Shift lider na slavi (radni dan): liderstvo u smeni koju bi radio preuzima čekirani radnik iz te smene.
    const slavaGaps = [];
    employees.forEach(e => {
      if (e.funkcija !== "shift_lider" || !e.slava_date || Number(e.slava_date.slice(5, 7)) !== month) return;
      const date = `${year}-${e.slava_date.slice(5)}`;
      const shift = fixedNoVac[e.id] && fixedNoVac[e.id][date];
      if (shift === "I" || shift === "II" || shift === "III") slavaGaps.push({ date, shift });
    });
    assignSlavaLeaders(combined, employees, vikendLiderIds, slavaGaps, leaderKeys);

    // Upisuje se u NACRT — glavna strana i radnici ga ne vide dok se ne klikne "Objavi raspored".
    await sb.from("schedule_draft").delete().gte("date", start).lte("date", end);

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
      const { error } = await sb.from("schedule_draft").insert(chunk);
      if (error) {
        genShowBanner("Greška pri upisu rasporeda: " + error.message, "error");
        return;
      }
    }

    // Minimum po smeni za ovaj mesec — HR ga vidi kad odobrava slobodan dan.
    await sb.from("settings").upsert(
      { key: `minimumi_${year}_${month}`, value: variant.mins, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

    genRenderResults(employees, radnici, liderMonitoring, combined, fondByEmployee, fondTarget, year, month, overfond, zamene, variant, handoverFor);
    genShowBanner(`Nacrt rasporeda za ${MONTH_NAMES_SR[month - 1]} ${year} je napravljen. Sredite ga ispod pa kliknite „Objavi raspored“.`, "success");
    await genShowDraft(year, month, true);
  } catch (err) {
    console.error(err);
    genShowBanner("Raspored nije napravljen: " + err.message, "error");
  } finally {
    btn.textContent = "Napravi raspored";
    genUpdateRunBtn();
  }
}

function genRenderResults(employees, radnici, liderMonitoring, combined, fondByEmployee, fondTarget, year, month, overfond, zamene = [], variant = null, handoverFor = {}) {
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
    const target = f.target || fondTarget;
    const slava = target < fondTarget ? `<br/><span class="muted" style="font-weight:500;">Slava · fond ${target}</span>` : "";
    fondHtml += `<tr><td>${name}${slava}</td><td>${f.I}</td><td>${f.II}</td><td>${f.III}</td><td class="total">${f.total}</td></tr>`;
    if (f.total < target) underfond.push(`${name} (${f.total}/${target})`);
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
    .map(e => `${(e.profiles?.full_name || "").toUpperCase()} (${fondByEmployee[e.id].total}/${fondByEmployee[e.id].target || fondTarget})`);

  // Smene sa manje radnika od minimuma (lideri/monitoring i zamena za lidera se ne računaju).
  const liderIds = new Set(liderMonitoring.map(e => e.id));
  const belowMin = [];
  if (variant) {
    for (let d = 1; d <= daysInMonth(year, month); d++) {
      const key = dateKey(year, month, d);
      const cnt = { I: 0, II: 0, III: 0 };
      [...radnici, ...zamene].forEach(e => {
        const v = combined[e.id] && combined[e.id][key];
        const forId = handoverFor && handoverFor[e.id] && handoverFor[e.id][key];
        if (cnt[v] !== undefined && !(forId && liderIds.has(forId))) cnt[v]++;
      });
      ["I", "II", "III"].forEach(c => {
        if (cnt[c] < variant.mins[c]) belowMin.push(`${String(d).padStart(2, "0")}.${String(month).padStart(2, "0")}. ${c} smena (${cnt[c]}/${variant.mins[c]})`);
      });
    }
  }

  document.getElementById("gen-underfond").innerHTML =
    (belowMin.length
      ? `<div class="field-label" style="margin-bottom:6px;">Smene ispod minimuma — popuniti ručno:</div>` +
        belowMin.map(n => `<span class="underfond-chip">${n}</span>`).join("") + "<br/>"
      : "") +
    (underfond.length
      ? `<div class="field-label" style="margin-bottom:6px;">Nemaju pun fond — dopuniti ručno:</div>` +
        underfond.map(n => `<span class="underfond-chip">${n}</span>`).join("")
      : "") +
    (overNames.length
      ? `<div class="field-label" style="margin:10px 0 6px;">Imaju višak smena — skinuti ručno:</div>` +
        overNames.map(n => `<span class="underfond-chip">${n}</span>`).join("")
      : "");
}

// ---------- Nacrt: ručno sređivanje pa objava ----------
function genSelectedMonth() {
  return {
    year: parseInt(document.getElementById("gen-year").value, 10),
    month: parseInt(document.getElementById("gen-month").value, 10),
  };
}

async function genShowDraft(year, month, scrollTo) {
  const box = document.getElementById("gen-draft");
  const { start, end } = rdmMonthRange(year, month);
  const [{ count }, { count: published }] = await Promise.all([
    sb.from("schedule_draft").select("id", { count: "exact", head: true }).gte("date", start).lte("date", end),
    sb.from("schedule").select("id", { count: "exact", head: true }).gte("date", start).lte("date", end),
  ]);
  const sel = genSelectedMonth();
  if (sel.year !== year || sel.month !== month) return; // u međuvremenu izabran drugi mesec
  if (!count) { box.style.display = "none"; box.innerHTML = ""; return; }

  await rdmLoadStaticData();
  const label = `${MONTH_NAMES_SR[month - 1]} ${year}`;
  box.innerHTML = `
    <div class="gen-draft-head">
      <div>
        <h2><span class="draft-badge">NACRT</span> ${label}</h2>
        <p class="muted">Vidi ga samo admin. Sredite raspored (desni klik, +, ✕) pa kliknite „Objavi raspored“ —
          tek tada se pojavljuje na glavnoj strani i radnici dobijaju obaveštenje.${published ? ` <b>Objava će zameniti trenutno objavljeni raspored za ${label}.</b>` : ""}</p>
      </div>
      <div class="gen-draft-actions">
        <button type="button" class="btn btn-ghost" id="gen-draft-delete">Obriši nacrt</button>
        <button type="button" class="btn btn-primary" id="gen-draft-publish">Objavi raspored</button>
      </div>
    </div>`;
  box.appendChild(genBuildBalance(year, month));

  const search = document.createElement("div");
  search.className = "rdm-search-bar";
  search.innerHTML = `<input type="text" placeholder="Pronađi zaposlenog..." autocomplete="off" /><div class="rdm-search-info muted"></div>`;
  box.appendChild(search);
  search.querySelector("input").addEventListener("input", (e) => rdmApplySearch(e.target.value, box, search.querySelector(".rdm-search-info")));
  box.appendChild(await rdmRenderMonth(year, month, false, "schedule_draft"));
  box.style.display = "";

  box.querySelector("#gen-draft-publish").addEventListener("click", () => genPublishDraft(year, month, published));
  box.querySelector("#gen-draft-delete").addEventListener("click", async () => {
    const ok = await rdmConfirm(`Obrisati nacrt za <b>${label}</b>?`, "Objavljeni raspored se ne menja.");
    if (!ok) return;
    await sb.from("schedule_draft").delete().gte("date", start).lte("date", end);
    await sb.from("settings").delete().eq("key", `nacrt_izmena_${year}_${month}`);
    genShowBanner(`Nacrt za ${label} je obrisan.`, "success");
    await rdmLoadAllMonths();
    await genShowDraft(year, month);
  });
  if (scrollTo) box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Pregled ravnomernosti: prosek vikend/praznik i III smena mesečno (prethodnih 6 meseci) i koliko
// ih radnik ima u ovom nacrtu. Računa se svaki put kad se otvori (posle ručnih izmena je tačno).
function genBuildBalance(year, month) {
  const det = document.createElement("details");
  det.className = "gen-balance";
  det.innerHTML = `<summary>Ravnoteža vikenda i III smena — poslednjih ${GEN_HISTORY_MONTHS} meseci i ovaj nacrt</summary><div class="gen-balance-body muted">Učitavanje...</div>`;
  det.addEventListener("toggle", async () => {
    if (!det.open) return;
    const bodyEl = det.querySelector(".gen-balance-body");
    const radnici = RDM_ACTIVE_EMPLOYEES.filter(e => e.funkcija === "radnik");
    const ids = radnici.map(e => e.id);
    const { start, end } = rdmMonthRange(year, month);
    const [history, rows] = await Promise.all([genFetchHistory(ids, year, month), genFetchRows("schedule_draft", ids, start, end)]);
    const now = {};
    rows.forEach(r => {
      const n = now[r.employee_id] || (now[r.employee_id] = { wk: 0, iii: 0 });
      if (isHolidayOrWeekendLike(new Date(r.date + "T00:00:00"))) n.wk++;
      if (r.shift_code === "III") n.iii++;
    });
    const avg = (k, src) => { const v = radnici.map(e => (src[e.id] || {})[k]).filter(x => x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
    const H = history || {};
    const aw = avg("wk", H), ai = avg("iii", H), nw = avg("wk", now), ni = avg("iii", now);
    // Crveno: i ranije iznad proseka i sada iznad proseka (ili obrnuto zeleno) — tu bi ručna zamena pomogla.
    const mark = (hist, cur, ha, ca) => (hist !== undefined && hist > ha + 0.5 && cur > ca + 0.5) ? "bal-high" : (hist !== undefined && hist < ha - 0.5 && cur < ca - 0.5) ? "bal-low" : "";
    const f1 = (x) => x === undefined ? "—" : x.toFixed(1);
    const list = radnici.map(e => ({ e, h: H[e.id], n: now[e.id] || { wk: 0, iii: 0 } }))
      .sort((a, b) => ((b.h ? b.h.wk : 0) + b.n.wk) - ((a.h ? a.h.wk : 0) + a.n.wk));
    bodyEl.className = "gen-balance-body";
    bodyEl.innerHTML = `
      <table class="gen-table bal-table">
        <thead><tr><th>Radnik</th><th>Vikend/praznik<br><span>prosek mesečno</span></th><th>Vikend/praznik<br><span>ovaj nacrt</span></th><th>III smena<br><span>prosek mesečno</span></th><th>III smena<br><span>ovaj nacrt</span></th></tr></thead>
        <tbody>${list.map(({ e, h, n }) => `<tr>
          <td>${e.name.toUpperCase()}</td>
          <td>${f1(h && h.wk)}</td><td class="${mark(h && h.wk, n.wk, aw, nw)}">${n.wk}</td>
          <td>${f1(h && h.iii)}</td><td class="${mark(h && h.iii, n.iii, ai, ni)}">${n.iii}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>Prosek</td><td>${aw.toFixed(1)}</td><td>${nw.toFixed(1)}</td><td>${ai.toFixed(1)}</td><td>${ni.toFixed(1)}</td></tr></tfoot>
      </table>
      <p class="muted bal-note"><span class="bal-high">crveno</span> = i ranije i sada iznad proseka · <span class="bal-low">zeleno</span> = i ranije i sada ispod proseka — tu ručna zamena najviše pomaže. Generator ovo već uzima u obzir koliko pravila dozvoljavaju.</p>`;
  });
  return det;
}

async function genPublishDraft(year, month, published) {
  const label = `${MONTH_NAMES_SR[month - 1]} ${year}`;
  const ok = await rdmConfirm(
    `Objaviti raspored za <b>${label}</b>?`,
    (published ? `Trenutno objavljeni raspored za ${label} biće zamenjen. ` : "") +
      "Raspored se pojavljuje na glavnoj strani, a radnici dobijaju obaveštenje na telefon.",
    "Objavi", "btn-primary"
  );
  if (!ok) return;
  const btn = document.getElementById("gen-draft-publish");
  btn.disabled = true;
  btn.textContent = "Objavljujem...";
  const { error } = await sb.rpc("schedule_publish", { p_year: year, p_month: month });
  if (error) {
    genShowBanner("Objava nije uspela: " + error.message, "error");
    btn.disabled = false;
    btn.textContent = "Objavi raspored";
    return;
  }
  sb.functions.invoke("send-push", { body: { published: { year, month } } }).catch(console.error);
  genShowBanner(`Raspored za ${label} je objavljen.`, "success");
  await genShowDraft(year, month);
  await rdmLoadAllMonths();
}

document.addEventListener("admin-ready", () => {
  const monthSelect = document.getElementById("gen-month");
  const yearInput = document.getElementById("gen-year");
  // Podrazumevano: naredni mesec (decembar → januar naredne godine), isto kao Plan zaposlenih.
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  MONTH_NAMES_SR.forEach((name, idx) => {
    const opt = document.createElement("option");
    opt.value = idx + 1;
    opt.textContent = name;
    if (idx === next.getMonth()) opt.selected = true;
    monthSelect.appendChild(opt);
  });
  yearInput.value = next.getFullYear();

  document.getElementById("gen-suggest-btn").addEventListener("click", genHandleSuggest);
  document.getElementById("gen-run-btn").addEventListener("click", genHandleRun);
  const showSelectedDraft = () => { const m = genSelectedMonth(); if (m.year && m.month) genShowDraft(m.year, m.month); };
  monthSelect.addEventListener("change", () => { genResetSuggest(); showSelectedDraft(); });
  yearInput.addEventListener("input", () => { genResetSuggest(); showSelectedDraft(); });
  genUpdateRunBtn();
  showSelectedDraft(); // nacrt započet ranije ostaje i posle osvežavanja stranice
});
