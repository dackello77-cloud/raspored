// Prijava dolaska: radnik skenira QR kod sa tableta na ulazu (terminal.html).
// Kod se može skenirati i običnom kamerom telefona — on otvara ovu stranicu sa ?t=...

const video = document.getElementById("dz-video");
const tip = document.getElementById("dz-tip");
const resultBox = document.getElementById("dz-result");
const SHIFT_NAMES = { I: "I smena", II: "II smena", III: "III smena" };

let stream = null;
let scanning = false;
let busy = false;
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

document.getElementById("dz-retry").addEventListener("click", () => {
  resultBox.hidden = true;
  startCamera();
});

// Token iz skeniranog teksta: ceo link (…/dolazak.html?t=…) ili sam token.
function tokenFrom(text) {
  try {
    const t = new URL(text).searchParams.get("t");
    if (t) return t;
  } catch (e) { /* nije link */ }
  return /^\d+\.[0-9a-f]+$/.test(text) ? text : null;
}

function showResult({ kind, title, big = "", extra = "", text = "", retry = false }) {
  stopCamera();
  document.getElementById("dz-icon").className = `dz-icon ${kind}`;
  document.getElementById("dz-icon").textContent = kind === "err" ? "!" : "✓";
  document.getElementById("dz-title").textContent = title;
  document.getElementById("dz-big").textContent = big;
  document.getElementById("dz-extra").innerHTML = extra;
  document.getElementById("dz-text").textContent = text;
  document.getElementById("dz-retry").hidden = !retry;
  resultBox.hidden = false;
  if (navigator.vibrate) navigator.vibrate(kind === "err" ? [80, 60, 80] : 120);
}

async function submitToken(token) {
  busy = true;
  tip.textContent = "Prijavljujem…";
  const { data, error } = await sb.rpc("check_in", { p_token: token });
  busy = false;
  if (error) {
    showResult({ kind: "err", title: "Prijava nije uspela", text: error.message, retry: true });
    return;
  }
  // Obaveštenje HR-u, adminu i Management-u (funkcija send-push; ne čeka se odgovor).
  if (!data.already) sb.functions.invoke("send-push", { body: { checkin: true } }).catch(() => {});
  const firstName = (data.full_name || "").split(" ")[0];
  const shift = data.shift_code
    ? `${SHIFT_NAMES[data.shift_code] || data.shift_code}${data.is_medju_smena ? " (međusmena)" : ""}`
    : "";
  if (data.already) {
    showResult({ kind: "ok", title: "Već si prijavljen/a", big: data.time, text: shift ? `Dolazak za ${shift} je već zabeležen.` : "Dolazak je već zabeležen." });
  } else if (data.late_minutes > 0) {
    showResult({ kind: "late", title: `Zdravo, ${firstName}`, big: data.time, extra: `<span class="dz-late">Kašnjenje ${data.late_minutes} min</span>`, text: `Dolazak zabeležen — ${shift}.` });
  } else {
    showResult({ kind: "ok", title: `Zdravo, ${firstName}`, big: data.time, text: shift ? `Dolazak zabeležen — ${shift}. Srećan rad!` : "Dolazak zabeležen. Danas nemaš smenu u rasporedu." });
  }
}

async function startCamera() {
  tip.textContent = "Uperi kameru u QR kod na tabletu";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch (e) {
    showResult({
      kind: "err",
      title: "Kamera nije dostupna",
      text: "Dozvoli aplikaciji pristup kameri (podešavanja pregledača → dozvole → kamera), pa pokušaj ponovo.",
      retry: true,
    });
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  scanning = true;
  requestAnimationFrame(scanFrame);
}

function stopCamera() {
  scanning = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}

let lastWrongAt = 0;
function scanFrame() {
  if (!scanning) return;
  if (!busy && video.readyState >= 2 && video.videoWidth) {
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    if (code && code.data) {
      const token = tokenFrom(code.data);
      if (token) { scanning = false; submitToken(token); return; }
      if (Date.now() - lastWrongAt > 2500) {
        lastWrongAt = Date.now();
        tip.textContent = "Ovo nije QR kod za prijavu dolaska";
      }
    }
  }
  requestAnimationFrame(scanFrame);
}

(async () => {
  const params = new URLSearchParams(location.search);
  const urlToken = params.get("t");
  const { session } = await getSessionAndProfile();
  if (!session) {
    // Posle prijave vraća se ovde; token iz linka bi do tada istekao, pa se skenira ponovo.
    location.href = APP_BASE + "login.html?next=dolazak.html";
    return;
  }
  if (urlToken) {
    history.replaceState(null, "", location.pathname);
    submitToken(urlToken);
  } else {
    startCamera();
  }
})();
