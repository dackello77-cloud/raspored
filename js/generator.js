// ============================================================
// GENERATOR RASPOREDA — čista logika (bez DOM/Supabase poziva),
// da bi mogla da se testira nezavisno (node js/generator.js ili require).
// ============================================================

// 8 varijanti — sve kombinacije {2/3, 3/4} za I/II/III smenu (min/max radnika po smeni).
const SHIFT_VARIANTS = [
  { id: 1, mins: { I: 2, II: 2, III: 2 }, maxs: { I: 3, II: 3, III: 3 } },
  { id: 2, mins: { I: 3, II: 2, III: 2 }, maxs: { I: 4, II: 3, III: 3 } },
  { id: 3, mins: { I: 2, II: 3, III: 2 }, maxs: { I: 3, II: 4, III: 3 } },
  { id: 4, mins: { I: 2, II: 2, III: 3 }, maxs: { I: 3, II: 3, III: 4 } },
  { id: 5, mins: { I: 3, II: 3, III: 2 }, maxs: { I: 4, II: 4, III: 3 } },
  { id: 6, mins: { I: 2, II: 3, III: 3 }, maxs: { I: 3, II: 4, III: 4 } },
  { id: 7, mins: { I: 3, II: 3, III: 3 }, maxs: { I: 4, II: 4, III: 4 } },
  { id: 8, mins: { I: 3, II: 2, III: 3 }, maxs: { I: 4, II: 3, III: 4 } },
];

function findVariant(iBand, iiBand, iiiBand) {
  // iBand/iiBand/iiiBand su "2/3" ili "3/4"
  const minOf = (band) => (band === "3/4" ? 3 : 2);
  const i = minOf(iBand), ii = minOf(iiBand), iii = minOf(iiiBand);
  return SHIFT_VARIANTS.find(v => v.mins.I === i && v.mins.II === ii && v.mins.III === iii);
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function monthFond(year, month) {
  const days = daysInMonth(year, month);
  if (days === 31) return 21;
  if (days === 30) return 20;
  return 19;
}

function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isoWeekNumber(dateObj) {
  const d = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Pon=0..Ned=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = d - firstThursday;
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

// Orthodox (srpski) uskrs — Meeus julijanski algoritam, konvertovan u gregorijanski datum.
function orthodoxEasterDate(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31); // 3=mart, 4=april (julijanski)
  const day = ((d + e + 114) % 31) + 1;
  // Julijanski datum -> gregorijanski (dodati 13 dana za 20./21. vek)
  const julianDate = new Date(Date.UTC(year, month - 1, day));
  julianDate.setUTCDate(julianDate.getUTCDate() + 13);
  return julianDate;
}

function isHolidayOrWeekendLike(dateObj) {
  const dow = dateObj.getDay();
  if (dow === 0 || dow === 6) return true;
  const y = dateObj.getFullYear();
  if (dateObj.getMonth() === 11 && dateObj.getDate() === 25) return true; // US Božić
  const easter = orthodoxEasterDate(y);
  if (dateObj.getFullYear() === easter.getUTCFullYear() &&
      dateObj.getMonth() === easter.getUTCMonth() &&
      dateObj.getDate() === easter.getUTCDate()) return true; // Uskrs
  return false;
}

// ------------------------------------------------------------
// Pomoćno: da li je dan u opsegu [start,end] (ISO yyyy-mm-dd stringovi)
// ------------------------------------------------------------
function inRange(dateStr, start, end) {
  return dateStr >= start && dateStr <= end;
}

// ------------------------------------------------------------
// Fiksni raspored za Shift lidere i Monitoring (Pon-Pet, Mon-Čet za Monitoring III)
// ------------------------------------------------------------
function fixedScheduleForWeek(funkcija, monitoringSmena, weekMondayDate) {
  // vraća mapu { 'YYYY-MM-DD': 'I'|'II'|'III'|'OFF' } za tu nedelju (pon-ned)
  const result = {};
  const shift = funkcija === "monitoring" ? (monitoringSmena || "I") : null;
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekMondayDate);
    d.setDate(d.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const isWeekend = i >= 5; // Sub=5, Ned=6 (pošto je 0=Pon)
    if (isWeekend) {
      result[key] = "OFF";
      continue;
    }
    if (funkcija === "monitoring") {
      if (shift === "III" && i === 4) { // Monitoring III ne radi petak
        result[key] = "OFF";
      } else {
        result[key] = shift;
      }
    } else {
      result[key] = null; // popunjava se rotacijom za shift_lider van ove funkcije
    }
  }
  return result;
}

function liderShiftForWeek(liderIndex, weekMondayDate) {
  const wk = isoWeekNumber(weekMondayDate);
  const rotation = ["III", "II", "I"];
  return rotation[(wk + liderIndex) % 3];
}

