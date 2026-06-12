# Lokalni Raspored server

Zahteva Node.js 24 ili noviji. Ne koristi dodatne npm pakete.

Pokretanje:

```bash
cd server
npm start
```

Zatim otvorite:

```text
http://127.0.0.1:8787
```

Na macOS-u aplikacija može da se pokrene i dvoklikom na:

```text
Pokreni Raspored.command
```

SQLite baza se podrazumevano čuva izvan iCloud foldera:

```text
~/Library/Application Support/Raspored App/raspored.db
```

Druga lokacija može da se zada promenljivom `RASPORED_DATA_DIR`.

Postojeći `appscript.gs` ostaje izvor poslovne logike. Lokalni runtime
Google Spreadsheet, Cache i Properties servise zamenjuje SQLite tabelama.

## Prenos postojećih Google podataka

1. Ažurirajte i ponovo objavite `appscript.gs`, jer sadrži nove akcije
   `exportData` i `importData`.
2. Pokrenite lokalni server.
3. U drugom Terminal prozoru pokrenite:

```bash
cd server
node import-google.js "GOOGLE_APPS_SCRIPT_EXEC_URL" admin
```

Prenose se korisnici, sva istorija rasporeda, podešavanja i mesečni kriterijumi.
