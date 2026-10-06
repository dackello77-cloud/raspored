function rdmPad2(n) { return String(n).padStart(2, "0"); }

function rdmMonthRange(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${rdmPad2(month)}-01`,
    end: `${year}-${rdmPad2(month)}-${rdmPad2(lastDay)}`,
    lastDay,
  };
}

function rdmShowBanner(message, type) {
  const box = document.getElementById("rasporedi-banner");
  box.innerHTML = `<div class="banner ${type}">${message}</div>`;
  if (type === "success") setTimeout(() => { box.innerHTML = ""; }, 5000);
}

let RDM_SHIFT_TYPES = [];
let RDM_ACTIVE_EMPLOYEES = [];

async function rdmLoadStaticData() {
  const [{ data: shiftTypes }, { data: employees }] = await Promise.all([
    sb.from("shift_types").select("*").order("sort_order"),
    sb.from("employees").select("id, funkcija, profiles(full_name, username)").eq("active", true),
  ]);
  RDM_SHIFT_TYPES = shiftTypes || [];
  RDM_ACTIVE_EMPLOYEES = (employees || [])
    .map(e => ({ id: e.id, funkcija: e.funkcija, name: e.profiles?.full_name || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function rdmFetchSchedule(year, month) {
  const { start, end } = rdmMonthRange(year, month);
  const { data, error } = await sb
    .from("schedule")
    .select("id, date, shift_code, is_leader, is_medju_smena, employee_id, employees!schedule_employee_id_fkey(funkcija, profiles(full_name, username))")
    .gte("date", start)
    .lte("date", end)
    .order("date");
  if (error) {
    console.error(error);
    return [];
  }
  return data;
}

function rdmGroup(rows) {
  const map = {};
  rows.forEach(r => {
    if (!map[r.date]) map[r.date] = { I: [], II: [], III: [] };
    map[r.date][r.shift_code].push({
      scheduleId: r.id,
      employeeId: r.employee_id,
      isLeader: r.is_leader,
      isMS: r.is_medju_smena,
      funkcija: r.employees?.funkcija || "radnik",
      name: r.employees?.profiles?.full_name || "",
    });
  });
  return map;
}

async function rdmSetLeader(date, shiftCode, scheduleId, employeeId, newState) {
  if (newState) {
    await sb.from("schedule").update({ is_leader: false }).eq("date", date).eq("shift_code", shiftCode);
  }
  await sb.from("schedule").update({ is_leader: newState }).eq("id", scheduleId);
}

async function rdmRenderMonth(year, month, collapsedDefault) {
  const wrap = document.createElement("div");
  wrap.className = "rdm-month-wrap";
  wrap.dataset.year = year;
  wrap.dataset.month = month;

  // Zaglavlje meseca + manjak smena — zakačeno na vrhu dok se skroluje kroz mesec.
  const sticky = document.createElement("div");
  sticky.className = "rdm-month-sticky";
  const header = document.createElement("div");
  header.className = "month-header";
  header.innerHTML = `<span>${MONTH_NAMES_SR[month - 1]} ${year}</span><span class="toggle-label">${collapsedDefault ? "Prikaži" : "Sakrij"}</span>`;
  sticky.appendChild(header);
  const underfond = document.createElement("div");
  underfond.className = "rdm-underfond";
  sticky.appendChild(underfond);
  wrap.appendChild(sticky);

  const body = document.createElement("div");
  body.style.display = collapsedDefault ? "none" : "";
  wrap.appendChild(body);

  header.addEventListener("click", () => {
    const isHidden = body.style.display === "none";
    body.style.display = isHidden ? "" : "none";
    header.querySelector(".toggle-label").textContent = isHidden ? "Sakrij" : "Prikaži";
  });

  await rdmRenderMonthBody(body, year, month);
  return wrap;
}

// Radnici kojima u ovom mesecu nedostaju smene do fonda, npr. "SASKA 12/21".
function rdmRenderUnderfond(el, fondCounts, fondTarget) {
  if (!el) return;
  const short = RDM_ACTIVE_EMPLOYEES
    .filter(e => e.funkcija === "radnik" && (fondCounts[e.id] || 0) < fondTarget)
    .map(e => ({ name: e.name.toUpperCase(), n: fondCounts[e.id] || 0 }))
    .sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  el.innerHTML = short.length
    ? `<span class="rdm-underfond-label">Manjak smena:</span>` +
      short.map(x => `<span class="rdm-underfond-chip"><b>${x.name}</b> ${x.n}/${fondTarget}</span>`).join("")
    : `<span class="rdm-underfond-ok">Svi radnici imaju pun fond (${fondTarget}).</span>`;
}

async function rdmRenderMonthBody(body, year, month) {
  // Posle izmene: stari prikaz ostaje dok se novi ne učita, pa se zameni na istom mestu
  // (bez skoka stranice). "Učitavanje..." samo pri prvom prikazu meseca.
  const isRefresh = !!body.querySelector(".rdm-day-block");
  if (!isRefresh) body.innerHTML = '<div class="empty-note muted">Učitavanje...</div>';
  const rows = await rdmFetchSchedule(year, month);
  const byDate = rdmGroup(rows);
  const { lastDay } = rdmMonthRange(year, month);
  const now = belgradeNow();
  const todayStr = `${now.getFullYear()}-${rdmPad2(now.getMonth() + 1)}-${rdmPad2(now.getDate())}`;

  // Trenutni ukupan broj smena po zaposlenom u ovom mesecu (za filter u "+" dugmetu).
  const fondCounts = {};
  rows.forEach(r => { fondCounts[r.employee_id] = (fondCounts[r.employee_id] || 0) + 1; });
  const fondTarget = monthFond(year, month);
  rdmRenderUnderfond(body.parentElement && body.parentElement.querySelector(".rdm-underfond"), fondCounts, fondTarget);

  const frag = document.createDocumentFragment();

  for (let d = 1; d <= lastDay; d++) {
    const dateObj = new Date(year, month - 1, d);
    const dateStr = `${year}-${rdmPad2(month)}-${rdmPad2(d)}`;
    const isToday = dateStr === todayStr;
    const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;

    const block = document.createElement("div");
    block.className = `rdm-day-block ${isToday ? "today" : ""} ${isWeekend ? "weekend" : ""}`;
    block.dataset.date = dateStr;

    const label = document.createElement("div");
    label.className = "rdm-day-label";
    label.innerHTML = `<span class="dnum">${rdmPad2(d)}</span><span class="dow">${DOW_SR[dateObj.getDay()]}</span>${isToday ? '<span class="today-badge">Danas</span>' : ""}`;
    block.appendChild(label);

    RDM_SHIFT_TYPES.forEach(st => {
      block.appendChild(rdmBuildShiftBox(dateStr, st, (byDate[dateStr] && byDate[dateStr][st.code]) || [], body, fondCounts, fondTarget));
    });

    frag.appendChild(block);
  }

  const scrollY = window.scrollY;
  body.replaceChildren(frag);
  if (isRefresh) window.scrollTo(0, scrollY);

  rdmApplySearch(document.getElementById("rasporedi-search").value);
}

function rdmBuildShiftBox(dateStr, shiftType, people, body, fondCounts, fondTarget) {
  const box = document.createElement("div");
  box.className = `rdm-shift-box shift-${shiftType.code}`;
  box.dataset.shiftCode = shiftType.code;

  const head = document.createElement("div");
  head.className = "rdm-shift-head";
  head.innerHTML = `<span><span class="shift-icon">${SHIFT_ICON_SVG[shiftType.code] || ""}</span>${shiftType.label} <span class="time">${shiftType.start_time.slice(0,5)}–${shiftType.end_time.slice(0,5)}</span></span>`;
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "rdm-add-btn";
  addBtn.textContent = "+";
  head.appendChild(addBtn);
  box.appendChild(head);

  // Lider na vrhu smene, pa ostali po funkciji; međusmena ide u posebnu kolonu skroz desno.
  const byFunkcija = (a, b) => funkcijaSortValue(a.funkcija) - funkcijaSortValue(b.funkcija);
  const main = people.filter(p => !p.isMS).sort((a, b) => (b.isLeader - a.isLeader) || byFunkcija(a, b));
  const ms = people.filter(p => p.isMS).sort(byFunkcija);
  const leaderP = people.find(p => p.isLeader);
  const msP = people.find(p => p.isMS); // u međusmeni može biti samo 1 radnik
  const hasLeader = !!leaderP;
  // Lider se postavlja samo vikendom/praznikom — radnim danima smenu vodi shift lider po funkciji.
  const leaderAllowed = isHolidayOrWeekendLike(new Date(dateStr + "T00:00:00")) &&
    !people.some(p => p.funkcija === "shift_lider");
  const hasMS = !!msP;
  const rerender = () => rdmRenderMonthBody(body, parseInt(body.parentElement.dataset.year, 10), parseInt(body.parentElement.dataset.month, 10));

  const shiftBody = document.createElement("div");
  shiftBody.className = "rdm-shift-body";
  const mainCol = document.createElement("div");
  mainCol.className = "rdm-main-col";
  shiftBody.appendChild(mainCol);
  if (ms.length) {
    const msCol = document.createElement("div");
    msCol.className = "rdm-ms-col";
    shiftBody.appendChild(msCol);
  }
  box.appendChild(shiftBody);

  [...main, ...ms].forEach(p => {
    const row = document.createElement("div");
    row.className = `rdm-emp-row ${p.isLeader ? "is-leader" : ""} ${p.isMS ? "is-ms" : ""}`;
    row.dataset.name = p.name.toLowerCase();
    row.title = "Desni klik: Lider / Međusmena";
    const dot = p.isLeader ? DOT_LEADER : p.isMS ? DOT_MS : (DOT_BY_FUNKCIJA[p.funkcija] || DOT_BY_FUNKCIJA.radnik);
    row.innerHTML = `
      <span class="dot" style="background:${dot}"></span>
      <span class="nm">${p.name.toUpperCase()}${p.isMS && MS_LABEL[shiftType.code] ? ` <span class="ms-tag">${MS_LABEL[shiftType.code]}</span>` : ""}</span>
      <button type="button" class="rdm-x-btn" title="Ukloni iz smene">✕</button>
    `;

    row.querySelector(".rdm-x-btn").addEventListener("click", async () => {
      const [y, m, d] = dateStr.split("-");
      const ok = await rdmConfirm(
        `Ukloniti <b>${p.name.toUpperCase()}</b> iz smene?`,
        `${shiftType.label} · ${d}.${m}.${y}.`
      );
      if (!ok) return;
      await sb.from("schedule").delete().eq("id", p.scheduleId);
      await rerender();
    });

    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const items = [];
      if (p.isLeader) {
        items.push({ label: "Ukloni lidera", run: () => rdmSetLeader(dateStr, shiftType.code, p.scheduleId, p.employeeId, false) });
      } else if (!leaderAllowed) {
        // radni dan — opcija Lider se ne prikazuje
      } else if (hasLeader) {
        items.push({ label: "Lider", dot: DOT_LEADER, disabled: true, note: leaderP.name.toUpperCase() });
      } else {
        items.push({
          label: "Lider", dot: DOT_LEADER,
          run: async () => {
            if (p.isMS) await sb.from("schedule").update({ is_medju_smena: false }).eq("id", p.scheduleId);
            await rdmSetLeader(dateStr, shiftType.code, p.scheduleId, p.employeeId, true);
          },
        });
      }
      if (MS_LABEL[shiftType.code]) {
        if (p.isMS) {
          items.push({ label: "Ukloni međusmenu", run: () => sb.from("schedule").update({ is_medju_smena: false }).eq("id", p.scheduleId) });
        } else if (hasMS) {
          items.push({ label: `Međusmena (${MS_LABEL[shiftType.code]})`, dot: DOT_MS, disabled: true, note: msP.name.toUpperCase() });
        } else {
          items.push({
            label: `Međusmena (${MS_LABEL[shiftType.code]})`, dot: DOT_MS,
            run: () => sb.from("schedule").update({ is_medju_smena: true, is_leader: false }).eq("id", p.scheduleId),
          });
        }
      }
      rdmOpenContextMenu(ev.clientX, ev.clientY, p.name.toUpperCase(), items, rerender);
    });

    (p.isMS ? shiftBody.querySelector(".rdm-ms-col") : mainCol).appendChild(row);
  });

  addBtn.addEventListener("click", () => {
    const existingInline = box.querySelector(".rdm-add-inline");
    if (existingInline) { existingInline.remove(); return; }
    const presentIds = new Set(people.map(p => p.employeeId));
    const available = RDM_ACTIVE_EMPLOYEES.filter(e => {
      if (presentIds.has(e.id)) return false;
      if (e.funkcija === "radnik") return (fondCounts[e.id] || 0) < fondTarget;
      return true;
    });
    const labelFor = (e) => e.funkcija === "radnik"
      ? `${e.name.toUpperCase()} (${fondCounts[e.id] || 0}/${fondTarget})`
      : e.name.toUpperCase();
    const inline = document.createElement("div");
    inline.className = "rdm-add-inline";
    inline.innerHTML = `<select><option value="">Dodaj...</option>${available.map(e => `<option value="${e.id}">${labelFor(e)}</option>`).join("")}</select>`;
    inline.querySelector("select").addEventListener("change", async (e) => {
      const empId = e.target.value;
      if (!empId) return;
      const { error } = await sb.from("schedule").insert({ date: dateStr, shift_code: shiftType.code, employee_id: empId });
      if (error) {
        rdmShowBanner("Greška: " + error.message, "error");
        return;
      }
      await rdmRenderMonthBody(body, parseInt(body.parentElement.dataset.year, 10), parseInt(body.parentElement.dataset.month, 10));
    });
    box.appendChild(inline);
  });

  return box;
}

// Prozor za potvrdu (Da / Ne). Vraća Promise<boolean>.
function rdmConfirm(message, detail) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true">
        <div class="confirm-msg">${message}</div>
        ${detail ? `<div class="confirm-detail">${detail}</div>` : ""}
        <div class="confirm-actions">
          <button type="button" class="btn btn-ghost" data-v="0">Odustani</button>
          <button type="button" class="btn btn-danger-solid" data-v="1">Ukloni</button>
        </div>
      </div>`;
    const close = (v) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(false); if (e.key === "Enter") close(true); };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
      const b = e.target.closest("button[data-v]");
      if (b) close(b.dataset.v === "1");
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('button[data-v="1"]').focus();
  });
}

