# Become Better by David

Jednoducha lokalni appka na planovani treninku ve fitku. Bezi bez databaze,
umi bezet v lokalnim rezimu, ale je pripravena i na Supabase login, cloud
databazi, nutrition tracking, public feed a leaderboard.
Progress fotky z diet/bulk sekce umi ukladat do Supabase Storage, aby byly
videt mezi mobilem a pocitacem.

## Spusteni

```powershell
npm start
```

Pak otevri:

```text
http://localhost:4173
```

Data se ukladaji do `localStorage` v prohlizeci. V appce je i export/import JSON.

Aktuální online adresa: https://dpokornydev.github.io/fit-plan-local/

Při přihlášení se celá historie tréninků, výživy, regenerace, progresu a knihovna
cviků synchronizují přes Supabase. Na všech zařízeních použij stejný účet.
Profil ukazuje skutečný stav zápisů a nabízí „Synchronizovat teď“, export a import
zálohy. Import sloučí celou historii; čekající zápisy zůstanou na zařízení i při
výpadku spojení. Starou uloženou kopii z původní adresy před přechodem zálohuj.

Regresní testy synchronizace: `npm test`.

## Supabase cloud

1. Vytvor Supabase projekt.
2. V SQL editoru spust `supabase-schema.sql`. Pokud uz schema mas, staci doplnit
   `supabase-progress-photos.sql` pro cloud fotky.
3. Do `supabase-config.js` dopln `SUPABASE_URL` a publishable key.
4. Spust appku znovu. Prihlaseni/registrace se objevi automaticky.

Publishable key je verejny browserovy klic. Bezpecnost drzi Row Level Security
policy v `supabase-schema.sql`. `sb_secret` klic do frontend appky nikdy nedavej.

## Online zdarma

Nejlevnejsi deploy je GitHub Pages + Supabase Free. Presny postup je v
`DEPLOY.md`.

## Mobil

Appka ma zaklad PWA (`manifest.webmanifest` a `sw.js`). Na iPhonu/Androidu ji
muzes otevrit v prohlizeci a pridat na plochu bez App Storu.
