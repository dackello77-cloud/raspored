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

// ---------- Kancelarija: Office manager (08–16) i Accounting (15–23) ----------
// Nisu u rasporedu smena. Rade pon–pet; državni praznici i 25.12. su slobodni
// (isto kao office_holiday() u sql/migration_014_office_roles.sql). Kod "smene": OM / AC.
const OFFICE_ROLES = {
  office_manager: { code: "OM", startHour: 8, label: "Office manager", hours: "08:00–16:00" },
  accounting: { code: "AC", startHour: 15, label: "Accounting", hours: "15:00–23:00" },
};
const OFFICE_CODE_LABEL = { OM: "Office manager", AC: "Accounting" };

function officeIso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function orthodoxEasterLocal(year) {
  const a = year % 4, b = year % 7, c = year % 19;
  const d = (19 * c + 15) % 30, e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31), day = ((d + e + 114) % 31) + 1;
  return new Date(year, month - 1, day + 13);
}
const OFFICE_HOLIDAY_CACHE = {};
function officeHolidays(year) {
  if (OFFICE_HOLIDAY_CACHE[year]) return OFFICE_HOLIDAY_CACHE[year];
  const set = new Set(["01-01", "01-02", "01-07", "02-15", "02-16", "05-01", "05-02", "11-11", "12-25"].map(md => `${year}-${md}`));
  const e = orthodoxEasterLocal(year);
  const easter = [-2, -1, 0, 1].map(n => officeIso(new Date(e.getFullYear(), e.getMonth(), e.getDate() + n)));
  easter.forEach(x => set.add(x));
  // Dvodnevni praznik ili 11.11. u nedelju -> slobodan i prvi sledeći radni dan (ne na Uskrs).
  [[0, 1], [1, 15], [4, 1]].forEach(([m, d]) => {
    const first = new Date(year, m, d), second = new Date(year, m, d + 1);
    if (first.getDay() === 0 || second.getDay() === 0) {
      let moved = new Date(year, m, d + 2);
      while (easter.includes(officeIso(moved))) moved = new Date(moved.getFullYear(), moved.getMonth(), moved.getDate() + 1);
      set.add(officeIso(moved));
    }
  });
  if (new Date(year, 10, 11).getDay() === 0) set.add(`${year}-11-12`);
  return (OFFICE_HOLIDAY_CACHE[year] = set);
}
function officeIsWorkday(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.getDay() >= 1 && d.getDay() <= 5 && !officeHolidays(d.getFullYear()).has(iso);
}
