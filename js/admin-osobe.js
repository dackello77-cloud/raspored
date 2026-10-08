const FUNKCIJA_LABELS = {
  administrator: "Administrator",
  management: "Management",
  shift_lider: "Shift lider",
  radnik: "Radnik",
  monitoring: "Monitoring",
};

function optionsHTML(options, selected) {
  return options
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function showBanner(message, type) {
  const box = document.getElementById("osobe-banner");
  box.innerHTML = `<div class="banner ${type}">${message}</div>`;
  if (type === "success") setTimeout(() => { box.innerHTML = ""; }, 8000);
}

async function fetchEmployeesWithVacations() {
  const { data: employees, error } = await sb
    .from("employees")
    .select("id, funkcija, monitoring_smena, slava_date, active, profile_id, profiles(*)")
    .order("created_at");
  if (error) {
    console.error(error);
    return [];
  }
  const ids = employees.map(e => e.id);
  let vacationsByEmp = {};
  if (ids.length) {
    const { data: vacations } = await sb
      .from("vacations")
      .select("*")
      .in("employee_id", ids)
      .order("start_date", { ascending: false });
    (vacations || []).forEach(v => {
      if (!vacationsByEmp[v.employee_id]) vacationsByEmp[v.employee_id] = v;
    });
  }
  // Registrovani telefon (sql/migration_013_device_binding.sql) — greška = SQL još nije pokrenut.
  const { data: devices } = await sb.from("user_devices").select("*");
  const deviceByProfile = {};
  (devices || []).forEach(d => { deviceByProfile[d.profile_id] = d; });
  return employees.map(e => ({ ...e, vacation: vacationsByEmp[e.id] || null, device: deviceByProfile[e.profile_id] || null }));
}

function osobeShortDate(ts) {
  const d = new Date(ts);
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}.`;
}
// Red ispod korisničkog imena: koji telefon je vezan i da li je bilo pokušaja sa drugog.
function deviceLineHtml(emp) {
  if (!emp.profiles || emp.profiles.role !== "worker") return "";
  const d = emp.device;
  if (!d) return `<div class="emp-device muted">📱 telefon još nije vezan</div>`;
  const blocked = d.blocked_at && new Date(d.blocked_at) > new Date(d.registered_at)
    ? `<div class="emp-device warn">⚠ pokušaj sa drugog telefona ${osobeShortDate(d.blocked_at)}: ${zmSafe(d.blocked_label)}</div>` : "";
  return `<div class="emp-device">📱 ${zmSafe(d.label || "telefon")}</div>${blocked}`;
}
function zmSafe(s) { return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

// Oznake pored imena: Administrator / Management (uloga) i HR (dodatak, ne menja funkciju).
function roleTagsHtml(p) {
  if (!p) return "";
  let html = "";
  if (p.role === "admin") html += '<span class="role-tag role-tag-admin">Admin</span>';
  if (p.role === "management") html += '<span class="role-tag role-tag-mgmt">Management</span>';
  if (p.hr_manager) html += '<span class="role-tag role-tag-hr">HR</span>';
  return html;
}

// Uloga za prijavu -> funkcija u tabeli zaposlenih (admin i management nisu u rasporedu).
function funkcijaForRole(role, current) {
  if (role === "admin") return "administrator";
  if (role === "management") return "management";
  return current === "administrator" || current === "management" ? "radnik" : current;
}

function buildEmployeeRow(emp) {
  const row = document.createElement("div");
  row.className = "emp-row";
  row.dataset.employeeId = emp.id;
  if (!emp.active) row.dataset.inactive = "1";
  if (emp.vacation) row.dataset.vacationId = emp.vacation.id;

  const name = (emp.profiles?.full_name || "").toUpperCase();
  const username = emp.profiles?.username || "";

  row.innerHTML = `
    <div>
      <div class="emp-name">${name}${roleTagsHtml(emp.profiles)}</div>
      <div class="emp-username">${username}</div>
      <div class="emp-device-wrap">${deviceLineHtml(emp)}</div>
    </div>
    <div>
      <select class="f-funkcija">${optionsHTML(Object.entries(FUNKCIJA_LABELS), emp.funkcija)}</select>
    </div>
    <div>
      <select class="f-monitoring">
        <option value="">—</option>
        ${optionsHTML([["I", "Monitoring I"], ["II", "Monitoring II"], ["III", "Monitoring III"]], emp.monitoring_smena || "")}
      </select>
    </div>
    <div class="field-slava">
      <input type="date" class="f-slava" value="${emp.slava_date || ""}" />
    </div>
    <div class="field-odmor">
      <input type="date" class="f-odmor-od" value="${emp.vacation ? emp.vacation.start_date : ""}" />
    </div>
    <div class="field-odmor">
      <select class="f-trajanje">
        <option value="1" ${emp.vacation && emp.vacation.weeks === 1 ? "selected" : ""}>1 nedelja</option>
        <option value="2" ${!emp.vacation || emp.vacation.weeks === 2 ? "selected" : ""}>2 nedelje</option>
      </select>
    </div>
    <div class="field-odmor">
      <input type="date" class="f-odmor-do" value="${emp.vacation ? emp.vacation.end_date : ""}" disabled />
    </div>
    <div class="active-col">
      <input type="checkbox" class="f-active" ${emp.active ? "checked" : ""} />
      Aktivan
    </div>
    <div class="emp-actions">
      <button type="button" class="btn btn-ghost f-uredi">Uredi</button>
      <button type="button" class="btn btn-danger f-ukloni">Ukloni</button>
    </div>
  `;

  syncAllDateInputs(row);

  const odmorOd = row.querySelector(".f-odmor-od");
  const trajanje = row.querySelector(".f-trajanje");
  const odmorDo = row.querySelector(".f-odmor-do");

  function recalcEnd() {
    if (odmorOd.value) {
      odmorDo.value = addDays(odmorOd.value, parseInt(trajanje.value, 10) * 7 - 1);
    } else {
      odmorDo.value = "";
    }
    syncDateInputVisual(odmorDo);
  }
  odmorOd.addEventListener("change", recalcEnd);
  trajanje.addEventListener("change", recalcEnd);

  row.querySelector(".f-uredi").addEventListener("click", () => openEditPersonDialog(emp, row));

  row.querySelector(".f-ukloni").addEventListener("click", async () => {
    if (!confirm(`Ukloniti (deaktivirati) ${name}?`)) return;
    const { error } = await sb.from("employees").update({ active: false }).eq("id", emp.id);
    if (error) {
      showBanner("Greška pri uklanjanju: " + error.message, "error");
      return;
    }
    row.querySelector(".f-active").checked = false;
    row.dataset.inactive = "1";
    osobeUpdateInactiveCount();
    showBanner(`${name} je deaktiviran.`, "success");
  });

  return row;
}

async function loadEmployees() {
  osobeDirty = false;
  const list = document.getElementById("employees-list");
  list.innerHTML = '<div class="empty-note muted">Učitavanje...</div>';
  const employees = await fetchEmployeesWithVacations();
  list.innerHTML = "";
  if (!employees.length) {
    list.innerHTML = '<div class="empty-note muted">Nema osoba u sistemu.</div>';
    return;
  }
  employees.forEach(emp => list.appendChild(buildEmployeeRow(emp)));
  osobeUpdateInactiveCount();
}

// "Uredi" — ime, korisničko ime, rola i nova lozinka. Ime i rola idu direktno u profiles;
// korisničko ime i lozinka su deo login naloga pa idu kroz funkciju admin_update_login
// (sql/migration_004_admin_edit_login.sql).
function openEditPersonDialog(emp, row) {
  const p = emp.profiles || {};
  document.getElementById("edit-person-dialog")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "edit-person-dialog";
  overlay.className = "pw-overlay";
  overlay.innerHTML = `
    <form class="pw-box" novalidate>
      <h3>Uredi osobu</h3>
      <label>Ime i prezime<input type="text" name="fullName" required /></label>
      <label>Korisničko ime (za prijavu)<input type="text" name="username" autocomplete="off" required /></label>
      <label>Rola
        <select name="role">
          <option value="worker">Radnik</option>
          <option value="admin">Administrator</option>
          <option value="management">Management</option>
        </select>
      </label>
      <label class="pw-check"><input type="checkbox" name="hr" /> HR manager</label>
      <div class="pw-hint">HR se dodaje uz postojeću ulogu — funkcija u rasporedu ostaje ista.</div>
      <label>Nova lozinka<input type="text" name="password" autocomplete="off" placeholder="Prazno = lozinka se ne menja" /></label>
      ${p.role === "worker" ? `<div class="pw-device">
        <div class="field-label" style="margin:0 0 4px;">Telefon</div>
        <div class="pw-device-info">${emp.device ? `📱 ${zmSafe(emp.device.label)}<br><span class="muted">vezan od ${osobeShortDate(emp.device.registered_at)}</span>` : '<span class="muted">Telefon još nije vezan — vezaće se pri prvoj prijavi sa telefona.</span>'}</div>
        ${emp.device ? `<button type="button" class="btn btn-danger pw-device-remove">Ukloni telefon</button>
        <div class="pw-hint">Posle uklanjanja, prvi telefon sa kog se prijavi postaje njegov novi telefon.</div>` : ""}
      </div>` : ""}
      <div class="pw-msg"></div>
      <div class="pw-actions">
        <button type="button" class="btn btn-ghost pw-cancel">Otkaži</button>
        <button type="submit" class="btn btn-primary pw-save">Sačuvaj</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("form");
  form.fullName.value = p.full_name || "";
  form.username.value = p.username || "";
  form.role.value = p.role || "worker";
  form.hr.checked = !!p.hr_manager;
  const msg = overlay.querySelector(".pw-msg");
  const show = (text, ok) => { msg.textContent = text; msg.className = `pw-msg ${ok ? "ok" : "err"}`; };
  const close = () => overlay.remove();
  overlay.querySelector(".pw-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

  const removeBtn = overlay.querySelector(".pw-device-remove");
  if (removeBtn) removeBtn.addEventListener("click", async () => {
    if (!confirm(`Ukloniti telefon za ${(p.full_name || "").toUpperCase()}? Sledeći telefon sa kog se prijavi biće njegov.`)) return;
    removeBtn.disabled = true;
    const { error } = await sb.from("user_devices").delete().eq("profile_id", emp.profile_id);
    if (error) { removeBtn.disabled = false; return show("Greška: " + error.message); }
    emp.device = null;
    row.querySelector(".emp-device-wrap").innerHTML = deviceLineHtml(emp);
    overlay.querySelector(".pw-device-info").innerHTML = '<span class="muted">Telefon je uklonjen — novi će se vezati pri sledećoj prijavi.</span>';
    removeBtn.nextElementSibling?.remove();
    removeBtn.remove();
    show("Telefon je uklonjen.", true);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fullName = form.fullName.value.trim();
    const username = form.username.value.trim().toLowerCase();
    const role = form.role.value;
    const hr = form.hr.checked;
    const password = form.password.value;
    if (!fullName || !username) return show("Ime i korisničko ime su obavezni.");
    if (!/^[a-z0-9._-]+$/.test(username)) return show("Korisničko ime: samo mala slova, brojevi, tačka, crtica i donja crta.");
    if (password && password.length < 6) return show("Lozinka mora imati bar 6 znakova.");
    if (ADMIN_PROFILE && emp.profile_id === ADMIN_PROFILE.id && role !== "admin") {
      return show("Ne možeš sebi da skineš ulogu administratora.");
    }

    const saveBtn = form.querySelector(".pw-save");
    saveBtn.disabled = true;

    if (fullName !== p.full_name || role !== p.role || hr !== !!p.hr_manager) {
      const update = { full_name: fullName, role };
      if (hr !== !!p.hr_manager) update.hr_manager = hr;
      const { error } = await sb.from("profiles").update(update).eq("id", emp.profile_id);
      if (error) {
        saveBtn.disabled = false;
        const missing = /hr_manager|profiles_role_check/.test(error.message);
        return show(missing
          ? "Za Management i HR prvo treba jednom pokrenuti SQL iz fajla sql/migration_005_management_hr.sql u Supabase."
          : "Greška: " + error.message);
      }
      p.full_name = fullName;
      p.hr_manager = hr;
      if (role !== p.role) {
        p.role = role;
        // Admin/Management izlaze iz rasporeda, povratak u Radnika vraća funkciju Radnik.
        const funkcija = funkcijaForRole(role, emp.funkcija);
        if (funkcija !== emp.funkcija) {
          const { error: fErr } = await sb.from("employees").update({ funkcija }).eq("id", emp.id);
          if (fErr) { saveBtn.disabled = false; return show("Greška: " + fErr.message); }
          emp.funkcija = funkcija;
          row.querySelector(".f-funkcija").value = funkcija;
        }
      }
    }

    const usernameChanged = username !== p.username;
    if (usernameChanged || password) {
      const { error } = await sb.rpc("admin_update_login", {
        p_profile_id: emp.profile_id,
        p_username: usernameChanged ? username : null,
        p_password: password || null,
      });
      if (error) {
        saveBtn.disabled = false;
        const missing = error.code === "PGRST202" || /admin_update_login/.test(error.message);
        return show(missing
          ? "Ime i rola su sačuvani, ali za korisničko ime i lozinku prvo treba jednom pokrenuti SQL iz fajla sql/migration_004_admin_edit_login.sql u Supabase."
          : "Greška: " + error.message);
      }
      if (usernameChanged) p.username = username;
    }

    row.querySelector(".emp-name").innerHTML = p.full_name.toUpperCase() + roleTagsHtml(p);
    row.querySelector(".emp-username").textContent = p.username;
    showBanner(`${p.full_name.toUpperCase()} je sačuvan${password ? " (nova lozinka: " + password + ")" : ""}.`, "success");
    close();
  });
  form.fullName.focus();
}

// Prekidač "Prikaži i neaktivne" — podrazumevano se vide samo aktivni.
function osobeUpdateInactiveCount() {
  const n = document.querySelectorAll("#employees-list .emp-row[data-inactive]").length;
  const el = document.getElementById("show-inactive-count");
  if (el) el.textContent = n ? `(${n})` : "";
}

document.getElementById("show-inactive").addEventListener("change", (e) => {
  document.getElementById("employees-list").classList.toggle("show-inactive", e.target.checked);
});

async function handleAddPerson(e) {
  e.preventDefault();
  const btn = document.getElementById("add-person-btn");
  const fullName = document.getElementById("new-full-name").value.trim();
  const usernameRaw = document.getElementById("new-username").value.trim();
  const role = document.getElementById("new-role").value;

  if (!fullName || !usernameRaw) return;

  const username = usernameRaw.toLowerCase();
  btn.disabled = true;
  btn.textContent = "Dodavanje...";

  const email = usernameToEmail(username);
  const password = generateTempPassword();

  const { data: signUpData, error: signUpError } = await sbAdminTemp.auth.signUp({ email, password });

  if (signUpError || !signUpData.user) {
    showBanner("Greška pri kreiranju naloga: " + (signUpError ? signUpError.message : "nepoznata greška"), "error");
    btn.disabled = false;
    btn.textContent = "Dodaj osobu";
    return;
  }

  const userId = signUpData.user.id;

  const { error: profileError } = await sb
    .from("profiles")
    .insert({ id: userId, full_name: fullName, username, role });

  if (profileError) {
    showBanner("Greška pri upisu profila: " + profileError.message, "error");
    btn.disabled = false;
    btn.textContent = "Dodaj osobu";
    return;
  }

  const { error: empError } = await sb
    .from("employees")
    .insert({ profile_id: userId, funkcija: funkcijaForRole(role, "radnik"), active: true });

  if (empError) {
    showBanner("Greška pri upisu zaposlenog: " + empError.message, "error");
    btn.disabled = false;
    btn.textContent = "Dodaj osobu";
    return;
  }

  showBanner(
    `Osoba <strong>${fullName}</strong> dodata. Korisničko ime: <strong>${username}</strong>, privremena lozinka: <strong>${password}</strong> — prenesite radniku da je promeni pri prvoj prijavi.`,
    "success"
  );
  document.getElementById("add-person-form").reset();
  await loadEmployees();

  btn.disabled = false;
  btn.textContent = "Dodaj osobu";
}

// Ima li nesačuvanih izmena u listi osoba (menja se na svaku izmenu polja).
let osobeDirty = false;

async function osobeSaveIfDirty() {
  if (osobeDirty) await handleSaveChanges();
}

async function handleSaveChanges() {
  const btn = document.getElementById("save-changes-btn");
  btn.disabled = true;
  btn.textContent = "Čuvanje...";

  const rows = document.querySelectorAll("#employees-list .emp-row");
  const errors = [];

  for (const row of rows) {
    const employeeId = row.dataset.employeeId;
    const funkcija = row.querySelector(".f-funkcija").value;
    const monitoring_smena = row.querySelector(".f-monitoring").value || null;
    const slava_date = row.querySelector(".f-slava").value || null;
    const active = row.querySelector(".f-active").checked;
    const odmorOd = row.querySelector(".f-odmor-od").value;
    const odmorDo = row.querySelector(".f-odmor-do").value;
    const weeks = parseInt(row.querySelector(".f-trajanje").value, 10);

    const { error: empError } = await sb
      .from("employees")
      .update({ funkcija, monitoring_smena, slava_date, active })
      .eq("id", employeeId);
    if (empError) errors.push(empError.message);
    // Deaktivirani nestaju iz liste (kad je prikaz "samo aktivni") tek posle čuvanja.
    else if (active) delete row.dataset.inactive;
    else row.dataset.inactive = "1";

    const vacationId = row.dataset.vacationId;
    if (odmorOd) {
      if (vacationId) {
        const { error } = await sb
          .from("vacations")
          .update({ start_date: odmorOd, weeks, end_date: odmorDo })
          .eq("id", vacationId);
        if (error) errors.push(error.message);
      } else {
        const { data, error } = await sb
          .from("vacations")
          .insert({ employee_id: employeeId, start_date: odmorOd, weeks, end_date: odmorDo })
          .select()
          .single();
        if (error) errors.push(error.message);
        else row.dataset.vacationId = data.id;
      }
    } else if (vacationId) {
      const { error } = await sb.from("vacations").delete().eq("id", vacationId);
      if (error) errors.push(error.message);
      else delete row.dataset.vacationId;
    }
  }

  osobeUpdateInactiveCount();
  if (errors.length) {
    showBanner("Neke izmene nisu sačuvane: " + errors.join("; "), "error");
  } else {
    showBanner("Izmene sačuvane.", "success");
    osobeDirty = false;
  }

  btn.disabled = false;
  btn.textContent = "Sačuvaj izmene";
}

document.addEventListener("admin-ready", async () => {
  document.getElementById("add-person-form").addEventListener("submit", handleAddPerson);
  document.getElementById("save-changes-btn").addEventListener("click", handleSaveChanges);
  const list = document.getElementById("employees-list");
  list.addEventListener("input", () => { osobeDirty = true; });
  list.addEventListener("change", () => { osobeDirty = true; });
  await loadEmployees();
  osobeDirty = false;
});
