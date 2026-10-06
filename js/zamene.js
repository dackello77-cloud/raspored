// Stranica "Zamene": pregled zahteva za zamenu smene — moji zahtevi, zahtevi upućeni meni,
// a za HR (i administratora) zahtevi za odobrenje i istorija. Novi zahtev se šalje sa
// stranice Raspored (desni klik na radnika -> Zamena). Zajednički delovi: js/swap-common.js.

let ZM = { me: null, isHR: false, names: {} };

function zmBanner(message, type) {
  const box = document.getElementById("zm-banner");
  box.innerHTML = `<div class="banner ${type}">${zmEsc(message)}</div>`;
  if (type === "success") setTimeout(() => { box.innerHTML = ""; }, 6000);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function zmRender(id, rows, actionsFor, emptyText) {
  document.getElementById(id).innerHTML = rows.length
    ? rows.map(r => zmItemHtml(r, ZM.names, actionsFor(r))).join("")
    : `<div class="zm-empty">${emptyText}</div>`;
}

async function zmLoadLists() {
  const { data, error } = await sb.from("swap_requests").select("*").order("date", { ascending: false }).limit(300);
  if (error) {
    zmBanner(/swap_requests/.test(error.message)
      ? "Zamene još nisu uključene — treba jednom pokrenuti SQL iz fajla sql/migration_006_swap_requests.sql u Supabase."
      : error.message, "error");
    ["zm-mine", "zm-incoming"].forEach(id => { document.getElementById(id).innerHTML = ""; });
    return;
  }
  const rows = data || [];
  const myId = ZM.me && ZM.me.id;
  const pending = r => r.status === "pending_worker" || r.status === "pending_hr";

  zmRender("zm-mine", rows.filter(r => r.requester_id === myId), r => pending(r) ? ZM_ACTIONS.cancel : "",
    "Nisi poslao/la nijedan zahtev.");
  zmRender("zm-incoming", rows.filter(r => r.target_id === myId && r.status === "pending_worker"), () => ZM_ACTIONS.incoming,
    "Nema zahteva koji čekaju tvoj odgovor.");
  if (ZM.isHR) {
    zmRender("zm-hr", rows.filter(r => r.status === "pending_hr").sort((x, y) => x.date.localeCompare(y.date)), () => ZM_ACTIONS.hr,
      "Nema zahteva za odobrenje.");
    zmRender("zm-history", rows.filter(r => !pending(r)).slice(0, 30), () => "", "Još nema završenih zahteva.");
    zmFillStaffInfo(document.getElementById("zm-hr"));
  }
}

zmOnDone = async (msg, isError) => {
  zmBanner(msg, isError ? "error" : "success");
  await zmLoadLists();
};

(async () => {
  const { session, profile } = await mountHeader("zamene");
  if (!session) { window.location.href = APP_BASE + "login.html"; return; }
  ZM.isHR = !!(profile && (profile.hr_manager || profile.role === "admin"));
  const { names, employees } = await zmFetchNames();
  ZM.names = names;
  ZM.me = employees.find(e => e.profile_id === session.user.id) || null;
  document.getElementById("zm-hr-card").classList.toggle("zm-hidden", !ZM.isHR);
  document.getElementById("zm-history-card").classList.toggle("zm-hidden", !ZM.isHR);
  await zmLoadLists();
})();
