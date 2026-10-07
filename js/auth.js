// Deljena logika za header, sesiju i proveru admin pristupa.
// Očekuje da je prethodno učitan js/supabase.js (globalni `sb` klijent).

async function getSessionAndProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { session: null, profile: null };
  const { data: profile } = await sb
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();
  return { session, profile };
}

async function mountHeader(activeKey) {
  const mount = document.getElementById("app-header-mount");
  if (!mount) return { session: null, profile: null };

  const { session, profile } = await getSessionAndProfile();
  // Tablet na ulazu ne koristi ostatak aplikacije.
  if (profile && profile.role === "terminal") { window.location.href = APP_BASE + "terminal.html"; return { session: null, profile: null }; }

  let apiOk = true;
  try {
    const { error } = await sb.from("shift_types").select("code").limit(1);
    apiOk = !error;
  } catch (e) {
    apiOk = false;
  }

  const navLinks = [
    `<a href="${APP_BASE}index.html" class="${activeKey === "raspored" ? "active" : ""}">Raspored</a>`,
  ];
  if (profile && profile.role === "admin") {
    navLinks.push(
      `<a href="${APP_BASE}admin/index.html#osobe" data-admin-tab="osobe" class="${activeKey === "admin-osobe" ? "active" : ""}">Osobe u sistemu</a>`,
      `<a href="${APP_BASE}admin/index.html#plan" data-admin-tab="plan" class="${activeKey === "admin-plan" ? "active" : ""}">Plan zaposlenih</a>`,
      `<a href="${APP_BASE}admin/index.html#rasporedi" data-admin-tab="rasporedi" class="${activeKey === "admin-rasporedi" ? "active" : ""}">Generisanje rasporeda</a>`,
      `<a href="${APP_BASE}admin/index.html#dolasci" data-admin-tab="dolasci" class="${activeKey === "admin-dolasci" ? "active" : ""}">Dolasci</a>`
    );
  }
  if (profile && profile.role === "management") {
    navLinks.push(`<a href="${APP_BASE}dolasci.html" class="${activeKey === "dolasci" ? "active" : ""}">Dolasci</a>`);
  }
  if (session) {
    navLinks.push(
      `<a href="${APP_BASE}zamene.html" class="${activeKey === "zamene" ? "active" : ""}">Zamene<span class="nav-badge" id="nav-zamene-badge" hidden></span></a>`
    );
  } else {
    navLinks.push(
      `<a href="${APP_BASE}login.html" class="${activeKey === "login" ? "active" : ""}">Login</a>`
    );
  }

  const rightHTML = session && profile
    ? `
      <div class="user-chip">
        <div class="role">${({ admin: "Administrator", management: "Management" })[profile.role] || "Radnik"}${profile.hr_manager ? " · HR" : ""}</div>
        <div class="username">${profile.username}</div>
      </div>
      <button class="btn-password btn-push" id="push-btn" type="button">🔕 Uključi obaveštenja</button>
      <button class="btn-password" id="password-btn" type="button">Promeni lozinku</button>
      <button class="btn-logout" id="logout-btn" type="button">Odjava</button>
    `
    : "";

  mount.innerHTML = `
    <div class="brand">
      <div class="brand-logo"><img src="${APP_BASE}icons/logo.png" alt="Logo" /></div>
      <div>
        <div class="brand-name">Raspored App</div>
        <div class="brand-sub">Smene bez nagađanja</div>
      </div>
    </div>
    <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Meni" aria-expanded="false">
      <span></span><span></span><span></span><i class="menu-dot" id="menu-dot" hidden></i>
    </button>
    <div class="header-menu" id="header-menu">
      <nav>${navLinks.join("")}</nav>
      <div class="header-right">
        <span class="api-dot ${apiOk ? "" : "offline"}">${apiOk ? "API povezan" : "API nedostupan"}</span>
        ${rightHTML}
      </div>
    </div>
  `;

  // Telefon: sve osim naziva aplikacije je u meniju (hamburger).
  const toggle = document.getElementById("menu-toggle");
  const setOpen = (open) => {
    mount.classList.toggle("menu-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  };
  toggle.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!mount.classList.contains("menu-open")); });
  document.addEventListener("click", (e) => {
    if (!mount.classList.contains("menu-open")) return;
    if (!e.target.closest("#header-menu") || e.target.closest("a, button")) setOpen(false);
  });

  const logoutBtn = document.getElementById("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      if (typeof pushForgetDevice === "function") await pushForgetDevice();
      await sb.auth.signOut();
      window.location.href = APP_BASE + "index.html";
    });
  }

  if (session) zmRefreshNavBadge(session, profile);
  if (session && profile && profile.role !== "management") mountCheckInButton(session);
  if (typeof pushRefreshButton === "function") pushRefreshButton();

  const passwordBtn = document.getElementById("password-btn");
  if (passwordBtn) passwordBtn.addEventListener("click", () => openPasswordDialog(session.user.email));

  return { session, profile };
}

