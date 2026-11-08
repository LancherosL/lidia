#!/bin/sh
# Corre las pruebas de las funciones puras con JavaScriptCore (viene con macOS; no hace falta instalar nada).
#   sh pruebas/correr.sh
set -e
cd "$(dirname "$0")/.."
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
TMP=$(mktemp -d)
# Las puras del cliente se sacan de index.html (entre las dos marcas) y se exponen en globalThis.
sed -n '/── Puras: revisión de respuestas/,/── Fin de las puras ──/p' index.html > "$TMP/cliente-puras.js"
echo 'Object.assign(globalThis, { normalizar, sinTildes, revisar, esCorrecta, diferencias, parecido, barajar });' >> "$TMP/cliente-puras.js"
cp pruebas/cliente.prueba.js "$TMP/"
cp -R supabase "$TMP/supabase"
mkdir -p "$TMP/pruebas" && cp pruebas/reglas.prueba.js "$TMP/pruebas/"
"$JSC" -m "$TMP/pruebas/reglas.prueba.js"
(cd "$TMP" && "$JSC" -m cliente.prueba.js)
rm -rf "$TMP"
