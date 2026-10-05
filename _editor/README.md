# Editor webu

Vizuální úpravy webu kliknutím (texty, fotky, odkazy, přidání/smazání řádků)
a zveřejnění jedním tlačítkem. Spouští se dvojklikem na **`Upravit web.command`**
v kořeni webu – otevře se prohlížeč na `http://127.0.0.1:8790/`.

Na zveřejněném webu editor není: workflow `.github/workflows/pages.yml`
složky `_editor`, `_sablony` a spouštěč před nasazením maže.

## Soubory

| soubor | co dělá |
|---|---|
| `editor.py` | lokální server (jen standardní knihovna Pythonu 3) |
| `static/editor.js` | editor v prohlížeči – lišta, panel, dialogy, ukládání |
| `static/editor.css` | zvýraznění upravitelných míst ve stránce |
| `../Upravit web.command` | spouštěč pro macOS (dvojklik) |

## Jak to funguje

1. Server stránku rozebere vlastním parserem, který si pamatuje **přesné pozice
   prvků ve zdrojovém souboru**, a k upravitelným místům připíše atributy:
   `data-ed` (text), `data-ed-box` (kontejner pro přidávání řádků),
   `data-ed-img` (fotka). Skripty webu v editoru vypne, aby stránka odpovídala
   zdrojáku a nic do ní „nedopisoval“ JavaScript.
2. Prohlížeč pošle jen změněná místa. Server je vloží **přesně na jejich pozici**
   – zbytek souboru zůstane bajt po bajtu stejný (malé, čitelné diffy).
3. „Zveřejnit“ = `git add` jen upravených stránek a fotek → `git commit` →
   `git pull --rebase --autostash` → `git push origin main`.

## Pojistky

- Server poslouchá jen na `127.0.0.1`, kontroluje hlavičku `Host` a každý
  zápis vyžaduje token, který dostane jen stránka vygenerovaná editorem.
- Ukládá se jen po ověření, že se soubor mezitím nezměnil (SHA-1).
- Vkládané HTML se kontroluje: žádné `<script>`, `on*` atributy,
  `javascript:` odkazy, neuzavřené značky; do textu žádné blokové prvky.
- Úprava, po které by stránka měla víc strukturálních chyb než předtím,
  se neuloží.
- Text, který se po načtení v prohlížeči liší od zdrojáku, se zamkne.
- Zamčené je i menu a patička (jsou stejné na všech stránkách, upravit je
  je potřeba všude najednou) a prvky, do kterých zapisuje skript (odpočet).

## Testování bez rizika

Nikdy netestovat na ostrém repozitáři. Vytvořit kopii s falešným „GitHubem“:

```bash
git clone --bare . /tmp/test-remote.git && git clone /tmp/test-remote.git /tmp/test-site
cp -R _editor "Upravit web.command" /tmp/test-site/
python3 /tmp/test-site/_editor/editor.py --no-pull --port 8795
```

Volby: `--root` (složka webu), `--port`, `--no-browser`, `--no-pull`.
