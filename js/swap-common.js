// Zajednički delovi za zahteve zaposlenih (stranice Raspored i Zamene):
//   - zamena smene sa drugim radnikom (kind 'swap': radnik -> drugi radnik -> HR)
//   - slobodan dan (kind 'day_off': zaposleni -> HR)
// Meni na desni klik, prozori za slanje, prikaz zahteva i dugmad (prihvati/odbij/odobri).
// Sva pravila proverava baza — sql/migration_006_swap_requests.sql i 007_day_off_requests.sql.

const ZM_STATUS = {
  pending_worker: "Čeka potvrdu radnika",
  rejected_worker: "Radnik odbio",
  pending_hr: "Čeka HR",
  rejected_hr: "HR odbio",
  approved: "Odobreno",
  cancelled: "Otkazano",
};

function zmFmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  const dow = ["Nedelja", "Ponedeljak", "Utorak", "Sreda", "Četvrtak", "Petak", "Subota"][d.getDay()];
  return `${dow}, ${d.getDate()}. ${MONTH_NAMES_SR[d.getMonth()]} ${d.getFullYear()}.`;
}
function zmShift(code) {
  return `<span class="shift-badge s-${code}">${code}</span>`;
}
function zmEsc(s) {
  return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Imena zaposlenih: names[employeeId] i names["p:" + profileId].
async function zmFetchNames() {
  const { data } = await sb.from("employees").select("id, profile_id, funkcija, profiles(full_name)");
  const names = {};
  (data || []).forEach(e => {
    const n = (e.profiles?.full_name || "").toUpperCase();
    names[e.id] = n;
    names["p:" + e.profile_id] = n;
  });
  return { names, employees: data || [] };
}

// ---------- Prikaz jednog zahteva ----------
const ZM_ACTIONS = {
  incoming: `<div class="zm-actions">
      <button type="button" class="btn btn-primary zm-accept">Prihvatam</button>
      <button type="button" class="btn btn-danger zm-decline">Odbijam</button>
    </div>`,
  hr: `<div class="zm-actions">
      <input type="text" class="zm-hr-comment" placeholder="Komentar (nije obavezno)" />
      <button type="button" class="btn btn-primary zm-approve">Odobri</button>
      <button type="button" class="btn btn-danger zm-reject">Odbij</button>
    </div>`,
  cancel: `<div class="zm-actions"><button type="button" class="btn btn-ghost zm-cancel">Otkaži zahtev</button></div>`,
};

function zmItemHtml(r, names, actions) {
  const a = names[r.requester_id] || "?";
  const b = names[r.target_id] || "?";
  const dayOff = r.kind === "day_off";
  const meta = [`Poslato ${new Date(r.created_at).toLocaleString("sr-RS", { dateStyle: "short", timeStyle: "short" })}`];
  if (!dayOff && r.worker_responded_at && r.status !== "rejected_worker") meta.push(`${b} potvrdio/la`);
  if (r.hr_responded_at && names["p:" + r.hr_profile_id]) meta.push(`HR: ${names["p:" + r.hr_profile_id]}`);
  return `
    <div class="zm-item" data-id="${r.id}">
      <div class="zm-item-head">
        <span class="zm-date"><span class="zm-kind ${dayOff ? "zm-kind-off" : ""}">${dayOff ? "Slobodan dan" : "Zamena"}</span>${zmFmtDate(r.date)}</span>
        <span class="zm-status st-${r.status}">${ZM_STATUS[r.status] || r.status}</span>
      </div>
      <div class="zm-swap">${dayOff
        ? `${a} ${zmShift(r.requester_shift)} → slobodan`
        : `${a} ${zmShift(r.requester_shift)} ⇄ ${b} ${zmShift(r.target_shift)}`}</div>
      <div class="zm-reason"><b>Razlog:</b> ${zmEsc(r.reason)}</div>
      ${r.hr_comment ? `<div class="zm-reason"><b>Komentar HR:</b> ${zmEsc(r.hr_comment)}</div>` : ""}
      <div class="zm-meta">${meta.join(" · ")}</div>
      ${actions || ""}
    </div>`;
}

// Stranica postavlja: zmOnDone(message, isError) — prikaz poruke i ponovno učitavanje.
let zmOnDone = (msg, isError) => { if (isError) alert(msg); };

async function zmRun(promise, okText) {
  const { error } = await promise;
  await zmOnDone(error ? error.message : okText, !!error);
  if (typeof zmRefreshNavBadge === "function") zmRefreshNavBadge();
}

// Dugmad u zahtevima (delegirano — radi i za kasnije nacrtane zahteve).
document.addEventListener("click", (e) => {
  const item = e.target.closest(".zm-item");
  if (!item || !e.target.closest("button")) return;
  const id = item.dataset.id;
  if (e.target.closest(".zm-cancel")) {
    if (confirm("Otkazati ovaj zahtev za zamenu?")) zmRun(sb.rpc("swap_request_cancel", { p_id: id }), "Zahtev je otkazan.");
  } else if (e.target.closest(".zm-accept")) {
    zmRun(sb.rpc("swap_request_respond", { p_id: id, p_accept: true }), "Potvrđeno — zahtev ide HR manageru na odobrenje.");
  } else if (e.target.closest(".zm-decline")) {
    if (confirm("Odbiti zamenu?")) zmRun(sb.rpc("swap_request_respond", { p_id: id, p_accept: false }), "Zamena je odbijena.");
  } else if (e.target.closest(".zm-approve") || e.target.closest(".zm-reject")) {
    const approve = !!e.target.closest(".zm-approve");
    const comment = item.querySelector(".zm-hr-comment").value;
    zmRun(sb.rpc("swap_request_hr_decide", { p_id: id, p_approve: approve, p_comment: comment || null }),
      approve ? "Zamena je odobrena i raspored je promenjen." : "Zamena je odbijena.");
  }
});

// ---------- Meni na desni klik ----------
function zmCloseMenu() {
  document.getElementById("zm-menu")?.remove();
}
function zmOpenMenu(x, y, title, items) {
  zmCloseMenu();
  const menu = document.createElement("div");
  menu.id = "zm-menu";
  menu.className = "ctx-menu";
  menu.innerHTML = `<div class="ctx-title">${zmEsc(title)}</div>` + items.map((it, i) =>
    `<button type="button" data-i="${i}" ${it.disabled ? "disabled" : ""}><span>${it.label}${it.note ? `<span class="ctx-note">${zmEsc(it.note)}</span>` : ""}</span></button>`
  ).join("");
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  menu.querySelectorAll("button:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => { zmCloseMenu(); items[Number(btn.dataset.i)].run(); });
  });
}
document.addEventListener("click", (e) => { if (!e.target.closest("#zm-menu")) zmCloseMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") zmCloseMenu(); });
window.addEventListener("scroll", zmCloseMenu, true);

// ---------- Prozor: slobodan dan ----------
function zmOpenDayOffDialog(date, shift) {
  document.getElementById("zm-dialog")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "zm-dialog";
  overlay.className = "pw-overlay";
  overlay.innerHTML = `
    <form class="pw-box" novalidate>
      <h3>Slobodan dan</h3>
      <div class="zm-date">${zmFmtDate(date)}</div>
      <div class="zm-swap">Tvoja smena ${zmShift(shift)} → slobodan</div>
      <div class="muted" style="font-size:12px;">Zahtev ide direktno HR manageru na odobrenje.</div>
      <label>Razlog<textarea name="reason" placeholder="Npr. porodične obaveze" required></textarea></label>
      <div class="pw-msg"></div>
      <div class="pw-actions">
        <button type="button" class="btn btn-ghost pw-cancel">Otkaži</button>
        <button type="submit" class="btn btn-primary pw-save" disabled>Pošalji</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("form");
  const msg = overlay.querySelector(".pw-msg");
  const save = form.querySelector(".pw-save");
  const close = () => overlay.remove();
  overlay.querySelector(".pw-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  form.reason.addEventListener("input", () => { save.disabled = !form.reason.value.trim(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = form.reason.value.trim();
    if (!reason) return;
    save.disabled = true;
    const { error } = await sb.rpc("dayoff_request_create", { p_date: date, p_reason: reason });
    if (error) {
      msg.className = "pw-msg err";
      msg.textContent = /dayoff_request_create/.test(error.message)
        ? "Slobodni dani još nisu uključeni — treba jednom pokrenuti SQL iz fajla sql/migration_007_day_off_requests.sql u Supabase."
        : error.message;
      save.disabled = false;
      return;
    }
    close();
    await zmOnDone("Zahtev za slobodan dan je poslat HR manageru.", false);
    if (typeof zmRefreshNavBadge === "function") zmRefreshNavBadge();
  });
  form.reason.focus();
}

// ---------- Prozor: nova zamena ----------
// me / target: { id, name, shift }
function zmOpenSwapDialog(date, me, target) {
  document.getElementById("zm-dialog")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "zm-dialog";
  overlay.className = "pw-overlay";
  overlay.innerHTML = `
    <form class="pw-box" novalidate>
      <h3>Zamena smene</h3>
      <div class="zm-date">${zmFmtDate(date)}</div>
      <div class="zm-swap">Ti ${zmShift(me.shift)} → ${zmShift(target.shift)} · ${zmEsc(target.name)} ${zmShift(target.shift)} → ${zmShift(me.shift)}</div>
      <div class="zm-check">Provera pravila...</div>
      <label>Razlog zamene<textarea name="reason" placeholder="Npr. lekarski pregled ujutru" required></textarea></label>
      <div class="pw-msg"></div>
      <div class="pw-actions">
        <button type="button" class="btn btn-ghost pw-cancel">Otkaži</button>
        <button type="submit" class="btn btn-primary pw-save" disabled>Pošalji</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("form");
  const check = overlay.querySelector(".zm-check");
  const msg = overlay.querySelector(".pw-msg");
  const save = form.querySelector(".pw-save");
  let ruleOk = false;
  const refresh = () => { save.disabled = !(ruleOk && form.reason.value.trim()); };
  const close = () => overlay.remove();
  overlay.querySelector(".pw-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  form.reason.addEventListener("input", refresh);

  // Provera odmah, pre slanja drugom radniku (isto pravilo kao pri slanju i odobrenju).
  sb.rpc("swap_precheck", { p_date: date, p_target: target.id }).then(({ data, error }) => {
    if (error) {
      check.className = "zm-check err";
      check.textContent = /swap_precheck/.test(error.message)
        ? "Zamene još nisu uključene — treba jednom pokrenuti SQL iz fajla sql/migration_006_swap_requests.sql u Supabase."
        : error.message;
    } else if (data) {
      check.className = "zm-check err";
      check.textContent = "Zamena nije moguća: " + data;
    } else {
      ruleOk = true;
      check.className = "zm-check ok";
      check.textContent = "Pravila su u redu — upiši razlog i pošalji.";
    }
    refresh();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = form.reason.value.trim();
    if (!ruleOk || !reason) return;
    save.disabled = true;
    const { error } = await sb.rpc("swap_request_create", { p_date: date, p_target: target.id, p_reason: reason });
    if (error) {
      msg.className = "pw-msg err";
      msg.textContent = error.message;
      save.disabled = false;
      return;
    }
    close();
    await zmOnDone(`Zahtev je poslat — ${target.name} treba da ga potvrdi.`, false);
    if (typeof zmRefreshNavBadge === "function") zmRefreshNavBadge();
  });
  form.reason.focus();
}
