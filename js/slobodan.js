// Slobodan dan za naredni mesec (stranica Zamene -> dugme "Slobodan").
// Kalendar je uvek za naredni mesec; izabran dan se odmah upisuje u Plan zaposlenih
// (days_off). Najviše 2 osobe po danu — pun dan je zaključan. Pravila čuva baza:
// sql/migration_024_slobodan_kalendar.sql.

const FP_ROLES = ["radnik", "shift_lider", "monitoring", "accounting", "office_manager"];
const FP_MAX = 2;
const FP_DEADLINE = 20; // do 20. u mesecu (uključivo) bira se dan za naredni mesec, posle je zaključano

function fpOpen() { return belgradeNow().getDate() <= FP_DEADLINE; }
function fpDeadlineText() {
  const t = belgradeNow();
  return `${FP_DEADLINE}.${t.getMonth() + 1}.${t.getFullYear()}.`;
}

function fpNextMonth() {
  const t = belgradeNow();
  return new Date(t.getFullYear(), t.getMonth() + 1, 1);
}

async function fpLoad() {
  const { data, error } = await sb.rpc("free_pick_status");
  if (error) return { error };
  const byDate = {};
  (data || []).forEach(r => { byDate[r.off_date] = r; });
  return { byDate };
}

async function fpRefreshCard() {
  const box = document.getElementById("fp-current");
  const { byDate, error } = await fpLoad();
  if (error) {
    box.textContent = /free_pick_status/.test(error.message)
      ? "Još nije uključeno — treba jednom pokrenuti SQL iz fajla sql/migration_024_slobodan_kalendar.sql u Supabase."
      : error.message;
    return;
  }
  const mine = Object.values(byDate).find(r => r.mine);
  const open = fpOpen();
  box.innerHTML = (mine ? `Tvoj slobodan dan: <b>${zmEsc(zmFmtDate(mine.off_date))}</b>` : open ? "Još nisi izabrao/la slobodan dan." : "Nisi izabrao/la slobodan dan.")
    + (open ? `<br><span class="muted">Izbor je otvoren do ${fpDeadlineText()}</span>` : `<br><span class="muted">🔒 Izbor je zaključan (rok je bio ${fpDeadlineText()})</span>`);
  document.getElementById("fp-open").disabled = !open;
}

async function fpOpenCalendar() {
  if (!fpOpen()) { zmBanner(`Slobodni dani za naredni mesec biraju se do ${FP_DEADLINE}. u mesecu — izbor je zaključan.`, "error"); fpRefreshCard(); return; }
  document.getElementById("zm-dialog")?.remove();
  const first = fpNextMonth();
  const y = first.getFullYear(), m = first.getMonth();
  const overlay = document.createElement("div");
  overlay.id = "zm-dialog";
  overlay.className = "pw-overlay";
  overlay.innerHTML = `
    <div class="pw-box fp-box">
      <h3>Slobodan dan — ${MONTH_NAMES_SR[m]} ${y}.</h3>
      <div class="muted" style="font-size:12px;">Klikni na dan — odmah se upisuje u plan. Najviše ${FP_MAX} osobe po danu; pun dan je zaključan. Izbor je otvoren do ${fpDeadlineText()}</div>
      <div class="fp-cal"><div class="zm-empty">Učitavanje...</div></div>
      <div class="pw-msg"></div>
      <div class="pw-actions">
        <button type="button" class="btn btn-ghost fp-clear" hidden>Ukloni moj dan</button>
        <button type="button" class="btn btn-ghost pw-cancel">Zatvori</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".pw-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  const msg = overlay.querySelector(".pw-msg");
  const cal = overlay.querySelector(".fp-cal");
  const clearBtn = overlay.querySelector(".fp-clear");
  const showErr = (text) => { msg.className = "pw-msg err"; msg.textContent = text; };

  async function draw() {
    const { byDate, error } = await fpLoad();
    if (error) { cal.innerHTML = ""; showErr(error.message); return; }
    const days = new Date(y, m + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // ponedeljak prvi
    let html = ["Pon", "Uto", "Sre", "Čet", "Pet", "Sub", "Ned"].map(d => `<div class="fp-dow">${d}</div>`).join("");
    html += "<div></div>".repeat(lead);
    for (let d = 1; d <= days; d++) {
      const iso = officeIso(new Date(y, m, d));
      const r = byDate[iso];
      const taken = r ? r.taken : 0;
      const mine = !!(r && r.mine);
      const full = taken >= FP_MAX && !mine;
      html += `<button type="button" class="fp-day${mine ? " mine" : ""}${full ? " full" : ""}" data-iso="${iso}" ${full ? "disabled" : ""}
        title="${mine ? "Tvoj slobodan dan" : full ? "Popunjeno" : `Slobodno mesta: ${FP_MAX - taken}`}">
        <b>${d}</b><small>${full ? "🔒" : `${taken}/${FP_MAX}`}</small></button>`;
    }
    cal.innerHTML = html;
    clearBtn.hidden = !Object.values(byDate).some(x => x.mine);
  }

  cal.addEventListener("click", async (e) => {
    const btn = e.target.closest(".fp-day:not([disabled])");
    if (!btn || btn.classList.contains("mine")) return;
    cal.querySelectorAll(".fp-day").forEach(b => { b.disabled = true; });
    const { error } = await sb.rpc("free_pick_set", { p_date: btn.dataset.iso });
    if (error) { showErr(error.message); await draw(); return; }
    close();
    zmBanner(`Slobodan dan je upisan: ${zmFmtDate(btn.dataset.iso)}`, "success");
    fpRefreshCard();
  });
  clearBtn.addEventListener("click", async () => {
    if (!confirm("Ukloniti tvoj slobodan dan za naredni mesec?")) return;
    const { error } = await sb.rpc("free_pick_clear");
    if (error) { showErr(error.message); return; }
    msg.className = "pw-msg ok"; msg.textContent = "Uklonjeno.";
    await draw();
    fpRefreshCard();
  });
  await draw();
}

function fpInit(me, profile) {
  const allowed = !!me && (FP_ROLES.includes(me.funkcija) || !!(profile && profile.hr_manager));
  document.getElementById("fp-card").classList.toggle("zm-hidden", !allowed);
  if (!allowed) return;
  const first = fpNextMonth();
  document.getElementById("fp-sub").textContent =
    `${MONTH_NAMES_SR[first.getMonth()]} ${first.getFullYear()}. · bira se do ${FP_DEADLINE}. u mesecu · najviše ${FP_MAX} osobe po danu, upisuje se u plan zaposlenih.`;
  document.getElementById("fp-open").addEventListener("click", fpOpenCalendar);
  fpRefreshCard();
}
