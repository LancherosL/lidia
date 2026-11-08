// Pruebas de supabase/functions/lidia/reglas.js. Se corren con pruebas/correr.sh (JavaScriptCore de macOS).
import {
  construirActividad, normalizarEntrada, revisar, parecido, ponerIds, ejerciciosEmitidos,
  validarResultados, validarResultadosModelo, repasar, esAvisoSistema,
} from "../supabase/functions/lidia/reglas.js";

let fallos = 0, total = 0;
function igual(nombre, real, esperado) {
  total++;
  const a = JSON.stringify(real), b = JSON.stringify(esperado);
  if (a !== b) { fallos++; print(`✗ ${nombre}\n   obtenido: ${a}\n   esperado: ${b}`); }
}
const hoyMas = (d) => `+${d}`;

// Actividad: el backend decide; el cliente solo puede pedir un modo permitido.
igual("conversación por defecto = libre", construirActividad("conversacion", null).mode, "libre");
igual("conversación guidée permitida", construirActividad("conversacion", "guidee").correction, "post_tache");
igual("modo inventado se ignora", construirActividad("gramatica", "hackeo").mode, "exercice");
igual("modo de otro bloque se ignora", construirActividad("conversacion", "simulation").mode, "libre");
igual("fase desconocida = conversación", construirActividad("xxx", "libre").area, "conversation");
igual("pedido de ejercicios en oral", construirActividad("oral", "guidee", "(Exercices : shadowing)").mode, "guidee");
igual("pedido de ejercicios en gramática", construirActividad("gramatica", "revision", "(Exercices : grammaire)").mode, "exercice");
igual("prise de parole fuerza guidée", construirActividad("conversacion", "libre", "(Exercice : prise de parole guidée)").mode, "guidee");
igual("gramática corrige al momento", construirActividad("gramatica").correction, "immediate");
igual("comprensión es su propia área", construirActividad("oral").area, "comprehension");
igual("simulación TECFÉE solo en escritura", construirActividad("escritura", "simulation").area, "tecfee");

// Entrada
igual("entrada vieja dictado", normalizarEntrada("dictado"), "dictated");
igual("entrada editada", normalizarEntrada("edited_after_dictation"), "edited_after_dictation");
igual("entrada desconocida = typed", normalizarEntrada("loquesea"), "typed");

// Revisión: tildes, apóstrofos, mayúsculas, alternativas, frase completa
const trou = { tipo: "trou", texto: "Hier, je ___ sortie.", respuesta: "suis|suis allée" };
igual("hueco exacto", revisar(trou, "suis"), "si");
igual("hueco alternativa", revisar(trou, "Suis allée"), "si");
igual("hueco frase completa", revisar(trou, "Hier, je suis sortie"), "si");
igual("hueco mal", revisar(trou, "ai"), "no");
igual("vacío nunca es correcto", revisar(trou, "   "), "no");
const tr = { tipo: "transformer", texto: "", respuesta: "Je suis allée à l'école." };
igual("solo tildes", revisar(tr, "je suis allee a l'ecole"), "tildes");
igual("apóstrofo tipográfico y espacio", revisar(tr, "JE SUIS ALLÉE À L’ ÉCOLE"), "si");
igual("concordancia mal", revisar(tr, "Je suis allé à l'école"), "no");

// Parecido (repeter) con transcripciones imperfectas
igual("parecido exacto", parecido("Je suis allée à l'épicerie.", "je suis allée à l'épicerie"), 100);
igual("parecido con una palabra mal", parecido("Je suis allée à l'épicerie", "je suis allé à l'épicerie"), 80);
igual("parecido con palabras de más", parecido("Il fait froid", "euh il fait vraiment froid"), 100);
igual("parecido vacío", parecido("Il fait froid", ""), 0);

// Ejercicios emitidos e ids
let n = 0;
const conIds = ponerIds([{ tipo: "choix", texto: "x", respuesta: "a", item_id: "item-1" }, { tipo: "repeter", texto: "Il fait froid", respuesta: "Il fait froid", item_id: null }], () => `ej-${++n}`);
igual("ids puestos", conIds.map((e) => e.id), ["ej-1", "ej-2"]);
const mensajes = ["[[defi]] Go\n\n[[exercices]] " + JSON.stringify(conIds), "[[pregunta]] sin ejercicios", "[[exercices]] {roto"];
const emitidos = ejerciciosEmitidos(mensajes);
igual("emitidos encontrados", [...emitidos.keys()], ["ej-1", "ej-2"]);