// ------------------------------------------------------------
// Generiše raspored za Shift lidere i Monitoring zaposlene za ceo mesec.
// liderEmployees, monitoringEmployees: [{id, monitoring_smena}]
// weeklyOverrides: Map employeeId -> { weekNumber: funkcija_for_week }  (iz weekly_plans)
// weeks: [{number, start, end}] iz computeWeeksOfMonth
// forcedOff: Map employeeId -> Set(dateStr) (vacation + days_off)
// Vraća: Map employeeId -> { dateStr: 'I'|'II'|'III'|'OFF' }
// ------------------------------------------------------------
function generateFixedFunctionSchedule(employees, weeks, forcedOff, weeklyOverridesMap, liderIndexOffset) {
  const out = {};
  employees.forEach((emp, idx) => {
    out[emp.id] = {};
    const liderIndex = (liderIndexOffset[emp.id] !== undefined) ? liderIndexOffset[emp.id] : idx;
    weeks.forEach(w => {
      const weekMonday = new Date(w.start + "T00:00:00");
      // ponedeljak te nedelje (w.start može biti bilo koji dan ako je prva nedelja meseca parcijalna)
      const mondayOffset = (weekMonday.getDay() + 6) % 7;
      weekMonday.setDate(weekMonday.getDate() - mondayOffset);

      const override = weeklyOverridesMap[emp.id] && weeklyOverridesMap[emp.id][w.number];
      let funkcijaThisWeek = emp.funkcija;
      if (override === "slobodan" || override === "ne_radi") {
        for (let i = 0; i < 7; i++) {
          const d = new Date(weekMonday); d.setDate(d.getDate() + i);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          if (inRange(key, w.start, w.end)) out[emp.id][key] = "OFF";
        }
        return;
      }
      if (override === "shift_lider" || override === "monitoring" || override === "radnik") {
        funkcijaThisWeek = override;
      }

      let weekMap;
      if (funkcijaThisWeek === "shift_lider") {
        const shift = liderShiftForWeek(liderIndex, weekMonday);
        weekMap = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(weekMonday); d.setDate(d.getDate() + i);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          weekMap[key] = i >= 5 ? "OFF" : shift;
        }
      } else if (funkcijaThisWeek === "monitoring") {
        weekMap = fixedScheduleForWeek("monitoring", emp.monitoring_smena, weekMonday);
      } else {
        // 'radnik' override za lidera/monitoring u toj nedelji — van osnovnog obuhvata,
        // tretiramo kao slobodno (admin može ručno dodati smene te nedelje).
        weekMap = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(weekMonday); d.setDate(d.getDate() + i);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          weekMap[key] = "OFF";
        }
      }

      Object.entries(weekMap).forEach(([key, val]) => {
        if (!inRange(key, w.start, w.end)) return;
        const forced = forcedOff[emp.id] && forcedOff[emp.id].has(key);
        out[emp.id][key] = forced ? "OFF" : val;
      });
    });
  });
  return out;
}

// ------------------------------------------------------------
// RADNICI — po šablonu iz doc/RASPORED.xlsx.
//
// Faza 1: osnovni ciklus dužine N (N = broj radnika). Radnik 1 kreće od 1. u mesecu,
//         radnik 2 istim nizom od 2. itd. — pa svaki dan ima tačno minimalan broj
//         ljudi po smeni (npr. 2/2/2), uključujući vikend.
// Faza 2: radnim danima (ne vikend/praznik) dopuna do maksimuma po smeni, dok radnici
//         ne dostignu fond. Prvo se pune smene sa opsegom 2/3 (redom I, III, II),
//         pa tek onda 3/4 — po jedna smena po danu u krugu, da bude ravnomerno.
//         Dodata smena se uvek naslanja na postojeći blok; dozvoljeno je i
//         "prebacivanje" iz Excela (crveno): II blok -> prvi dan postaje I, a II se
//         dodaje posle bloka; ili poslednji II postaje III, a II se dodaje pre bloka.
// Faza 3: vikendom/praznikom dopuna samo radnicima koji i dalje nemaju pun fond.
// Faza 4: ko ima više od fonda — skida se III posle koje slede tačno 2 slobodna dana,
//         samo subotom, nedeljom i ponedeljkom. Ostatak viška admin skida ručno.
//
// Pravila koja važe za svaku izmenu:
//  - posle III (kad se III blok završi) moraju 2 slobodna dana;
//  - posle II ne sme odmah I;
//  - najviše 5 smena u nizu; najviše 2 III, 3 I, 4 II zaredom.
// ------------------------------------------------------------

// Tačni osnovni ciklusi iz Excela (ključ: opsezi I,II,III -> broj radnika).
const XLSX_BASE_CYCLES = {
  "2/3,2/3,2/3": {
    10: "I I III III S S II II S S",
    11: "I I III III S S S II II S S",
    12: "I I III III S S S II II S S S",
  },
  "2/3,3/4,2/3": { 13: "I I III S S S II II II III S S S" },
  "2/3,3/4,3/4": { 14: "I I III III S S S II II II III S S S" },
  "3/4,3/4,3/4": { 15: "I I I III III S S II II II III III S S S" },
};

function variantKey(variant) {
  const band = (code) => (variant.mins[code] === 3 ? "3/4" : "2/3");
  return `${band("I")},${band("II")},${band("III")}`;
}

