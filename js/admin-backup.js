// Rezervne kopije (sql/migration_021_backup.sql + Edge funkcija "backup").
// Automatski svake nedelje; ovde admin vidi spisak, pravi kopiju odmah i preuzima je na računar.

function bkFmtName(name) {
  // raspored_2026-10-18_04-00_auto.json -> 18.10.2026. 04:00
  const m = name.match(/^raspored_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})_(\w+)\.json$/);
  if (!m) return { when: name, kind: "" };
  return { when: `${m[3]}.${m[2]}.${m[1]}. ${m[4]}:${m[5]}`, kind: m[6] === "auto" ? "Automatska" : "Ručna" };
}

async function bkCall(body) {
  const { data, error } = await sb.functions.invoke("backup", { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch (e) { /* nije JSON */ }
    throw new Error(msg);
  }
  return data;
}

async function bkLoad() {
  const list = document.getElementById("bk-list");
  try {
    const { backups } = await bkCall({ action: "list" });
    if (!backups.length) { list.innerHTML = '<div class="empty-note muted">Još nema kopija.</div>'; return; }
    list.innerHTML = `<table class="gen-table bk-table">
      <thead><tr><th>Datum</th><th>Vrsta</th><th>Veličina</th><th></th></tr></thead>
      <tbody>${backups.map(b => {
        const f = bkFmtName(b.name);
        return `<tr><td>${f.when}</td><td>${f.kind}</td><td>${(b.size / 1024).toFixed(0)} KB</td>
          <td><button type="button" class="btn btn-ghost bk-dl" data-name="${b.name}">Preuzmi</button></td></tr>`;
      }).join("")}</tbody></table>`;
  } catch (e) {
    list.innerHTML = `<div class="banner error">Kopije nisu dostupne: ${e.message}</div>`;
  }
}

document.addEventListener("click", async (e) => {
  const dl = e.target.closest && e.target.closest(".bk-dl");
  if (!dl) return;
  dl.disabled = true;
  try {
    const { url } = await bkCall({ action: "download", name: dl.dataset.name });
    window.location.href = url;
  } catch (err) {
    alert("Preuzimanje nije uspelo: " + err.message);
  }
  dl.disabled = false;
});

document.addEventListener("admin-ready", () => {
  const btn = document.getElementById("bk-create");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Pravim kopiju...";
    try {
      await bkCall({ action: "create" });
      await bkLoad();
    } catch (err) {
      alert("Kopija nije napravljena: " + err.message);
    }
    btn.disabled = false;
    btn.textContent = "Napravi kopiju sada";
  });
  bkLoad();
});
