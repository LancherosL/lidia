// Reglas puras de la función "lidia": actividad, revisión de respuestas, validación de resultados y repaso.
// Sin red ni base de datos, para poder probarlas solas (pruebas/reglas.prueba.js, con jsc).
// JavaScript con JSDoc (no TypeScript) para que corra igual en Deno y en las pruebas.

export const INTERVALOS = [1, 3, 7, 21, 60];
export const ACIERTOS_PARA_DOMINAR = 3;
export const UMBRAL_REPETIR = 80; // % de palabras reconocidas en «repeter» para contar como logrado
export const ESTADOS = ["correct", "minor_error", "incorrect", "ambiguous"];
export const FUENTES = ["local_checker", "speech_checker", "model_proposal"];

// ── Actividad ──
// Qué se hace ahora, construido por el backend a partir del bloque; el cliente solo puede pedir un modo permitido.
const ACTIVIDADES = {
  conversacion: {
    defecto: "libre",
    modos: {
      libre: {
        area: "conversation", correction: "selective",
        objectif: "Parler de sa vie avec aisance : sens, suivi, fluidité.",
        evidence: "Laura se fait comprendre et enchaîne ; erreurs récurrentes notées pour la fin du tronçon.",
      },
      guidee: {
        area: "conversation", correction: "post_tache",
        objectif: "Prise de parole guidée : une consigne, un temps pour préparer, Laura parle sans interruption.",
        evidence: "Une prise de parole complète, puis une deuxième prise qui corrige au plus trois priorités.",
      },
    },
  },
  oral: {
    defecto: "exercice",
    modos: {
      exercice: {
        area: "comprehension", correction: "immediate",
        objectif: "Comprendre son matériel et le reproduire (dictée, répétition).",
        evidence: "Ce que Laura a compris du passage ; phrases répétées et dictées réussies.",
      },
      guidee: {
        area: "comprehension", correction: "selective",
        objectif: "Vérifier ce que Laura a compris de son film ou de sa série.",
        evidence: "Laura résume ou répond à des questions de compréhension ; l'orthographe ne compte pas ici.",
      },
    },
  },
  gramatica: {
    defecto: "exercice",
    modos: {
      exercice: {
        area: "grammaire", correction: "immediate",
        objectif: "Une seule forme du jour : la comprendre, puis l'appliquer.",
        evidence: "Réponses écrites correctes sur la forme du jour, puis une deuxième application dans une phrase à elle.",
      },
      revision: {
        area: "grammaire", correction: "immediate",
        objectif: "Révision du jour : sortir de mémoire les éléments dus de la banque.",
        evidence: "Rappel sans aide des éléments dus.",
      },
    },
  },
  escritura: {
    defecto: "guidee",
    modos: {
      guidee: {
        area: "ecriture", correction: "post_tache",
        objectif: "Un vrai texte : planifier, rédiger, réviser par couches, réécrire.",
        evidence: "Un premier jet complet, puis une deuxième version qui corrige les erreurs signalées.",
      },
      simulation: {
        area: "tecfee", correction: "post_tache",
        objectif: "Simulation TECFÉE : rédaction dans le temps et le format de l'examen.",
        evidence: "Un texte argumentatif dans les conditions de l'examen ; retour par critères après.",
      },
    },
  },
};

/**
 * Construye la actividad actual. `pedido` es el modo que pide el cliente; si no está permitido en este bloque,
 * se usa el modo por defecto. Un pedido de ejercicios fuerza el modo de ejercicio cuando el bloque lo tiene.
 * @param {string} fase
 * @param {string | null | undefined} pedido
 * @param {string} mensaje
 */
