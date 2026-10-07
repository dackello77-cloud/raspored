const form = document.getElementById("login-form");
const errorBox = document.getElementById("login-error");
const submitBtn = document.getElementById("login-submit");

// Kuda posle prijave: ?next=dolazak.html (samo stranice ove aplikacije), inače po ulozi.
function afterLoginUrl(role) {
  if (role === "terminal") return APP_BASE + "terminal.html";
  if (role === "management") return APP_BASE + "dolasci.html";
  const next = new URLSearchParams(location.search).get("next");
  if (next && /^[a-z]+\.html(\?[\w=.%-]*)?$/.test(next)) return APP_BASE + next;
  return role === "admin" ? APP_BASE + "admin/index.html" : APP_BASE + "index.html";
}

// Kačimo submit handler ODMAH (sinhrono), pre bilo kakvog await-a,
// da ne postoji trenutak kada bi klik/Enter pokrenuo "sirov" GET submit
// forme (što bi lozinku ubacilo u URL).
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.classList.add("hidden");
  submitBtn.disabled = true;
  submitBtn.textContent = "Prijavljivanje...";

  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;

  const { data, error } = await sb.auth.signInWithPassword({
    email: usernameToEmail(username),
    password,
  });

  if (error) {
    errorBox.textContent = "Pogrešno korisničko ime ili lozinka.";
    errorBox.classList.remove("hidden");
    submitBtn.disabled = false;
    submitBtn.textContent = "Prijavi se";
    return;
  }

  const { data: profileRow } = await sb
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .single();

  window.location.href = afterLoginUrl(profileRow && profileRow.role);
});

(async () => {
  const { session, profile } = await mountHeader("login");
  if (session && profile) {
    window.location.href = afterLoginUrl(profile.role);
  }
})();
