// Pruebas de las funciones puras de index.html (revisión de respuestas) y de que coinciden con reglas.js.
// correr.sh copia este archivo junto a cliente-puras.js (sacado de index.html) y lo corre con jsc -m.
import * as reglas from "./supabase/functions/lidia/reglas.js";

globalThis.escapar = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
load("./cliente-puras.js");

let fallos = 0, total = 0;
function igual(nombre, real, esperado) {
  total++;
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a !== b) { fallos++; print(`✗ ${nombre}\n   obtenido: ${a}\n   esperado: ${b}`); }
}

// revisar: tildes, apóstrofos, mayúsculas, alternativas, frase completa en «trou»
const casos = [
  [{ tipo: "trou", texto: "Hier, je ___ sortie.", respuesta: "suis" }, "suis", "si"],
  [{ tipo: "trou", texto: "Hier, je ___ sortie.", respuesta: "suis" }, "Hier, je suis sortie.", "si"],
  [{ tipo: "trou", texto: "Nous ___ partis.", respuesta: "sommes|étions" }, "Étions", "si"],
  [{ tipo: "transformer", texto: "", respuesta: "Je suis allée à l'école." }, "je suis allee a l ecole", "no"],
  [{ tipo: "transformer", texto: "", respuesta: "Je suis allée à l'école." }, "je suis allee a l'ecole", "tildes"],
  [{ tipo: "transformer", texto: "", respuesta: "Je suis allée à l'école." }, "Je suis allée à l’ école!", "si"],
  [{ tipo: "choix", texto: "", respuesta: "nous avons" }, "Nous avons", "si"],
  [{ tipo: "dictee", texto: "Il fait froid.", respuesta: "Il fait froid." }, "il fait froit", "no"],
];
for (const [ej, dada, esperado] of casos) igual(`revisar «${dada}»`, revisar(ej, dada), esperado);

// La app y la función revisan igual (la función recalcula el resultado en el servidor).
for (const [ej, dada] of casos) igual(`misma revisión en app y función «${dada}»`, revisar(ej, dada), reglas.revisar(ej, dada));
igual("misma revisión con respuesta vacía", revisar({ tipo: "trou", texto: "", respuesta: "a" }, ""), "no");

// diferencias: palabras quitadas y añadidas
const d1 = diferencias("Je suis allée à la garderie", "Je suis allé a la garderie");
igual("diferencias: tu respuesta marca lo que sobra", d1.tuya, "je suis <s>allé</s> <s>a</s> la garderie");
igual("diferencias: la respuesta marca lo que falta", d1.buena, 'je suis <b class="falta">allée</b> <b class="falta">à</b> la garderie');
const d2 = diferencias("Il fait froid", "Il fait très froid");
igual("diferencias: palabra añadida", d2.tuya, "il fait <s>très</s> froid");
igual("diferencias: nada falta", d2.buena, "il fait froid");
const d3 = diferencias("Il fait très froid", "Il fait froid");
igual("diferencias: palabra quitada", d3.buena, 'il fait <b class="falta">très</b> froid');

// parecido: transcripciones imperfectas, y misma nota que la función
const p1 = parecido("Je suis allée à l'épicerie.", "euh je suis allée à l'épicerie");
igual("parecido con muletilla", p1.nota, 100);
const p2 = parecido("Je suis allée à l'épicerie", "je suis allé épicerie");
igual("parecido con palabras perdidas", [p2.nota, [...p2.faltan].sort()], [40, [2, 3, 4]]);
igual("misma nota en app y función", p2.nota, reglas.parecido("Je suis allée à l'épicerie", "je suis allé épicerie"));

// barajar: nunca devuelve la frase en el orden correcto si tiene más de dos palabras
let ordenada = false;
for (let k = 0; k < 200; k++) if (barajar(["Elle", "est", "venue", "hier"]).join(" ") === "Elle est venue hier") ordenada = true;
igual("barajar desordena", ordenada, false);

print(`cliente: ${total - fallos}/${total} pruebas bien`);
if (fallos) throw new Error(`${fallos} pruebas fallaron`);