// Validación de resultados estructurados
const v = validarResultados([
  { exercise_id: "ej-1", answer: "a", status: "correct", source: "local_checker" },
  { exercise_id: "ej-2", answer: "il fait froid", status: "correct", source: "speech_checker" },
  { exercise_id: "ej-999", answer: "a", status: "correct", source: "local_checker" },
  { exercise_id: "ej-1", answer: "a", status: "correct", source: "local_checker" },
  { answer: "a", status: "correct", source: "local_checker" },
], emitidos);
igual("aceptados", v.aceptados.map((a) => [a.exercise_id, a.status, a.item_id]), [["ej-1", "correct", "item-1"], ["ej-2", "correct", null]]);
igual("rechazos", v.rechazos.map((r) => r.motivo), ["ejercicio no emitido en esta sesión", "repetido", "sin exercise_id"]);
const trampa = validarResultados([{ exercise_id: "ej-1", answer: "b", status: "correct", source: "local_checker" }], emitidos);
igual("el servidor recalcula: no se puede declarar correcta una mala", trampa.aceptados[0].status, "incorrect");
const sinIntento = validarResultados([{ exercise_id: "ej-1", answer: "", status: "incorrect", source: "local_checker" }], emitidos);
igual("sin intento = ambiguous", sinIntento.aceptados[0].status, "ambiguous");
const dudosa = validarResultados([{ exercise_id: "ej-2", answer: "il fait", status: "ambiguous", source: "speech_checker" }], emitidos);
igual("ambiguous de la app no castiga", dudosa.aceptados[0].status, "ambiguous");
const malFuente = validarResultados([{ exercise_id: "ej-1", answer: "a", status: "perfecto", source: "yo" }], emitidos);
igual("estado inventado rechazado", malFuente.rechazos[0].motivo, "estado o fuente no válidos");
igual("item_id del cliente se ignora", validarResultados([{ exercise_id: "ej-2", item_id: "item-ajeno", answer: "il fait froid", status: "correct", source: "speech_checker" }], emitidos).aceptados[0].item_id, null);

// Resultados que propone el modelo
const ya = new Set(["item-1"]);
const m = validarResultadosModelo([{ id: "item-1", acierto: true }, { id: "item-2", acierto: false }, { id: "item-x", acierto: true }], new Set(["item-1", "item-2"]), true, ya);
igual("modelo: solo ítems de hoy y no repetidos", m.aceptados, [{ item_id: "item-2", status: "incorrect" }]);
igual("modelo: sin intento no aplica", validarResultadosModelo([{ id: "item-2", acierto: true }], new Set(["item-2"]), false, new Set()).aceptados, []);

// Repaso 1/3/7/21/60
igual("acierto avanza", repasar({ intervalo: 3, aciertos_seguidos: 1 }, "correct", hoyMas), { intervalo: 7, aciertos_seguidos: 2, dominado: false, proxima: "+7" });
igual("tercer acierto domina", repasar({ intervalo: 7, aciertos_seguidos: 2 }, true, hoyMas).dominado, true);
igual("tope en 60", repasar({ intervalo: 60, aciertos_seguidos: 0 }, "correct", hoyMas).intervalo, 60);
igual("fallo vuelve a 1", repasar({ intervalo: 21, aciertos_seguidos: 2 }, "incorrect", hoyMas), { intervalo: 1, aciertos_seguidos: 0, dominado: false, proxima: "+1" });
igual("ambiguous no toca el banco", repasar({ intervalo: 21, aciertos_seguidos: 2 }, "ambiguous", hoyMas), null);
igual("solo tildes no toca el banco", repasar({ intervalo: 21, aciertos_seguidos: 2 }, "minor_error", hoyMas), null);

// Avisos del sistema no son intentos
igual("aviso de resultados", esAvisoSistema("(Résultats des exercices : 2/3)\n1. ✓"), true);
igual("frase de Laura", esAvisoSistema("Je suis allée au parc"), false);

print(`reglas: ${total - fallos}/${total} pruebas bien`);
if (fallos) throw new Error(`${fallos} pruebas fallaron`);