// Vraća niz dužine n ("I"/"II"/"III"/"OFF") ili null ako je radnika premalo za izabranu kombinaciju.
function buildBaseCycle(variant, n) {
  const fixed = XLSX_BASE_CYCLES[variantKey(variant)] && XLSX_BASE_CYCLES[variantKey(variant)][n];
  if (fixed) return fixed.split(" ").map(x => (x === "S" ? "OFF" : x));

  // Za ostale brojeve radnika: I blok + III, slobodni, II blok (+ ostatak III), slobodni.
  const { I, II, III } = variant.mins;
  const p = Math.min(2, III);
  const q = III - p;
  const blockA = [...Array(I).fill("I"), ...Array(p).fill("III")];
  const blockB = [...Array(II).fill("II"), ...Array(q).fill("III")];
  const free = n - blockA.length - blockB.length;
  // posle III moraju 2 slobodna dana, posle II dovoljan je 1
  if (free < 2 + (q > 0 ? 2 : 1)) return null;
  const gap1 = Math.ceil(free / 2);
  const gap2 = free - gap1;
  return [...blockA, ...Array(gap1).fill("OFF"), ...blockB, ...Array(gap2).fill("OFF")];
}

const SHIFT_CODES = ["I", "II", "III"];
const MAX_SAME_RUN = { I: 3, II: 4, III: 2 };
const isWorkShift = (v) => v === "I" || v === "II" || v === "III";

// twoOffAfterBlock: za zamene — posle SVAKOG bloka (ne samo posle III) moraju 2 slobodna dana.
function countSeqViolations(st, lo, hi, twoOffAfterBlock) {
  let v = 0;
  for (let x = lo; x <= hi; x++) {
    const a = st(x), b = st(x + 1);
    if (a === "III" && (b === "I" || b === "II")) v++;
    if ((a === "III" || (twoOffAfterBlock && isWorkShift(a))) && b === "OFF" && isWorkShift(st(x + 2))) v++;
    if (a === "II" && b === "I") v++;
  }
  let run = 0, same = 0, prev = null;
  for (let x = lo; x <= hi + 1; x++) {
    const a = x <= hi ? st(x) : "OFF";
    if (isWorkShift(a)) {
      run++;
      same = a === prev ? same + 1 : 1;
      if (same > MAX_SAME_RUN[a]) v++;
    } else {
      if (run > 5) v += run - 5;
      run = 0; same = 0;
    }
    prev = a;
  }
  return v;
}


// Mali deterministički generator slučajnih brojeva (isti seed -> isti raspored).
function seededRandom(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------
// PRELAZ IZ MESECA U MESEC
// prevTail: employeeId -> { 0: smena poslednjeg dana prošlog meseca, -1: dan pre, ... -6 }
// Pravila na prelazu (st(0) = poslednji dan prošlog meseca, st(1) = 1. u mesecu):
//  - jedan S posle smena -> još jedan S;
//  - jedna III na kraju -> još jedna III (pa S, S); dve III -> S, S (to već važi uvek);
//  - posle II samo II ili III, posle I nastavak niza (I, II ili III) — blok se nastavlja
//    dok ne dostigne 5 dana (to je "meko" pravilo, ostala su obavezna).
// ------------------------------------------------------------
function runEndingAt(st, x) {
  let run = 0;
  for (let k = x; k >= x - 6 && isWorkShift(st(k)); k--) run++;
  return run;
}

function boundaryHardViolations(st) {
  let v = 0;
  if (isWorkShift(st(-1)) && st(0) === "OFF" && isWorkShift(st(1))) v++;
  // jedna III na kraju -> još jedna III, osim ako je već 5 smena zaredom (tada S, S)
  if (st(0) === "III" && st(-1) !== "III" && st(1) !== "III" && runEndingAt(st, 0) < 5) v++;
  // posle I ili II blok se nastavlja (I -> I/II/III, II -> II/III) dok ne dostigne 5 dana
  if ((st(0) === "I" || st(0) === "II") && !isWorkShift(st(1)) && runEndingAt(st, 0) < 5) v++;
  return v;
}

function boundarySoftBreak(st) {
  const last = st(0);
  if (!isWorkShift(last) || isWorkShift(st(1))) return 0;
  if (last === "III" && st(-1) === "III") return 0; // III, III -> S, S je ispravno
  return runEndingAt(st, 0) < 5 ? 1 : 0;
}

// Hungarian (minimalna dodela) — cost[i][j] za radnika i i poziciju u krugu j; vraća assign[i] = j.
function minCostAssignment(cost) {
  const n = cost.length;
  const INF = 1e15;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const assign = new Array(n);
  for (let j = 1; j <= n; j++) if (p[j]) assign[p[j] - 1] = j - 1;
  return assign;
}

// Za svakog redovnog radnika bira poziciju u krugu za 1. u mesecu (svaka pozicija tačno jednom,
// da svaki dan i dalje ima minimum po smeni) tako da se niz iz prošlog meseca nastavi.
// Bez podataka iz prošlog meseca: radnik 1 kreće od početka kruga 1., radnik 2 od 2. itd.
function chooseStartPositions(radnici, cycle, prevTail) {
  const N = radnici.length;
  const startPos = {};
  const tailOf = (id) => (prevTail && prevTail[id]) || {};
  const hasPrev = radnici.some(e => Object.values(tailOf(e.id)).some(isWorkShift));
  if (!hasPrev) {
    radnici.forEach((e, idx) => { startPos[e.id] = ((-idx % N) + N) % N; });
    return startPos;
  }
  const cost = radnici.map(e => {
    const tail = tailOf(e.id);
    const tailHasWork = Object.values(tail).some(isWorkShift);
    return cycle.map((_, pos) => {
      const st = (x) => (x <= 0 ? (tail[x] || "OFF") : cycle[(pos + x - 1) % N]);
      let c = 0;
      c += 1000 * countSeqViolations(st, -6, 8, false);
      c += 1000 * boundaryHardViolations(st);
      c += 50 * boundarySoftBreak(st);
      // prirodni nastavak: krug "unazad" od ove pozicije liči na ono što je radnik stvarno radio
      if (tailHasWork) {
        for (let k = 0; k >= -6; k--) {
          if (cycle[(((pos + k - 1) % N) + N) % N] !== (tail[k] || "OFF")) c += 1;
        }
      }
      return c;
    });
  });
  const assign = minCostAssignment(cost);
  radnici.forEach((e, i) => { startPos[e.id] = assign[i]; });
  return startPos;
}

// Pravi više pokušaja (različit redosled kad su radnici/dani "izjednačeni") i bira
// raspored gde najviše radnika ima pun fond; zatim najmanje viška i najmanje vikend-dopune.
const GENERATOR_ATTEMPTS = 300;

// opts (zamene):
//   zamene:       [{id}] — zamenski radnici ovog meseca; NE ulaze u osnovni ciklus (N = samo redovni radnici)
//   replacements: [{replacerId, vacationerId, dates: [dateStr]}] — dani odmora koje zamena preuzima
//   fixedNoVac:   employeeId -> {dateStr: smena} — raspored lidera/monitoringa kao da nisu na odmoru
//                 (kad zamena menja lidera ili monitoring)
function generateRadniciSchedule(radnici, variant, year, month, weeks, weeklyOverridesMap, forcedOff, monitoringFixedForOverrides, opts) {
  opts = { ...(opts || {}) };
  const baseCycle = buildBaseCycle(variant, radnici.length);
  if (baseCycle) opts.startPos = chooseStartPositions(radnici, baseCycle, opts.prevTail);
  let best = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < GENERATOR_ATTEMPTS; attempt++) {
    const rng = attempt === 0 ? null : seededRandom(attempt);
    const res = generateRadniciAttempt(radnici, variant, year, month, weeks, weeklyOverridesMap, forcedOff, monitoringFixedForOverrides, rng, opts);
    const score = res.deficit * 1000 + res.overfond.length * 100 + res.weekendExtra;
    if (score < bestScore) { best = res; bestScore = score; }
    if (res.deficit === 0 && res.overfond.length === 0 && res.weekendExtra === 0) break;
  }
  return best;
}

