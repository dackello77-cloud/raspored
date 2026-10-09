// Stranica "Zamene" → kartica "Bolovanje" (samo HR manager i admin).
// HR upisuje zaposlenog i period od–do; raspored se ne menja, a na Rasporedu i u Dolascima
// ti dani su označeni kao bolovanje (sql/migration_015_sick_leave.sql, pomoćne funkcije u constants.js).

const SL = { names: {} };

function slToday() { return officeIso(belgradeNow()); }
function slMsg(text, isErr) {
  const msg = document.getElementById("sl-msg");
  msg.textContent = text || "";
  msg.className = "zm-office-msg" + (isErr ? " err" : "");
}
function slError(error) {
  return /sick_leave/.test(error.message) && /exist|schema cache/.test(error.message)
    ? "Bolovanje još nije uključeno — treba jednom pokrenuti SQL iz fajla sql/migration_015_sick_leave.sql u Supabase."
    : error.message;
}

async function slLoadList() {
  const box = document.getElementById("sl-list");
  const today = slToday();
  const from = officeIso(new Date(Date.now() - 60 * 86400000));
  const { data, error } = await sb.from("sick_leave").select("id, employee_id, date_from, date_to, note")
    .gte("date_to", from).order("date_from", { ascending: false });
  if (error) { box.innerHTML = `<div class="zm-empty">${zmEsc(slError(error))}</div>`; return; }
  if (!data.length) { box.innerHTML = '<div class="zm-empty">Nema upisanih bolovanja.</div>'; return; }
  box.innerHTML = data.map(r => {
    const days = sickDaysIn(r, r.date_from, r.date_to);
    const state = r.date_to < today ? ["", "Završeno"] : r.date_from > today ? ["", "Počinje"] : ["now", "U toku"];
    return `<div class="sl-item" data-id="${r.id}">
      <div class="sl-head"><b>${zmEsc(SL.names[r.employee_id] || "—")}</b><span class="sl-badge ${state[0]}">${state[1]}</span></div>
      <div class="sl-meta">${sickFmt(r.date_from)} – ${sickFmt(r.date_to)} · ${days} ${days === 1 ? "dan" : "dana"}${r.note ? ` · ${zmEsc(r.note)}` : ""}</div>
      <div class="sl-edit">
        <label>Do <input type="date" class="sl-edit-to" value="${r.date_to}" min="${r.date_from}" /></label>
        <button type="button" class="btn btn-ghost sl-save" hidden>Sačuvaj</button>
        <button type="button" class="btn btn-danger sl-del">Obriši</button>
      </div>
    </div>`;
  }).join("");
}

// Kontrole se kače odmah; podaci se učitavaju tek kad zamene.js utvrdi da je korisnik HR (slInit).
(() => {
  const form = document.getElementById("sl-form");
  const emp = document.getElementById("sl-emp");
  const from = document.getElementById("sl-from");
  const to = document.getElementById("sl-to");
  const note = document.getElementById("sl-note");
  const send = document.getElementById("sl-send");
  const sync = () => {
    slMsg("");
    if (from.value) to.min = from.value;
    if (from.value && to.value && to.value < from.value) slMsg("Kraj ne može biti pre početka.", true);
    send.disabled = !(emp.value && from.value && to.value && to.value >= from.value);
  };
  [emp, from, to].forEach(el => el.addEventListener("input", sync));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (send.disabled) return;
    send.disabled = true;
    const { error } = await sb.from("sick_leave").insert({
      employee_id: emp.value, date_from: from.value, date_to: to.value, note: note.value.trim() || null,
    });
    if (error) { slMsg(slError(error), true); send.disabled = false; return; }
    const who = SL.names[emp.value] || "";
    emp.value = ""; from.value = ""; to.value = ""; note.value = ""; sync();
    zmBanner(`Bolovanje je upisano${who ? ` za ${who}` : ""}.`, "success");
    await slLoadList();
  });

  const list = document.getElementById("sl-list");
  list.addEventListener("input", (e) => {
    const input = e.target.closest(".sl-edit-to");
    if (input) input.closest(".sl-item").querySelector(".sl-save").hidden = false;
  });
  list.addEventListener("click", async (e) => {
    const item = e.target.closest(".sl-item");
    if (!item) return;
    if (e.target.closest(".sl-save")) {
      const value = item.querySelector(".sl-edit-to").value;
      if (!value) return;
      const { error } = await sb.from("sick_leave").update({ date_to: value }).eq("id", item.dataset.id);
      if (error) return zmBanner(slError(error), "error");
      zmBanner("Kraj bolovanja je promenjen.", "success");
      await slLoadList();
    } else if (e.target.closest(".sl-del")) {
      if (!confirm("Obrisati ovo bolovanje?")) return;
      const { error } = await sb.from("sick_leave").delete().eq("id", item.dataset.id);
      if (error) return zmBanner(slError(error), "error");
      zmBanner("Bolovanje je obrisano.", "success");
      await slLoadList();
    }
  });
})();

async function slInit() {
  document.getElementById("sl-card").classList.remove("zm-hidden");
  const { data } = await sb.from("employees").select("id, funkcija, active, profiles(full_name)");
  (data || []).forEach(e => { SL.names[e.id] = (e.profiles?.full_name || "").toUpperCase(); });
  const people = (data || []).filter(e => e.active && !["administrator", "management"].includes(e.funkcija))
    .sort((a, b) => SL.names[a.id].localeCompare(SL.names[b.id], "sr"));
  const select = document.getElementById("sl-emp");
  select.insertAdjacentHTML("beforeend", people.map(e => `<option value="${e.id}">${zmEsc(SL.names[e.id])}</option>`).join(""));
  document.getElementById("sl-from").value ||= slToday();
  await slLoadList();
}
