const MONTH_NAMES_SR = [
  "Januar", "Februar", "Mart", "April", "Maj", "Jun",
  "Jul", "Avgust", "Septembar", "Oktobar", "Novembar", "Decembar",
];
const DOW_SR = ["Ned", "Pon", "Uto", "Sre", "Čet", "Pet", "Sub"];

const DOT_BY_FUNKCIJA = {
  administrator: "var(--dot-lider)",
  shift_lider: "var(--dot-lider)",
  monitoring: "var(--dot-monitoring)",
  radnik: "var(--dot-radnik)",
};

// Redosled prikaza u smeni: Shift lideri, pa Monitoring, pa Radnici.
const FUNKCIJA_SORT_ORDER = { shift_lider: 0, monitoring: 1, radnik: 2, administrator: 3 };
function funkcijaSortValue(funkcija) {
  return FUNKCIJA_SORT_ORDER[funkcija] !== undefined ? FUNKCIJA_SORT_ORDER[funkcija] : 9;
}

// Boja i ikona po smeni — isto na početnoj strani i u admin portalu (CSS klase .shift-I/.shift-II/.shift-III).
const SHIFT_ICON_SVG = {
  I: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  II: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M17 18a5 5 0 0 0-10 0"/><path d="M12 4v4M4.2 10.2l1.4 1.4M18.4 11.6l1.4-1.4M2 18h2M20 18h2M6 22h12"/></svg>',
  III: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
};
const SHIFT_PART_OF_DAY = { I: "Jutro", II: "Popodne", III: "Noć" };

// Međusmena: postoji samo u I i II smeni.
const MS_LABEL = { I: "MS 13–21", II: "MS 21–05" };
const DOT_LEADER = "var(--dot-lider)";
const DOT_MS = "var(--dot-ms)";

// Vizuelno razlikovanje praznih i popunjenih date inputa (svetlo sivo kad je prazno, jasno kad je uneto).
function syncDateInputVisual(el) {
  if (el) el.classList.toggle("has-date", !!el.value);
}
function syncAllDateInputs(root) {
  (root || document).querySelectorAll('input[type="date"]').forEach(syncDateInputVisual);
}
document.addEventListener("input", (e) => {
  if (e.target.matches && e.target.matches('input[type="date"]')) syncDateInputVisual(e.target);
}, true);
document.addEventListener("change", (e) => {
  if (e.target.matches && e.target.matches('input[type="date"]')) syncDateInputVisual(e.target);
}, true);

// Trenutno vreme u Beogradu (bez obzira na vremensku zonu računara).
// Vraća Date čiji getHours()/getDate()/getDay()... daju beogradsko vreme.
function belgradeNow() {
  const parts = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Belgrade",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).forEach(p => { parts[p.type] = p.value; });
  return new Date(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}
