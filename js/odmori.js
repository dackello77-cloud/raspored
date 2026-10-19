// Stranica "Odmori": zaposleni biraju termin za godišnji odmor (2 nedelje), administrator
// aktivira termine (datum objave + ponedeljak od koga kreću). Pravila čuva baza —
// sql/migration_025_odmori.sql; ovde se ista pravila koriste samo za prikaz (zaključano / slobodno).

const OD_ROLES = ["radnik", "shift_lider", "monitoring", "accounting", "office_manager"];
const OD_RASPORED = ["radnik", "shift_lider", "monitoring"];
const OD_LABEL = { radnik: "Radnik", shift_lider: "Shift lider", monitoring: "Monitoring", accounting: "Accounting", office_manager: "Office manager" };

const OD_SEASONS = { letnji: "Letnji", zimski: "Zimski" };

// round/picks = trenutno izabran tab (sezona); rounds = aktivni termini obe sezone.
let OD = { me: null, isAdmin: false, season: "letnji", rounds: {}, round: null, picks: [], emps: [] };

// Pravo na odmor: 6 meseci od početka radnog odnosa (isto kao vacation_eligible_from u bazi).
function odEligibleFrom(hire) {
  if (!hire) return null;
  const [y, m, d] = hire.split("-").map(Number);
  const last = new Date(y, m - 1 + 6 + 1, 0).getDate(); // 31.8. + 6 meseci = 28/29.2.
  return odIso(new Date(y, m - 1 + 6, Math.min(d, last)));
}

function odIso(d) { return officeIso(d); }
function odAddDays(iso, n) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return odIso(d); }
function odFmt(iso) { const [y, m, d] = iso.split("-"); return `${+d}.${+m}.${y}.`; }
function odFmtShort(iso) { const [, m, d] = iso.split("-"); return `${+d}.${+m}.`; }
function odToday() { return odIso(belgradeNow()); }
function odTerm(k) { const from = odAddDays(OD.round.start_date, 7 * k); return { from, to: odAddDays(from, 13) }; }