// Dugme "Dolazak" na dnu ekrana (telefon) — samo za naloge povezane sa zaposlenim.
// Aktivno od 45 min pre početka smene do kraja smene (isto pravilo proverava i server u check_in).
const CHECKIN_BEFORE_MIN = 45;
const CHECKIN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>`;

async function mountCheckInButton(session) {
  if (document.getElementById("checkin-fab")) return;
  const { data: me } = await sb.from("employees").select("id, funkcija").eq("profile_id", session.user.id).maybeSingle();
  if (!me) return;

  const a = document.createElement("a");
  a.id = "checkin-fab";
  a.className = "checkin-fab is-off";
  a.href = APP_BASE + "dolazak.html";
  a.innerHTML = `${CHECKIN_ICON}<span class="checkin-fab-text"><b>Dolazak</b><small></small></span>`;
  a.addEventListener("click", (e) => { if (a.classList.contains("is-off")) e.preventDefault(); });
  document.body.appendChild(a);
  document.body.classList.add("has-checkin-fab");

  const now0 = typeof belgradeNow === "function" ? belgradeNow() : new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const day = (n) => iso(new Date(now0.getFullYear(), now0.getMonth(), now0.getDate() + n));
  const [{ data: types }, { data: shifts }, { data: done }] = await Promise.all([
    sb.from("shift_types").select("code, start_time"),
    sb.from("schedule").select("date, shift_code, is_medju_smena, is_leader").eq("employee_id", me.id).gte("date", day(-1)).lte("date", day(2)),
    sb.from("attendance").select("work_date, shift_code, checked_at").eq("employee_id", me.id).gte("work_date", day(-1)),
  ]);
  const startOf = Object.fromEntries((types || []).map(t => [t.code, t.start_time]));
  // Smene sa početkom i krajem po beogradskom vremenu (smena traje 8 h): međusmena počinje 6 h kasnije,
  // lideri (shift lider ili "Lider" u smeni) sat ranije — 6–14, 14–22, 22–6.
  const windows = (shifts || []).map(s => {
    const [y, m, d] = s.date.split("-").map(Number);
    const [h, min] = (startOf[s.shift_code] || "00:00").split(":").map(Number);
    const leader = s.is_leader || me.funkcija === "shift_lider";
    const start = new Date(y, m - 1, d, h + (s.is_medju_smena ? 6 : leader ? -1 : 0), min);
    const att = (done || []).find(x => x.work_date === s.date && x.shift_code === s.shift_code);
    return { start, end: new Date(start.getTime() + 8 * 3600e3), att };
  }).sort((x, y) => x.start - y.start);

  const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const small = a.querySelector("small");
  const refresh = () => {
    const now = typeof belgradeNow === "function" ? belgradeNow() : new Date();
    const cur = windows.find(w => now >= new Date(w.start.getTime() - CHECKIN_BEFORE_MIN * 60e3) && now < w.end);
    let on = false, note = "";
    if (cur && cur.att) {
      const t = new Date(cur.att.checked_at);
      note = `prijavljen/a ${t.toLocaleTimeString("sr-Latn", { timeZone: "Europe/Belgrade", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
    } else if (cur) {
      on = true;
    } else {
      const next = windows.find(w => w.start > now);
      if (next) {
        const opens = new Date(next.start.getTime() - CHECKIN_BEFORE_MIN * 60e3);
        const sameDay = iso(opens) === iso(now);
        const tomorrow = iso(opens) === iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
        note = `od ${sameDay ? "" : tomorrow ? "sutra " : opens.getDate() + "." + (opens.getMonth() + 1) + ". "}${hhmm(opens)}`;
      } else {
        note = "nema smene";
      }
    }
    a.classList.toggle("is-off", !on);
    a.setAttribute("aria-disabled", on ? "false" : "true");
    small.textContent = note;
    small.hidden = !note;
  };
  refresh();
  setInterval(refresh, 30 * 1000);
}

