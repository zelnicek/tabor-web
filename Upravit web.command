#!/bin/bash
# Editor webu Tábora šlapanických divadelníků – spouští se dvojklikem.
cd "$(dirname "$0")" || exit 1
printf '\033]0;Editor webu\007'
clear 2>/dev/null
if ! command -v python3 >/dev/null 2>&1; then
	echo
	echo "  Chybí Python 3, bez něj editor neběží."
	echo "  Nainstaluješ ho z https://www.python.org/downloads/"
	echo
	read -r -p "  Stiskni Enter pro zavření…"
	exit 1
fi
python3 "_editor/editor.py" "$@"
code=$?
echo
if [ "$code" -ne 0 ]; then
	echo "  Něco se nepovedlo (kód $code) – pošli prosím snímek tohohle okna."
fi
echo "  Toto okno můžeš zavřít."