function generateRadniciAttempt(radnici, variant, year, month, weeks, weeklyOverridesMap, forcedOff, monitoringFixedForOverrides, rng, opts) {
  const nDays = daysInMonth(year, month);
  const fondTarget = monthFond(year, month);
  const N = radnici.length;
  const zamene = opts.zamene || [];
  const everyone = [...radnici, ...zamene];
  const zameneIds = new Set(zamene.map(e => e.id));

  const scheduleMap = {};
  const protectedOff = {}; // employeeId -> Set(dateStr) dana koji se NE diraju (odmor/slobodan/druga funkcija)
  const notCounted = {};   // employeeId -> Set(dateStr) smene lidera/monitoringa — ne ulaze u broj radnika po smeni
  const handoverFor = {};  // zamenaId -> {dateStr: vacationerId} — smene preuzete od osobe na odmoru
  if (!N) return { scheduleMap, fondByEmployee: {}, fondTarget, overfond: [], deficit: 0, weekendExtra: 0, handoverFor };

  const cycle = buildBaseCycle(variant, N);
  if (!cycle) {
    throw new Error(`Premalo radnika (${N}) za izabranu kombinaciju smena. Izaberi manju kombinaciju ili klikni "Primeni predlog".`);
  }

  // ---------- Faza 1 — osnovni ciklus (samo redovni radnici) ----------
  const cycleIndex = {}; // employeeId -> pozicija u krugu na dan 1.
  everyone.forEach(emp => { notCounted[emp.id] = new Set(); });
  radnici.forEach((emp, idx) => {
    scheduleMap[emp.id] = {};
    protectedOff[emp.id] = new Set();
    cycleIndex[emp.id] = opts.startPos && opts.startPos[emp.id] !== undefined ? opts.startPos[emp.id] : ((-idx % N) + N) % N;

    for (let d = 1; d <= nDays; d++) {
      const key = dateKey(year, month, d);
      const weekEntry = weeks.find(w => inRange(key, w.start, w.end));
      const override = weekEntry && weeklyOverridesMap[emp.id] && weeklyOverridesMap[emp.id][weekEntry.number];

      if ((forcedOff[emp.id] && forcedOff[emp.id].has(key)) || override === "slobodan" || override === "ne_radi") {
        scheduleMap[emp.id][key] = "OFF";
        protectedOff[emp.id].add(key);
        continue;
      }

      if (override === "monitoring" || override === "shift_lider") {
        const fixedVal = monitoringFixedForOverrides && monitoringFixedForOverrides[emp.id] && monitoringFixedForOverrides[emp.id][key];
        scheduleMap[emp.id][key] = fixedVal || "OFF";
        protectedOff[emp.id].add(key); // nije deo radničkog ciklusa
        notCounted[emp.id].add(key);
        continue;
      }

      scheduleMap[emp.id][key] = cycle[(cycleIndex[emp.id] + d - 1) % N];
    }
  });

  // Zamenski radnici kreću od praznog meseca (osim sopstvenog odmora / druge funkcije).
  zamene.forEach(emp => {
    scheduleMap[emp.id] = {};
    protectedOff[emp.id] = new Set();
    handoverFor[emp.id] = {};
    for (let d = 1; d <= nDays; d++) {
      const key = dateKey(year, month, d);
      const weekEntry = weeks.find(w => inRange(key, w.start, w.end));
      const override = weekEntry && weeklyOverridesMap[emp.id] && weeklyOverridesMap[emp.id][weekEntry.number];
      scheduleMap[emp.id][key] = "OFF";
      if ((forcedOff[emp.id] && forcedOff[emp.id].has(key)) || override === "slobodan" || override === "ne_radi") {
        protectedOff[emp.id].add(key);
      } else if (override === "monitoring" || override === "shift_lider") {
        const fixedVal = monitoringFixedForOverrides && monitoringFixedForOverrides[emp.id] && monitoringFixedForOverrides[emp.id][key];
        scheduleMap[emp.id][key] = fixedVal || "OFF";
        protectedOff[emp.id].add(key);
        notCounted[emp.id].add(key);
      }
    }
  });

  // Zamena preuzima smene koje bi osoba na odmoru imala tih dana — redom po danima, i samo ako
  // time ne krši pravila niza (npr. kraj jedne zamene III, a sledeći dan početak druge zamene I).
  // Takav dan zamena preskače; tu smenu kasnije popunjava neko drugi (korak "rupa ispod minimuma").
  const handoverItems = [];
  (opts.replacements || []).forEach(({ replacerId, vacationerId, dates }) => {
    if (!scheduleMap[replacerId] || !handoverFor[replacerId]) return;
    dates.forEach(key => handoverItems.push({ replacerId, vacationerId, key }));
  });
  handoverItems.sort((x, y) => x.replacerId.localeCompare(y.replacerId) || x.key.localeCompare(y.key));
  const handoverState = (id) => (x) => {
    if (x < 1) return (opts.prevTail && opts.prevTail[id] && opts.prevTail[id][x]) || "OFF";
    if (x > nDays) return "OFF";
    return scheduleMap[id][dateKey(year, month, x)];
  };
  handoverItems.forEach(({ replacerId, vacationerId, key }) => {
    if (protectedOff[replacerId].has(key)) return; // zamena je i sama slobodna/na odmoru
    const d = Number(key.slice(8, 10));
    let value;
    let counted = true;
    if (cycleIndex[vacationerId] !== undefined) {
      value = cycle[(cycleIndex[vacationerId] + d - 1) % N];
    } else {
      value = opts.fixedNoVac && opts.fixedNoVac[vacationerId] && opts.fixedNoVac[vacationerId][key];
      counted = false; // menja lidera/monitoring — ne računa se u radnike po smeni
    }
    if (!isWorkShift(value)) return;
    const st = handoverState(replacerId);
    const violations = () => countSeqViolations(st, d - 7, d + 7, false);
    const before = violations();
    const fits = () => countSeqViolations(x => (x === d ? value : st(x)), d - 7, d + 7, false) <= before;
    if (!fits()) {
      // Sudar dve zamene (prethodni dan III, ovaj dan I/II): bolje je pustiti jednu III juče
      // (1 dan za drugog radnika) nego preskočiti dva dana danas i sutra (2 slobodna posle III).
      const prevKey = d > 1 ? dateKey(year, month, d - 1) : null;
      const prevIsHandover = prevKey && handoverFor[replacerId][prevKey] && st(d - 1) === "III";
      if (!prevIsHandover) return;
      const saved = { v: scheduleMap[replacerId][prevKey], nc: notCounted[replacerId].has(prevKey), vac: handoverFor[replacerId][prevKey] };
      scheduleMap[replacerId][prevKey] = "OFF";
      protectedOff[replacerId].delete(prevKey);
      notCounted[replacerId].delete(prevKey);
      delete handoverFor[replacerId][prevKey];
      if (countSeqViolations(x => (x === d ? value : st(x)), d - 7, d + 7, false) > violations()) {
        scheduleMap[replacerId][prevKey] = saved.v; // ni to ne pomaže — vrati kako je bilo
        protectedOff[replacerId].add(prevKey);
        if (saved.nc) notCounted[replacerId].add(prevKey);
        handoverFor[replacerId][prevKey] = saved.vac;
        return;
      }
    }
    scheduleMap[replacerId][key] = value;
    protectedOff[replacerId].add(key);
    if (!counted) notCounted[replacerId].add(key);
    handoverFor[replacerId][key] = vacationerId;
  });

  // ---------- pomoćne strukture ----------
  const keys = [];
  const weekendLike = [];
  const dow = [];
  for (let d = 1; d <= nDays; d++) {
    keys[d] = dateKey(year, month, d);
    const dt = new Date(year, month - 1, d);
    weekendLike[d] = isHolidayOrWeekendLike(dt);
    dow[d] = dt.getDay();
  }

  const prevTail = opts.prevTail || {};
  const get = (id, d) => {
    if (d < 1) return (prevTail[id] && prevTail[id][d]) || "OFF"; // prethodni mesec
    if (d > nDays) return "OFF";
    return scheduleMap[id][keys[d]];
  };
  const isProtected = (id, d) => protectedOff[id].has(keys[d]);

  const counts = [];
  for (let d = 1; d <= nDays; d++) {
    counts[d] = { I: 0, II: 0, III: 0 };
    everyone.forEach(e => {
      const v = get(e.id, d);
      if (isWorkShift(v) && !notCounted[e.id].has(keys[d])) counts[d][v]++;
    });
  }
  const total = {};
  everyone.forEach(e => {
    total[e.id] = 0;
    for (let d = 1; d <= nDays; d++) if (isWorkShift(get(e.id, d))) total[e.id]++;
  });

  function countViolations(st, lo, hi, twoOffAfterBlock) {
    let v = countSeqViolations(st, lo, hi, twoOffAfterBlock);
    if (lo <= 1 && hi >= 0) v += boundaryHardViolations(st);
    return v;
  }

  // edits: { dan: novaSmena }. Proverava zaštićene dane, min/max po smeni i pravila niza.
  function editAllowed(id, edits, allowWeekend) {
    const days = Object.keys(edits).map(Number);
    for (const d of days) {
      if (d < 1 || d > nDays || isProtected(id, d)) return false;
      if (!allowWeekend && weekendLike[d]) return false;
      const oldV = get(id, d), newV = edits[d];
      if (isWorkShift(newV) && counts[d][newV] + 1 > variant.maxs[newV]) return false;
      if (isWorkShift(oldV) && counts[d][oldV] - 1 < variant.mins[oldV]) return false;
    }
    const lo = Math.min(...days) - 7, hi = Math.max(...days) + 7;
    const strict = zameneIds.has(id);
    const before = countViolations(x => get(id, x), lo, hi, strict);
    const after = countViolations(x => (x in edits ? edits[x] : get(id, x)), lo, hi, strict);
    return after <= before;
  }

  function applyEdits(id, edits) {
    Object.entries(edits).forEach(([dStr, newV]) => {
      const d = Number(dStr);
      const oldV = get(id, d);
      if (isWorkShift(oldV)) { counts[d][oldV]--; total[id]--; }
      if (isWorkShift(newV)) { counts[d][newV]++; total[id]++; }
      scheduleMap[id][keys[d]] = newV;
    });
  }

  function freeRunLen(id, d) {
    let a = d, b = d;
    while (a - 1 >= 1 && get(id, a - 1) === "OFF") a--;
    while (b + 1 <= nDays && get(id, b + 1) === "OFF") b++;
    return b - a + 1;
  }

  // Moguće izmene za radnika da bi dobio smenu `code` na dan d.
  function candidateEdits(id, d, code, requireAttach) {
    const out = [];
    const cur = get(id, d);
    if (cur === "OFF") {
      if (!requireAttach || isWorkShift(get(id, d - 1)) || isWorkShift(get(id, d + 1))) {
        out.push({ edits: { [d]: code }, pref: freeRunLen(id, d) >= 3 ? 0 : 1 });
      }
    } else if (cur === "II" && code === "I" && get(id, d - 1) !== "II") {
      let b = d; while (get(id, b + 1) === "II") b++;
      if (get(id, b + 1) === "OFF") out.push({ edits: { [d]: "I", [b + 1]: "II" }, pref: 2 });
    } else if (cur === "II" && code === "III" && get(id, d + 1) !== "II") {
      let a = d; while (get(id, a - 1) === "II") a--;
      if (get(id, a - 1) === "OFF") out.push({ edits: { [a - 1]: "II", [d]: "III" }, pref: 2 });
    }
    return out;
  }

  function tryFill(d, code, allowWeekend, requireAttach, pool = radnici) {
    const options = [];
    pool.forEach(emp => {
      if (total[emp.id] >= fondTarget) return;
      candidateEdits(emp.id, d, code, requireAttach).forEach(c => options.push({ id: emp.id, ...c }));
    });
    options.forEach(o => { o.tie = rng ? rng() : 0; });
    options.sort((a, b) => total[a.id] - total[b.id] || a.pref - b.pref || a.tie - b.tie);
    for (const o of options) {
      if (editAllowed(o.id, o.edits, allowWeekend)) {
        applyEdits(o.id, o.edits);
        return true;
      }
    }
    return false;
  }

  const ORDER = ["I", "III", "II"];
  // Redosled popunjavanja po kombinaciji. Svaka grupa se puni do kraja pre sledeće.
  // 2/3,3/4,2/3 (13 radnika): prvo III, pa I, pa tek na kraju II.
  const PHASES_BY_VARIANT = {
    "2/3,3/4,2/3": [["III"], ["I"], ["II"]],
  };
  const phases = PHASES_BY_VARIANT[variantKey(variant)] || [
    ORDER.filter(c => variant.mins[c] === 2),
    ORDER.filter(c => variant.mins[c] === 3),
  ].filter(p => p.length);

  function fillRounds(codes, dayFilter, allowWeekend, requireAttach = true, pool = radnici, limit = variant.maxs, shuffle = true) {
    let changed = true;
    while (changed) {
      changed = false;
      const dayOrder = [];
      for (let d = 1; d <= nDays; d++) if (dayFilter(d)) dayOrder.push(d);
      if (rng && shuffle) {
        for (let i = dayOrder.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [dayOrder[i], dayOrder[j]] = [dayOrder[j], dayOrder[i]];
        }
      }
      for (const d of dayOrder) {
        for (const code of codes) {
          if (counts[d][code] < limit[code] && tryFill(d, code, allowWeekend, requireAttach, pool)) changed = true;
        }
      }
    }
  }

  // ---------- Prelaz iz prošlog meseca — popravka prvih dana ----------
  // Ako krug na početku meseca ne nastavlja ispravno niz iz prošlog meseca (npr. jedna III
  // na kraju -> treba još jedna III), menja se 1.–3. dan dok prelaz ne bude ispravan.
  // Minimum po smeni se ovde privremeno ne gleda — rupe popunjava kasniji korak.
  function boundaryScore(id, edits) {
    const st = (x) => (x in edits ? edits[x] : get(id, x));
    return 1000 * (countSeqViolations(st, -6, 9, zameneIds.has(id)) + boundaryHardViolations(st)) + boundarySoftBreak(st);
  }
  if (Object.keys(prevTail).length) {
    everyone.forEach(emp => {
      for (let iter = 0; iter < 3; iter++) {
        const base = boundaryScore(emp.id, {});
        if (base === 0) break;
        let best = null, bestScore = base;
        for (let d = 1; d <= Math.min(3, nDays); d++) {
          if (isProtected(emp.id, d)) continue;
          for (const val of ["OFF", "III", "II", "I"]) {
            if (val === get(emp.id, d)) continue;
            const sc = boundaryScore(emp.id, { [d]: val });
            if (sc >= bestScore) continue;
            if (isWorkShift(val) && counts[d][val] + 1 > variant.maxs[val]) {
              // Smena je puna — preuzmi je od nekog kome to ne kvari niz.
              const donor = everyone.find(o =>
                o.id !== emp.id && get(o.id, d) === val && !isProtected(o.id, d) &&
                Math.floor(boundaryScore(o.id, { [d]: "OFF" }) / 1000) <= Math.floor(boundaryScore(o.id, {}) / 1000)
              );
              if (!donor) continue;
              bestScore = sc; best = { [d]: val }; best.__donor = donor.id;
              continue;
            }
            bestScore = sc; best = { [d]: val };
          }
        }
        // i dva susedna dana odjednom (npr. III, III na kraju prošlog meseca -> S, S)
        const VALS = ["OFF", "III", "II", "I"];
        for (let d = 1; d + 1 <= Math.min(3, nDays); d++) {
          if (isProtected(emp.id, d) || isProtected(emp.id, d + 1)) continue;
          for (const v1 of VALS) for (const v2 of VALS) {
            const edits = { [d]: v1, [d + 1]: v2 };
            if (v1 === get(emp.id, d) || v2 === get(emp.id, d + 1)) continue;
            if (Object.entries(edits).some(([dd, val]) => isWorkShift(val) && counts[dd][val] + 1 > variant.maxs[val])) continue;
            const sc = boundaryScore(emp.id, edits);
            if (sc < bestScore) { bestScore = sc; best = edits; }
          }
        }
        if (!best) break;
        const donorId = best.__donor;
        delete best.__donor;
        if (donorId) applyEdits(donorId, Object.fromEntries(Object.keys(best).map(d => [d, "OFF"])));
        applyEdits(emp.id, best);
      }
    });
  }

  // ---------- Zamene — pun fond, PRE dopune redovnih radnika ----------
  // Pored preuzetih smena (odmor), zamena radi u blokovima: najviše 5 dana rada,
  // pa 2 slobodna. Dani se idu redom da bi se blokovi nizali; smena se bira tamo
  // gde ima mesta do maksimuma (redosled smena isti kao za redovne radnike).
  if (zamene.length) {
    const allCodes = phases.flat();
    fillRounds(allCodes, () => true, true, false, zamene, variant.maxs, false);
  }

  // ---------- Faza 2 — radni dani do maksimuma ----------
  phases.forEach(codes => fillRounds(codes, d => !weekendLike[d], false));

  // ---------- Faza 3 — vikend/praznik samo za one bez punog fonda ----------
  phases.forEach(codes => fillRounds(codes, d => weekendLike[d], true));

  // Poslednja mogućnost za one bez punog fonda: smena ne mora da se naslanja na blok
  // (npr. početak meseca kad su blokovi već po 5), ali sva pravila niza i dalje važe.
  phases.forEach(codes => fillRounds(codes, d => !weekendLike[d], false, false));
  phases.forEach(codes => fillRounds(codes, d => weekendLike[d], true, false));

  // Rupa ispod minimuma (npr. zbog odmora) — popuni bilo kim ko sme da radi taj dan.
  for (let d = 1; d <= nDays; d++) {
    for (const code of ORDER) {
      while (counts[d][code] < variant.mins[code]) {
        const options = everyone
          .filter(e => get(e.id, d) === "OFF")
          .sort((a, b) => total[a.id] - total[b.id]);
        const pick = options.find(e => editAllowed(e.id, { [d]: code }, true));
        if (pick) { applyEdits(pick.id, { [d]: code }); continue; }
        // Niko slobodan ne može — neko iz smene sa viškom tog dana prelazi u ovu (ako pravila dozvoljavaju).
        const mover = everyone.find(e => {
          const cur = get(e.id, d);
          return isWorkShift(cur) && cur !== code && !notCounted[e.id].has(keys[d]) &&
            counts[d][cur] > variant.mins[cur] && editAllowed(e.id, { [d]: code }, true);
        });
        if (!mover) break;
        applyEdits(mover.id, { [d]: code });
      }
    }
  }

  // ---------- Faza 4 — višak smena ----------
  everyone.forEach(emp => {
    for (let d = 1; d <= nDays && total[emp.id] > fondTarget; d++) {
      const satSunMon = dow[d] === 6 || dow[d] === 0 || dow[d] === 1;
      if (!satSunMon || get(emp.id, d) !== "III" || isProtected(emp.id, d)) continue;
      const exactlyTwoFree = d + 3 <= nDays && get(emp.id, d + 1) === "OFF" && get(emp.id, d + 2) === "OFF" && isWorkShift(get(emp.id, d + 3));
      if (!exactlyTwoFree || counts[d].III - 1 < variant.mins.III) continue;
      applyEdits(emp.id, { [d]: "OFF" });
    }
  });

  const fondByEmployee = {};
  everyone.forEach(emp => {
    const vals = Object.values(scheduleMap[emp.id]);
    fondByEmployee[emp.id] = {
      I: vals.filter(v => v === "I").length,
      II: vals.filter(v => v === "II").length,
      III: vals.filter(v => v === "III").length,
      total: total[emp.id],
    };
  });
  const overfond = everyone.filter(e => total[e.id] > fondTarget).map(e => e.id);

  let deficit = 0;
  radnici.forEach(e => { deficit += Math.max(0, fondTarget - total[e.id]); });
  let weekendExtra = 0;
  for (let d = 1; d <= nDays; d++) {
    if (!weekendLike[d]) continue;
    SHIFT_CODES.forEach(c => { weekendExtra += Math.max(0, counts[d][c] - variant.mins[c]); });
  }

  return { scheduleMap, fondByEmployee, fondTarget, overfond, deficit, weekendExtra, handoverFor };
}