// Broj zahteva za zamenu koji čekaju MOJ odgovor (i HR odobrenje ako sam HR/admin).
async function zmRefreshNavBadge(session, profile) {
  const badge = document.getElementById("nav-zamene-badge");
  if (!badge) return;
  if (!session) ({ session, profile } = await getSessionAndProfile());
  if (!session) return;
  try {
    const { data: me } = await sb.from("employees").select("id").eq("profile_id", session.user.id).maybeSingle();
    let n = 0;
    if (me) {
      const { count } = await sb.from("swap_requests").select("id", { count: "exact", head: true })
        .eq("target_id", me.id).eq("status", "pending_worker");
      n += count || 0;
    }
    if (profile && (profile.hr_manager || profile.role === "admin")) {
      const { count } = await sb.from("swap_requests").select("id", { count: "exact", head: true }).eq("status", "pending_hr");
      n += count || 0;
    }
    badge.textContent = n;
    badge.hidden = !n;
    const dot = document.getElementById("menu-dot");
    if (dot) dot.hidden = !n;
  } catch (e) { /* tabela zamena još ne postoji */ }
}

// Promena sopstvene lozinke (i admin i radnik). Stara lozinka se proverava ponovnom prijavom.
function openPasswordDialog(email) {
  document.getElementById("pw-dialog")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "pw-dialog";
  overlay.className = "pw-overlay";
  overlay.innerHTML = `
    <form class="pw-box" novalidate>
      <h3>Promena lozinke</h3>
      <label>Trenutna lozinka<input type="password" name="current" autocomplete="current-password" required /></label>
      <label>Nova lozinka<input type="password" name="next" autocomplete="new-password" minlength="6" required /></label>
      <label>Ponovi novu lozinku<input type="password" name="repeat" autocomplete="new-password" minlength="6" required /></label>
      <div class="pw-msg"></div>
      <div class="pw-actions">
        <button type="button" class="btn btn-ghost pw-cancel">Otkaži</button>
        <button type="submit" class="btn btn-primary pw-save">Sačuvaj</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector("form");
  const msg = overlay.querySelector(".pw-msg");
  const close = () => overlay.remove();
  overlay.querySelector(".pw-cancel").addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const current = form.current.value, next = form.next.value, repeat = form.repeat.value;
    const show = (text, ok) => { msg.textContent = text; msg.className = `pw-msg ${ok ? "ok" : "err"}`; };
    if (!current || !next) return show("Popuni sva polja.");
    if (next.length < 6) return show("Nova lozinka mora imati bar 6 znakova.");
    if (next !== repeat) return show("Nove lozinke se ne poklapaju.");
    if (next === current) return show("Nova lozinka mora biti drugačija od trenutne.");

    const saveBtn = form.querySelector(".pw-save");
    saveBtn.disabled = true;
    const { error: signInError } = await sb.auth.signInWithPassword({ email, password: current });
    if (signInError) { saveBtn.disabled = false; return show("Trenutna lozinka nije tačna."); }
    const { error } = await sb.auth.updateUser({ password: next });
    saveBtn.disabled = false;
    if (error) return show("Greška: " + error.message);
    show("Lozinka je promenjena.", true);
    form.querySelectorAll("input").forEach(i => { i.value = ""; i.disabled = true; });
    saveBtn.hidden = true;
    overlay.querySelector(".pw-cancel").textContent = "Zatvori";
  });
  form.current.focus();
}

// Poziva se na admin stranicama — ako korisnik nije ulogovani admin, preusmerava ga.
async function requireAdmin() {
  const { session, profile } = await getSessionAndProfile();
  if (!session) {
    window.location.href = APP_BASE + "login.html";
    return null;
  }
  if (!profile || profile.role !== "admin") {
    window.location.href = APP_BASE + "index.html";
    return null;
  }
  return profile;
}
