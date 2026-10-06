// Obaveštenja na telefonu (web push): uključivanje/isključivanje po uređaju.
// Uređaj se pamti u bazi (push_subscriptions), a obaveštenja šalje Supabase funkcija send-push.
// iPhone: radi samo kad je aplikacija dodata na početni ekran (iOS 16.4+).

const PUSH_PUBLIC_KEY = "BEOkMigmkz7oDA6BZyo4mSD9NStx71mGNcwADBNgDjxFuPpFd05SUoPmxs5xdQwNs6Za0V9cewosZV9uAFmDbiA";

const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const pushIsIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const pushStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let pushReg = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(APP_BASE + "sw.js", { scope: APP_BASE })
    .then(reg => { pushReg = reg; pushSyncExisting(); pushRefreshButton(); })
    .catch(() => {});
}

function pushKeyBytes(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function pushCurrent() {
  if (!pushSupported) return null;
  const reg = pushReg || await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function pushSave(sub) {
  const j = sub.toJSON();
  const { error } = await sb.rpc("push_subscribe", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  return error;
}

// Ako su obaveštenja već uključena na ovom uređaju — osveži vezu sa prijavljenim korisnikom.
async function pushSyncExisting() {
  if (!pushSupported || Notification.permission !== "granted") return;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const sub = await pushCurrent();
  if (sub) await pushSave(sub);
  pushRefreshButton();
}

async function pushEnable() {
  if (!pushSupported) {
    alert(pushIsIOS && !pushStandalone
      ? "Na iPhone-u obaveštenja rade samo iz aplikacije na početnom ekranu:\n\n1. U Safari-ju dodirni dugme Deli (kvadrat sa strelicom)\n2. Izaberi „Dodaj na početni ekran“ (Add to Home Screen)\n3. Otvori aplikaciju sa ikonice RA i ovde uključi obaveštenja."
      : "Ovaj pregledač ne podržava obaveštenja. Probaj Chrome (Android) ili Safari (iPhone, iOS 16.4+).");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    alert("Obaveštenja nisu dozvoljena. Možeš ih uključiti u podešavanjima telefona za ovu aplikaciju.");
    pushRefreshButton();
    return;
  }
  try {
    const reg = pushReg || await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(PUSH_PUBLIC_KEY) });
    const error = await pushSave(sub);
    if (error) {
      alert(/push_subscribe/.test(error.message)
        ? "Obaveštenja još nisu uključena u bazi — treba pokrenuti SQL iz fajla sql/migration_008_push.sql u Supabase."
        : "Telefon nije sačuvan za obaveštenja. Greška: " + error.message);
    } else {
      const { data: { session } } = await sb.auth.getSession();
      const who = session ? session.user.email.split("@")[0] : "?";
      alert(`Obaveštenja su uključena na ovom telefonu za korisnika: ${who}`);
    }
  } catch (e) {
    alert("Uključivanje obaveštenja nije uspelo: " + e.message);
  }
  pushRefreshButton();
}

// Pri odjavi: ovaj uređaj više ne prima obaveštenja za tog korisnika.
async function pushForgetDevice() {
  try {
    const sub = await pushCurrent();
    if (!sub) return;
    await sb.rpc("push_unsubscribe", { p_endpoint: sub.endpoint });
    await sub.unsubscribe();
  } catch (e) { /* nije bitno */ }
}

async function pushDisable() {
  await pushForgetDevice();
  pushRefreshButton();
}

// "Uključena" samo ako telefon ima pretplatu I ona je zapisana u bazi za prijavljenog korisnika.
async function pushRefreshButton() {
  const btn = document.getElementById("push-btn");
  if (!btn) return;
  const sub = pushSupported && Notification.permission === "granted" ? await pushCurrent() : null;
  let saved = false;
  if (sub) {
    const { data } = await sb.from("push_subscriptions").select("id").eq("endpoint", sub.endpoint);
    saved = !!(data && data.length);
  }
  btn.dataset.on = saved ? "1" : "";
  btn.textContent = saved ? "🔔 Obaveštenja uključena" : sub ? "⚠️ Obaveštenja nisu sačuvana — dodirni" : "🔕 Uključi obaveštenja";
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest && e.target.closest("#push-btn");
  if (!btn) return;
  if (btn.dataset.on) {
    if (confirm("Isključiti obaveštenja na ovom uređaju?")) await pushDisable();
  } else {
    await pushEnable();
  }
});