function odBanner(message, type) {
  const box = document.getElementById("od-banner");
  box.innerHTML = `<div class="banner ${type}">${zmEsc(message)}</div>`;
  if (type === "success") setTimeout(() => { box.innerHTML = ""; }, 6000);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Isto pravilo kao public.vacation_pick_error u bazi (null = može).
function odPickError(f, term) {
  if (!OD_ROLES.includes(f)) return "Odmor ovde biraju radnici, shift lideri, monitoring, accounting i office manager.";
  const others = OD.picks.filter(p => p.employee_id !== OD.me.id);
  const termStart = odTerm(term).from;
  const myElig = odEligibleFrom(OD.me.hire_date);
  if (myElig && termStart < myElig) return `Pravo na odmor od ${odFmt(myElig)}`;
  if (OD_RASPORED.includes(f)) {
    const t = others.find(p => p.term_no === term && OD_RASPORED.includes(p.funkcija));
    if (t) return "Zauzeto";
  }
  if (["shift_lider", "monitoring", "accounting"].includes(f)) {
    const t = others.find(p => Math.abs(p.term_no - term) <= 1 && p.funkcija === f);
    if (t) return `Preklapa se sa odmorom: ${t.name}`;
  }
  // Rezervacija za nove radnike koji još nisu birali (isto kao u bazi).
  if (OD_RASPORED.includes(f)) {
    const lastStart = odTerm(OD.round.term_count - 1).from;
    const picked = new Set(OD.picks.map(p => p.employee_id));
    const fresh = OD.emps.filter(e => e.active && e.id !== OD.me.id && OD_RASPORED.includes(e.funkcija) && !picked.has(e.id))
      .map(e => odEligibleFrom(e.hire_date))
      .filter(x => x && x > OD.round.start_date && x <= lastStart);
    const taken = new Set(others.filter(p => OD_RASPORED.includes(p.funkcija)).map(p => p.term_no));
    for (const t of new Set(fresh)) {
      if (termStart < t) continue;
      let free = 0;
      for (let n = 0; n < OD.round.term_count; n++) if (n !== term && odTerm(n).from >= t && !taken.has(n)) free++;
      if (free < fresh.filter(x => x >= t).length) return "Rezervisano za nove radnike";
    }
  }
  return null;
}

async function odLoad() {
  const { data: rounds, error } = await sb.from("vacation_rounds").select("*").eq("active", true)
    .order("created_at", { ascending: false });
  if (error) {
    odBanner(/vacation_rounds/.test(error.message)
      ? "Odmori još nisu uključeni — treba jednom pokrenuti SQL iz fajla sql/migration_025_odmori.sql u Supabase."
      : error.message, "error");
    return;
  }
  OD.rounds = {};
  (rounds || []).forEach(r => { const s = r.season || "letnji"; if (!OD.rounds[s]) OD.rounds[s] = r; });
  OD.round = OD.rounds[OD.season] || null;
  OD.picks = [];
  if (OD.round) {
    const { data: emps } = await sb.from("employees").select("id, funkcija, hire_date, active");
    OD.emps = emps || [];
    const { data } = await sb.from("vacation_picks")
      .select("id, term_no, employee_id, employees(funkcija, profiles(full_name))").eq("round_id", OD.round.id);
    OD.picks = (data || []).map(p => ({
      id: p.id, term_no: p.term_no, employee_id: p.employee_id,
      funkcija: p.employees?.funkcija, name: (p.employees?.profiles?.full_name || "").toUpperCase(),
    }));
  }
  odRender();
}

// Tab je "otvoren" ako zaposleni trenutno mogu da biraju u toj sezoni.
function odSeasonOpen(r) { const t = odToday(); return !!r && t >= r.publish_date && t < r.start_date; }

function odRenderTabs() {
  document.querySelectorAll(".od-tab").forEach(b => {
    const s = b.dataset.season;
    b.classList.toggle("active", s === OD.season);
    b.querySelector(".od-tab-dot").hidden = !odSeasonOpen(OD.rounds[s]);
  });
  const name = OD_SEASONS[OD.season].toLowerCase();
  document.getElementById("od-admin-title").textContent = `Aktiviraj termine — ${name} odmor`;
  document.getElementById("od-list-title").textContent = `Termini — ${name} odmor`;
}

function odRender() {
  odRenderTabs();
  const r = OD.round;
  const today = odToday();
  const lastEnd = r ? odTerm(r.term_count - 1).to : null;
  const published = r && today >= r.publish_date && today <= lastEnd;
  const open = published && today < r.start_date;
  const list = document.getElementById("od-terms");
  const info = document.getElementById("od-info");

  if (OD.isAdmin) odRenderAdmin();
  if (!r || (!published && !OD.isAdmin)) {
    info.textContent = "";
    list.innerHTML = `<div class="od-none">Nema aktivnih termina za ${OD_SEASONS[OD.season].toLowerCase()} odmor.</div>`;
    return;
  }

  const myF = OD.me && OD.me.funkcija;
  const mine = OD.me && OD.picks.find(p => p.employee_id === OD.me.id);
  info.innerHTML = !published
    ? `Pregled za administratora — zaposleni vide termine od <b>${odFmt(r.publish_date)}</b>.`
    : open
      ? `Izbor je otvoren do ${odFmt(odAddDays(r.start_date, -1))}. Termin traje 2 nedelje.${mine ? ` Tvoj termin: <b>${odFmt(odTerm(mine.term_no).from)} – ${odFmt(odTerm(mine.term_no).to)}</b>.` : ""}`
      : "Odmori su počeli — izbor termina je zatvoren.";

  let html = "";
  for (let k = 0; k < r.term_count; k++) {
    const t = odTerm(k);
    const here = OD.picks.filter(p => p.term_no === k);
    const isMine = !!(mine && mine.term_no === k);
    let action = "";
    if (isMine) {
      action = `<span class="od-state mine">Tvoj termin</span>${open ? '<button type="button" class="btn btn-ghost od-unpick">Otkaži</button>' : ""}`;
    } else if (open && OD.me && OD_ROLES.includes(myF)) {
      const err = odPickError(myF, k);
      action = err
        ? `<span class="od-state locked" title="${zmEsc(err)}">🔒 ${zmEsc(err)}</span>`
        : `<button type="button" class="btn btn-primary od-pick" data-term="${k}">${mine ? "Prebaci ovde" : "Izaberi"}</button>`;
    }
    const people = here.map(p => `<span class="od-person">${zmEsc(p.name)} <small>${OD_LABEL[p.funkcija] || ""}</small>${OD.isAdmin
      ? `<button type="button" class="od-remove" data-pick="${p.id}" title="Ukloni termin">×</button>` : ""}</span>`).join("");
    html += `<div class="od-term${isMine ? " is-mine" : ""}">
      <div class="od-term-head"><b>Termin ${k + 1}</b><span>${odFmtShort(t.from)} – ${odFmt(t.to)}</span></div>
      <div class="od-people">${people || '<span class="muted">Slobodno</span>'}</div>
      <div class="od-actions">${action}</div>
    </div>`;
  }
  list.innerHTML = html;
}

function odRenderAdmin() {
  const r = OD.round;
  const box = document.getElementById("od-admin-current");
  box.innerHTML = r
    ? `Aktivni ${OD_SEASONS[OD.season].toLowerCase()} termini: objava <b>${odFmt(r.publish_date)}</b>, odmori od <b>${odFmt(r.start_date)}</b>, ${r.term_count} termina
       (do ${odFmt(odTerm(r.term_count - 1).to)}). Izabrano: ${OD.picks.length}.
       <button type="button" class="btn btn-danger" id="od-close">Deaktiviraj termine</button>`
    : `Nema aktivnih termina za ${OD_SEASONS[OD.season].toLowerCase()} odmor.`;
  const close = document.getElementById("od-close");
  if (close) close.addEventListener("click", async () => {
    if (!confirm(`Deaktivirati ${OD_SEASONS[OD.season].toLowerCase()} termine? Već upisani odmori ostaju u Osobe u sistemu.`)) return;
    const { error } = await sb.rpc("vacation_round_close", { p_id: r.id });
    if (error) { odBanner(error.message, "error"); return; }
    odBanner("Termini su deaktivirani.", "success");
    await odLoad();
  });
}

document.getElementById("od-terms").addEventListener("click", async (e) => {
  const pick = e.target.closest(".od-pick");
  const unpick = e.target.closest(".od-unpick");
  const remove = e.target.closest(".od-remove");
  if (pick) {
    const k = Number(pick.dataset.term), t = odTerm(k);
    if (!confirm(`Izabrati odmor ${odFmt(t.from)} – ${odFmt(t.to)}?`)) return;
    pick.disabled = true;
    const { error } = await sb.rpc("vacation_pick", { p_term: k, p_season: OD.season });
    if (error) { odBanner(error.message, "error"); await odLoad(); return; }
    odBanner(`Odmor je upisan: ${odFmt(t.from)} – ${odFmt(t.to)}.`, "success");
    await odLoad();
  } else if (unpick) {
    if (!confirm("Otkazati tvoj termin za odmor?")) return;
    const { error } = await sb.rpc("vacation_unpick", { p_season: OD.season });
    if (error) { odBanner(error.message, "error"); return; }
    odBanner("Termin je otkazan.", "success");
    await odLoad();
  } else if (remove) {
    if (!confirm("Ukloniti ovaj termin i upisan odmor?")) return;
    const { error } = await sb.rpc("vacation_unpick", { p_pick: remove.dataset.pick, p_season: OD.season });
    if (error) { odBanner(error.message, "error"); return; }
    odBanner("Termin je uklonjen.", "success");
    await odLoad();
  }
});

document.querySelector(".od-tabs").addEventListener("click", async (e) => {
  const b = e.target.closest(".od-tab");
  if (!b || b.dataset.season === OD.season) return;
  OD.season = b.dataset.season;
  document.getElementById("od-admin-msg").textContent = "";
  await odLoad();
});

document.getElementById("od-admin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const publish = document.getElementById("od-publish").value;
  const start = document.getElementById("od-start").value;
  const msg = document.getElementById("od-admin-msg");
  msg.className = "zm-office-msg err";
  if (!publish || !start) { msg.textContent = "Upiši oba datuma."; return; }
  if (new Date(start + "T00:00:00").getDay() !== 1) { msg.textContent = "Odmori moraju da počnu u ponedeljak."; return; }
  const name = OD_SEASONS[OD.season].toLowerCase();
  if (OD.round && !confirm(`Već postoje aktivni termini za ${name} odmor — zameniti ih novim? Već upisani odmori ostaju.`)) return;
  const { error } = await sb.rpc("vacation_round_create", { p_publish: publish, p_start: start, p_season: OD.season });
  if (error) { msg.textContent = error.message; return; }
  msg.textContent = "";
  odBanner(`Termini za ${name} odmor su aktivirani.`, "success");
  await odLoad();
});

(async () => {
  const { session, profile } = await mountHeader("odmori");
  if (!session) { window.location.href = APP_BASE + "login.html"; return; }
  OD.isAdmin = isAdminProfile(profile);
  const { data: emp } = await sb.from("employees").select("id, funkcija, hire_date").eq("profile_id", session.user.id).maybeSingle();
  OD.me = emp || null;
  document.getElementById("od-admin-card").classList.toggle("od-hidden", !OD.isAdmin);
  await odLoad();
  // Početni tab: sezona u kojoj je izbor upravo otvoren (zimski dok letnji još traje), inače letnji.
  if (!odSeasonOpen(OD.rounds.letnji) && odSeasonOpen(OD.rounds.zimski)) {
    OD.season = "zimski"; OD.round = OD.rounds.zimski; await odLoad();
  }
})();