// Meni na desni klik (jedan za celu stranicu).
function rdmCloseContextMenu() {
  const old = document.getElementById("rdm-context-menu");
  if (old) old.remove();
}

function rdmOpenContextMenu(x, y, title, items, afterRun) {
  rdmCloseContextMenu();
  const menu = document.createElement("div");
  menu.id = "rdm-context-menu";
  menu.className = "ctx-menu";
  menu.innerHTML = `<div class="ctx-title">${title}</div>` + (items.length
    ? items.map((it, i) => `<button type="button" data-i="${i}" ${it.disabled ? "disabled" : ""}>${it.dot ? `<span class="dot" style="background:${it.dot}"></span>` : '<span class="dot"></span>'}<span>${it.label}${it.note ? `<span class="ctx-note">Već postavljen: ${it.note}</span>` : ""}</span></button>`).join("")
    : '<div class="ctx-empty">Nema dostupnih opcija</div>');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  menu.querySelectorAll("button:not([disabled])").forEach(btn => {
    btn.addEventListener("click", async () => {
      rdmCloseContextMenu();
      await items[parseInt(btn.dataset.i, 10)].run();
      await afterRun();
    });
  });
}

document.addEventListener("click", (e) => { if (!e.target.closest("#rdm-context-menu")) rdmCloseContextMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") rdmCloseContextMenu(); });
window.addEventListener("scroll", rdmCloseContextMenu, true);

async function rdmLoadAllMonths() {
  const container = document.getElementById("rasporedi-months");
  // Ponovno učitavanje (npr. posle zamene): zapamti koji su meseci otvoreni i gde je stranica,
  // stari prikaz ostaje dok se novi ne napravi.
  const existing = [...container.querySelectorAll(".rdm-month-wrap")];
  const isRefresh = existing.length > 0;
  const openState = new Map(existing.map(w => [
    `${w.dataset.year}-${w.dataset.month}`,
    w.lastElementChild && w.lastElementChild.style.display !== "none",
  ]));
  if (!isRefresh) container.innerHTML = '<div class="empty-note muted">Učitavanje...</div>';

  await rdmLoadStaticData();

  const now = new Date();
  const currentY = now.getFullYear();
  const currentM = now.getMonth() + 1;

  const { data: futureDates } = await sb
    .from("schedule")
    .select("date")
    .gte("date", `${currentY}-${rdmPad2(currentM)}-01`)
    .order("date");

  const monthsSet = new Map();
  monthsSet.set(`${currentY}-${currentM}`, { year: currentY, month: currentM });
  (futureDates || []).forEach(row => {
    const [y, m] = row.date.split("-").map(Number);
    const key = `${y}-${m}`;
    if (!monthsSet.has(key)) monthsSet.set(key, { year: y, month: m });
  });

  const months = [...monthsSet.values()].sort((a, b) => a.year - b.year || a.month - b.month);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < months.length; i++) {
    const key = `${months[i].year}-${months[i].month}`;
    const collapsed = openState.has(key) ? !openState.get(key) : i !== 0;
    frag.appendChild(await rdmRenderMonth(months[i].year, months[i].month, collapsed));
  }
  const scrollY = window.scrollY;
  container.replaceChildren(frag);
  if (isRefresh) window.scrollTo(0, scrollY);

  rdmPopulateReplaceSelects();
}

function rdmPopulateReplaceSelects() {
  const opts = `<option value="">Izaberite...</option>` + RDM_ACTIVE_EMPLOYEES.map(e => `<option value="${e.id}">${e.name.toUpperCase()}</option>`).join("");
  document.getElementById("rep-emp1").innerHTML = opts;
  document.getElementById("rep-emp2").innerHTML = opts;
}

async function rdmHandleReplace() {
  const date = document.getElementById("rep-date").value;
  const emp1 = document.getElementById("rep-emp1").value;
  const emp2 = document.getElementById("rep-emp2").value;

  if (!date || !emp1 || !emp2 || emp1 === emp2) {
    rdmShowBanner("Popunite datum i dva različita zaposlena.", "error");
    return;
  }

  const { data: rows, error: fetchErr } = await sb
    .from("schedule")
    .select("id")
    .eq("date", date)
    .eq("employee_id", emp1);

  if (fetchErr) {
    rdmShowBanner("Greška: " + fetchErr.message, "error");
    return;
  }
  if (!rows.length) {
    rdmShowBanner("Prvi zaposleni nema smenu tog dana.", "error");
    return;
  }

  let errorCount = 0;
  for (const row of rows) {
    const { error } = await sb.from("schedule").update({ employee_id: emp2 }).eq("id", row.id);
    if (error) errorCount++;
  }

  if (errorCount) {
    rdmShowBanner(`Zamena delimično uspela, ${errorCount} grešaka (verovatno drugi zaposleni već ima tu smenu).`, "error");
  } else {
    rdmShowBanner("Zamena uspešna.", "success");
  }

  await rdmLoadAllMonths();
}

function rdmApplySearch(term) {
  const t = term.trim().toLowerCase();
  let count = 0;
  document.querySelectorAll("#rasporedi-months .rdm-emp-row").forEach(row => {
    const match = !t || row.dataset.name === t;
    row.classList.toggle("search-hit", !!t && match);
    if (t && match && row.offsetParent !== null) count++;
  });

  // Obeleži dane kad traženi radnik NE RADI (nema ni jednu smenu tog dana) drugom bojom.
  document.querySelectorAll("#rasporedi-months .rdm-day-block").forEach(block => {
    const hasMatch = !t || block.querySelector(`.rdm-emp-row[data-name="${t}"]`);
    block.classList.toggle("rdm-day-off-for-search", !!t && !hasMatch);
  });

  const info = document.getElementById("rasporedi-search-info");
  if (info) {
    if (!t) info.textContent = "";
    else if (count) info.textContent = `${term.trim().toUpperCase()}: ${count} smena u prikazanim (otvorenim) mesecima`;
    else info.textContent = "Nema rezultata u otvorenim mesecima";
  }
}

document.addEventListener("admin-ready", () => {
  document.getElementById("rep-btn").addEventListener("click", rdmHandleReplace);
  document.getElementById("rasporedi-search").addEventListener("input", (e) => rdmApplySearch(e.target.value));

  rdmLoadAllMonths();
});