export function construirActividad(fase, pedido, mensaje = "") {
  const bloque = ACTIVIDADES[fase] ?? ACTIVIDADES.conversacion;
  let modo = typeof pedido === "string" && bloque.modos[pedido] ? pedido : bloque.defecto;
  if (/^\((Exercices?|Résultats des exercices) : /.test(mensaje) && bloque.modos.exercice && modo !== "guidee") modo = "exercice";
  if (/^\(Exercice : prise de parole/.test(mensaje) && bloque.modos.guidee) modo = "guidee";
  const m = bloque.modos[modo];
  return { area: m.area, mode: modo, objectif: m.objectif, evidence: m.evidence, correction: m.correction };
}

/** El texto corto que va justo antes del mensaje de Laura (recencia). */
export function textoActividad(a) {
  return `ACTIVIDAD ACTUAL\nÁrea: ${a.area}\nModo: ${a.mode}\nObjetivo: ${a.objectif}\nEvidencia buscada: ${a.evidence}\nCorrección: ${a.correction}`;
}

/** dictated | typed | edited_after_dictation (acepta los valores viejos dictado/escrito). */
export function normalizarEntrada(v) {
  if (v === "dictated" || v === "dictado") return "dictated";
  if (v === "edited_after_dictation") return "edited_after_dictation";
  return "typed";
}

// ── Revisión de respuestas (misma lógica que index.html; las pruebas comprueban que coinciden) ──
export function normalizar(t) {
  return String(t || "").normalize("NFC").toLowerCase().replace(/[’`ʼ]/g, "'").replace(/'\s+/g, "'")
    .replace(/[.,!?;:«»"“”()…\-–—]/g, " ").replace(/\s+/g, " ").trim();
}
export function sinTildes(t) { return t.normalize("NFD").replace(/[̀-ͯ]/g, ""); }
/** "si" | "tildes" | "no" */
export function revisar(ej, dada) {
  const buenas = String(ej.respuesta || "").split("|").map((r) => r.trim()).filter(Boolean);
  if (ej.tipo === "trou" && /_{2,}/.test(ej.texto || "")) buenas.push(...buenas.map((r) => ej.texto.replace(/_{2,}/, r)));
  const d = normalizar(dada);
  if (!d) return "no";
  if (buenas.some((r) => normalizar(r) === d)) return "si";
  if (buenas.some((r) => sinTildes(normalizar(r)) === sinTildes(d))) return "tildes";
  return "no";
}
/** % de palabras de `objetivo` reconocidas, en orden, en `dicho`. */
export function parecido(objetivo, dicho) {
  const a = normalizar(objetivo).split(" ").filter(Boolean), b = normalizar(dicho).split(" ").filter(Boolean);
  if (!a.length) return 0;
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
  return Math.round(t[a.length][b.length] / a.length * 100);
}

// ── Ejercicios emitidos ──
/** Ids nuevos para los ejercicios que acaba de mandar Lidia. */
export function ponerIds(ejercicios, nuevoId) {
  return (ejercicios || []).map((e) => ({ ...e, id: nuevoId() }));
}
/** Mapa id → ejercicio, a partir de los mensajes de Lidia de la sesión («[[exercices]] [json]»). */
export function ejerciciosEmitidos(contenidos) {
  const mapa = new Map();
  for (const c of contenidos || []) {
    const m = /\[\[exercices\]\]\s*(\[[\s\S]*\])\s*$/.exec(c || "");
    if (!m) continue;
    let lista = [];
    try { lista = JSON.parse(m[1]); } catch { continue; }
    for (const e of lista) if (e && typeof e.id === "string") mapa.set(e.id, e);
  }
  return mapa;
}

/**
 * Valida los resultados estructurados que manda la app. La fuente de verdad es el ejercicio emitido
 * (guardado en la sesión), no el texto «(Résultats…)» ni lo que diga el cliente:
 * - el ejercicio tiene que existir en esta sesión; el item_id sale del ejercicio, nunca del cliente;
 * - tiene que haber un intento (respuesta no vacía), salvo «ambiguous»;
 * - el estado se recalcula en el servidor con la misma revisión de la app.
 * Devuelve qué aplicar al banco y qué se rechazó (con el motivo).
 * @param {unknown} resultados
 * @param {Map<string, any>} emitidos
 */
export function validarResultados(resultados, emitidos) {
  const aceptados = [], rechazos = [];
  if (!Array.isArray(resultados)) return { aceptados, rechazos };
  const vistos = new Set();
  for (const r of resultados.slice(0, 20)) {
    const id = r && typeof r.exercise_id === "string" ? r.exercise_id : null;
    if (!id) { rechazos.push({ exercise_id: null, motivo: "sin exercise_id" }); continue; }
    if (vistos.has(id)) { rechazos.push({ exercise_id: id, motivo: "repetido" }); continue; }
    vistos.add(id);
    const ej = emitidos.get(id);
    if (!ej) { rechazos.push({ exercise_id: id, motivo: "ejercicio no emitido en esta sesión" }); continue; }
    const respuesta = typeof r.answer === "string" ? r.answer.slice(0, 600) : "";
    const pedido = ESTADOS.includes(r.status) ? r.status : null;
    const fuente = FUENTES.includes(r.source) ? r.source : null;
    if (!pedido || !fuente) { rechazos.push({ exercise_id: id, motivo: "estado o fuente no válidos" }); continue; }
    if (ej.tipo === "rediger") { rechazos.push({ exercise_id: id, motivo: "la redacción se corrige como texto" }); continue; }
    let estado;
    if (!respuesta.trim()) estado = "ambiguous"; // sin intento: no castiga ni premia
    else if (ej.tipo === "repeter") estado = parecido(ej.texto, respuesta) >= UMBRAL_REPETIR ? "correct" : "incorrect";
    else {
      const v = revisar(ej, respuesta);
      estado = v === "si" ? "correct" : v === "tildes" ? "minor_error" : "incorrect";
    }
    if (pedido === "ambiguous" && estado !== "correct") estado = "ambiguous"; // la app no estaba segura: no castigar
    if (pedido !== estado && !(pedido === "ambiguous")) rechazos.push({ exercise_id: id, motivo: `estado corregido: ${pedido} → ${estado}` });
    aceptados.push({ exercise_id: id, item_id: ej.item_id ?? null, tipo: ej.tipo, answer: respuesta, status: estado });
  }
  return { aceptados, rechazos };
}

/**
 * Valida los `resultados_items` que propone el modelo en una conversación: solo ítems de los que tocan hoy
 * (los calcula el servidor), solo si Laura hizo un intento real en este turno y solo si no se aplicaron ya.
 */
export function validarResultadosModelo(resultados, idsHoy, hayIntento, yaAplicados) {
  const aceptados = [], rechazos = [];
  for (const r of Array.isArray(resultados) ? resultados : []) {
    const id = r && typeof r.id === "string" ? r.id : null;
    if (!id || !idsHoy.has(id)) { rechazos.push({ item_id: id, motivo: "ítem desconocido o no previsto hoy" }); continue; }
    if (!hayIntento) { rechazos.push({ item_id: id, motivo: "sin intento de Laura en este turno" }); continue; }
    if (yaAplicados.has(id)) { rechazos.push({ item_id: id, motivo: "ya aplicado por un ejercicio" }); continue; }
    yaAplicados.add(id);
    aceptados.push({ item_id: id, status: r.acierto === true ? "correct" : "incorrect" });
  }
  return { aceptados, rechazos };
}

// ── Repaso espaciado ──
/**
 * Nuevo estado de un ítem del banco, o null si no hay que tocarlo.
 * correct → siguiente intervalo; incorrect → vuelve a 1 día; minor_error y ambiguous → sin cambios.
 * @param {{intervalo:number, aciertos_seguidos:number}} item
 * @param {"correct"|"minor_error"|"incorrect"|"ambiguous"|boolean} resultado
 * @param {(dias:number) => string} hoyMas
 */
export function repasar(item, resultado, hoyMas) {
  const estado = resultado === true ? "correct" : resultado === false ? "incorrect" : resultado;
  if (estado === "incorrect") return { intervalo: 1, aciertos_seguidos: 0, dominado: false, proxima: hoyMas(1) };
  if (estado !== "correct") return null;
  const i = INTERVALOS.indexOf(item.intervalo);
  const intervalo = INTERVALOS[Math.min(i + 1, INTERVALOS.length - 1)];
  const aciertos_seguidos = (item.aciertos_seguidos || 0) + 1;
  return { intervalo, aciertos_seguidos, dominado: aciertos_seguidos >= ACIERTOS_PARA_DOMINAR, proxima: hoyMas(intervalo) };
}

/** Mensajes de la app que no son un intento de Laura. */
export function esAvisoSistema(mensaje) {
  return /^\((Nouvelle phase|Fin de la session|Exercices?|Résultats des exercices) : /.test(mensaje || "");
}
