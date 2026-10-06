// Deljena pravila za nalog zaposlenog: username -> email, generisanje lozinke.
// Radnici se loguju korisničkim imenom; interno se to mapira na email jer
// Supabase Auth zahteva email+lozinku.

const USERNAME_EMAIL_DOMAIN = "raspored-app.com";

function usernameToEmail(username) {
  return `${username.trim().toLowerCase()}@${USERNAME_EMAIL_DOMAIN}`;
}

function generateTempPassword() {
  // Ista podrazumevana lozinka za sve novododate radnike — svako je posle
  // može promeniti po potrebi.
  return "123456";
}
