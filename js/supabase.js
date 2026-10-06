// Jedan deljeni Supabase klijent za celu aplikaciju.
// Učitava se posle CDN <script> za @supabase/supabase-js na svakoj stranici.

// Osnovna adresa aplikacije: "/" lokalno, "/raspored/" na GitHub Pages.
// Izračunava se iz mesta ovog fajla (js/supabase.js), pa sve veze rade na oba mesta.
const APP_BASE = new URL("..", document.currentScript.src).pathname;

const SUPABASE_URL = "https://oijlvfwbupdmwdfdedue.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6ZXqsNSfhShjoovP0G8YHQ_glux2E6s";

// NAPOMENA: namerno se NE zove "supabase" — to ime već zauzima globalni
// objekat biblioteke koji kreira CDN <script> tag (window.supabase).
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Poseban, izolovan klijent — koristi se SAMO kada admin kreira novog
// korisnika (sbAdminTemp.auth.signUp), da to ne bi oborilo sesiju ulogovanog
// admina u glavnom "sb" klijentu iznad.
const sbAdminTemp = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storageKey: "raspored-temp-auth",
  },
});