// ------------------------------------------------------------
// Vikend lideri: subotom, nedeljom i praznikom svaka smena bez shift lidera dobija lidera.
// Prvo među čekiranim "Vikend lider" radnicima u toj smeni (ko je najmanje puta bio lider),
// a ako u smeni nema nijednog čekiranog — nasumično neki radnik iz te smene.
// combined: employeeId -> {dateStr: "I"|"II"|"III"|...}
// Vraća Set ključeva "employeeId|dateStr".
// ------------------------------------------------------------
// presetLeaders: ključevi "employeeId|dateStr" koji su već lideri (zamena za shift lidera) — ta smena se preskače.
function assignWeekendLeaders(combined, employees, vikendLiderIds, random = Math.random, presetLeaders = new Set()) {
  const funkcijaById = {};
  employees.forEach(e => { funkcijaById[e.id] = e.funkcija; });
  const byDayShift = {}; // "date|smena" -> [employeeId]
  Object.entries(combined).forEach(([empId, dayMap]) => {
    Object.entries(dayMap).forEach(([date, state]) => {
      if (state !== "I" && state !== "II" && state !== "III") return;
      (byDayShift[`${date}|${state}`] = byDayShift[`${date}|${state}`] || []).push(empId);
    });
  });

  const leaders = new Set();
  const timesLeader = {};
  const pick = arr => arr[Math.floor(random() * arr.length)];
  Object.keys(byDayShift).sort().forEach(key => {
    const [date] = key.split("|");
    if (!isHolidayOrWeekendLike(new Date(date + "T00:00:00"))) return;
    const people = byDayShift[key];
    if (people.some(id => funkcijaById[id] === "shift_lider" || presetLeaders.has(`${id}|${date}`))) return;
    const radnici = people.filter(id => funkcijaById[id] === "radnik");
    if (!radnici.length) return;
    const checked = radnici.filter(id => vikendLiderIds.has(id));
    let chosen;
    if (checked.length) {
      const least = Math.min(...checked.map(id => timesLeader[id] || 0));
      chosen = pick(checked.filter(id => (timesLeader[id] || 0) === least));
    } else {
      chosen = pick(radnici);
    }
    timesLeader[chosen] = (timesLeader[chosen] || 0) + 1;
    leaders.add(`${chosen}|${date}`);
  });
  return leaders;
}

if (typeof module !== "undefined") {
  module.exports = {
    buildBaseCycle, SHIFT_VARIANTS, findVariant, daysInMonth, monthFond, dateKey,
    isoWeekNumber, orthodoxEasterDate, isHolidayOrWeekendLike,
    generateFixedFunctionSchedule, generateRadniciSchedule, liderShiftForWeek,
    fixedScheduleForWeek, assignWeekendLeaders,
  };
}
