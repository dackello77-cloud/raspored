// Tablet na ulazu: prikazuje QR kod koji server menja na svakih 20 s.
// Radnik ga skenira u aplikaciji (dolazak.html) i tako prijavljuje dolazak.

const qrBox = document.getElementById("qr");
const bar = document.getElementById("t-bar");
const hint = document.getElementById("t-hint");
const HINT_HTML = hint.innerHTML;

let tokenTimer = null;

document.getElementById("t-fs").addEventListener("click", () => {
  document.documentElement.requestFullscreen?.().catch(() => {});
  keepScreenOn();
});

// Ekran tableta ne sme da se ugasi.
let wakeLock = null;
async function keepScreenOn() {
  try { if (!wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* nije podržano */ }
  if (wakeLock) wakeLock.addEventListener("release", () => { wakeLock = null; }, { once: true });
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { keepScreenOn(); fetchToken(); }
});

function showQr(token) {
  const url = `${location.origin}${APP_BASE}dolazak.html?t=${encodeURIComponent(token)}`;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  qrBox.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  qrBox.style.opacity = "1";
  hint.innerHTML = HINT_HTML;
  hint.className = "t-hint";
}

function showError(text) {
  qrBox.style.opacity = "0.08";
  hint.textContent = text;
  hint.className = "t-msg";
}

function animateBar(seconds) {
  bar.style.transition = "none";
  bar.style.transform = `scaleX(${Math.min(1, seconds / 20)})`;
  bar.getBoundingClientRect();
  bar.style.transition = `transform ${seconds}s linear`;
  bar.style.transform = "scaleX(0)";
}

async function fetchToken() {
  clearTimeout(tokenTimer);
  try {
    const { data, error } = await sb.rpc("terminal_token");
    if (error) throw error;
    showQr(data.token);
    animateBar(data.expires_in);
    tokenTimer = setTimeout(fetchToken, data.expires_in * 1000 + 300);
  } catch (e) {
    console.error(e);
    showError(navigator.onLine ? "Greška: " + (e.message || "server nije dostupan") + " — pokušavam ponovo…" : "Nema interneta — pokušavam ponovo…");
    tokenTimer = setTimeout(fetchToken, 3000);
  }
}

async function refreshRecent() {
  try {
    const { data, error } = await sb.rpc("terminal_recent");
    if (error) return;
    const box = document.getElementById("t-recent");
    const html = (data || []).map(r =>
      `<span class="${r.late_minutes > 0 ? "late" : ""}">✓ ${r.full_name} · ${r.checked_time}${r.late_minutes > 0 ? ` · kasni ${r.late_minutes} min` : ""}</span>`
    ).join("");
    if (box.innerHTML !== html) box.innerHTML = html;
  } catch (e) { /* sledeći put */ }
}

function tickClock() {
  const n = belgradeNow();
  const dow = ["Nedelja", "Ponedeljak", "Utorak", "Sreda", "Četvrtak", "Petak", "Subota"][n.getDay()];
  document.getElementById("t-clock").textContent =
    `${dow}, ${n.getDate()}. ${MONTH_NAMES_SR[n.getMonth()]} · ${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
}

(async () => {
  tickClock();
  setInterval(tickClock, 5000);
  const { session, profile } = await getSessionAndProfile();
  if (!session) { location.href = APP_BASE + "login.html?next=terminal.html"; return; }
  if (!profile || !(profile.role === "terminal" || isAdminProfile(profile))) {
    showError("Ovaj nalog nije terminal. Prijavi se kao „terminal“.");
    return;
  }
  keepScreenOn();
  fetchToken();
  refreshRecent();
  setInterval(refreshRecent, 4000);
})();
