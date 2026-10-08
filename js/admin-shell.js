// Zajednička admin-portal logika: provera pristupa, header, tabovi.
// Tabovi žive gore u glavnoj navigaciji (pored "Raspored") i menjaju se preko
// URL hash-a (#osobe / #plan / #rasporedi), pa rade i kao obično krstarenje
// (link iz bilo koje stranice) i kao prebacivanje bez ponovnog učitavanja
// kad je admin portal već otvoren.

let ADMIN_PROFILE = null;
let adminCurrentTab = "osobe";

const ADMIN_TAB_KEYS = ["osobe", "plan", "rasporedi", "dolasci"];

// Telefon: Osobe, Plan i Generisanje se ne prikazuju — admin tamo koristi samo Dolasci.
const ADMIN_DESKTOP_ONLY = ["osobe", "plan", "rasporedi"];
const adminIsPhone = () => window.matchMedia("(max-width: 700px)").matches;

function adminTabFromHash() {
  const h = (location.hash || "").slice(1);
  const tab = ADMIN_TAB_KEYS.includes(h) ? h : (adminIsPhone() ? "dolasci" : "osobe");
  return adminIsPhone() && ADMIN_DESKTOP_ONLY.includes(tab) ? "dolasci" : tab;
}

function switchAdminTab(key) {
  adminCurrentTab = key;
  document.querySelectorAll(".tab-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === `tab-${key}`);
  });
  document.querySelectorAll(".app-header nav a[data-admin-tab]").forEach(a => {
    a.classList.toggle("active", a.dataset.adminTab === key);
  });
}

// Pri izlasku iz "Osobe u sistemu" nesačuvane izmene se automatski sačuvaju, a tab koji se
// otvara dobija događaj "admin-tab-change" da ponovo učita podatke (odmori, aktivni, slava...).
window.addEventListener("hashchange", async () => {
  const to = adminTabFromHash();
  if (location.hash.slice(1) !== to) history.replaceState(null, "", "#" + to);
  const from = adminCurrentTab;
  if (from === to) return;
  if (from === "osobe" && typeof osobeSaveIfDirty === "function") await osobeSaveIfDirty();
  switchAdminTab(to);
  document.dispatchEvent(new CustomEvent("admin-tab-change", { detail: { from, to } }));
});

(async () => {
  ADMIN_PROFILE = await requireAdmin();
  if (!ADMIN_PROFILE) return;

  if (location.hash.slice(1) !== adminTabFromHash()) history.replaceState(null, "", "#" + adminTabFromHash());
  await mountHeader(`admin-${adminTabFromHash()}`);
  switchAdminTab(adminTabFromHash());

  document.dispatchEvent(new CustomEvent("admin-ready"));
})();
