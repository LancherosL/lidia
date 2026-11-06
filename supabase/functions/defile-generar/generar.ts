// Generación de tarjetas de Défilé: prompt, esquema y revisión de fuentes.
// La usan la Edge Function defile-generar (index.ts) y, para probar, una función de prueba aparte.
import Anthropic from "npm:@anthropic-ai/sdk@0.136.0";

const MODELO = "claude-haiku-5-5";
const CUANTAS = 5;
const PIDE = 6; // pide una de más: las que no pasan la revisión de fuente se descartan
const BUSQUEDAS = 3;

// Mismas claves y nombres que CATS en defile/index.html (dan el color y la ilustración).
const CATS: Record<string, string> = {
  francais: "Français Vivant",
  cerveau: "Neurosciences",
  chats: "Faits sur les chats",
  quebec: "Culture d'ici",
  culture: "Culture générale",
  bio: "Bio & Chimie",
  math: "Maths & Physique",
  verbos: "Verbes en Action",
  quebecismos: "Québécismes",
  situacionales: "Sur le Vif",
};
const FORMATOS = [
  "expresion", "mini_historia", "dato_util", "error_tipico", "pregunta",
  "dictado_corto", "comparacion_es_qc", "vocabulario_contexto", "tramite_quebec",
  "frase_util", "situacion_real", "dato_contexto", "tutorial_corto", "problema_solucion", "antes_despues",
];
const TEMAS = [
  "lengua", "pronunciacion", "tecfee", "garderie_trabajo", "crianza_escuela", "saaq_salud", "casa_barrio",
  "comida", "salud_fisio", "clima", "cultura_quebecoise", "tramites", "actualidad", "colombia_mundo", "agua_ambiente",
];
const FUENTES = [
  "vitrinelinguistique.oqlf.gouv.qc.ca", "oqlf.gouv.qc.ca", "usito.usherbrooke.ca",
  "dictionnaire.lerobert.com", "larousse.fr", "ici.radio-canada.ca",
  "quebec.ca", "canada.ca", "saaq.gouv.qc.ca", "ramq.gouv.qc.ca",
  "naitreetgrandir.com", "lapresse.ca", "ledevoir.com", "oppq.qc.ca", "saint-eustache.ca",
];

// Las 5 creadoras internas de Défilé (no son cuentas reales). Cada una es un sub-prompt;
// el director reparte las tarjetas del lote entre ellas con los pesos que manda la app.
const PERFILES: Record<string, string> = {
  quotidien: "La Québécoise du quotidien: vida diaria en Quebec, saludos, trámites, SAAQ, Saint-Eustache, la casa y el barrio. Tono cercano de vecina. Formatos: expresion, mini_historia, tramite_quebec (también vocabulario_contexto o comparacion_es_qc).",
  profe: "La Profe C2: gramática, dictado, TECFÉE, errores típicos de hispanohablantes, código lingüístico y redacción. Tono de profesora exigente y amable. Formatos: dictado_corto, error_tipico, pregunta.",
  maman: "Maman et garderie: niños, colegio, crianza y mensajes reales para la garderie, todo en francés. Tono práctico de mamá que ya pasó por eso. Formatos: frase_util (una frase lista para usar), situacion_real (una escena y qué decir en ella), vocabulario_contexto.",
  curieuse: "La Curieuse du monde: noticias verificadas, Colombia, el agua, lo que pasa en el mundo, en francés y con contexto. Tono curioso, sin polémica ni alarmismo. Formatos: dato_contexto (el dato, por qué importa y qué significa), dato_util, pregunta. Solo hechos que la fuente encontrada respalde, con su fecha si es noticia.",
  corps: "Corps et maison: salud, fisio, estiramientos, comida y vida diaria en la casa. Tono tranquilo y concreto. Formatos: tutorial_corto, problema_solucion, antes_despues. Nunca da diagnósticos ni reemplaza a un profesional.",
};
const PESO_MIN = 0.05, PESO_MAX = 0.5, DESCUBRIR = 0.1, MAX_POR_PERFIL = 3;

// Prompt fijo (se cachea); lo que cambia en cada llamada va en el mensaje.
const PROMPT = `Escribes tarjetas para Défilé, un feed vertical tipo TikTok que reemplaza el scroll de redes.
La lectora es una hispanohablante colombiana que vive en Quebec, nivel intermedio, con meta C2 en un año y el examen TECFÉE aprobado con margen. Cada tarjeta enseña algo concreto y útil para esa meta; entretener no basta.

Reglas de contenido:
- Francés de Quebec primero (no de Francia). gancho_fr, viñetas y fr_chispa van en francés québécois correcto. La ayuda en español va aparte: gancho, viñetas_es y fr_trad.
- Gancho: si no engancha en los primeros 3 segundos, no importa el resto. Empieza por lo sorprendente, útil o contraintuitivo; nunca por una introducción. El gancho abre una pregunta o un vacío de curiosidad que las viñetas responden de verdad; sin premios, sorteos ni promesas que la tarjeta no cumple.
- Viñetas: máximo 3, cortas. Puedes usar <b>negrita</b> y empezar con un emoji.
- fr_chispa: una frase corta y natural que ella pueda repetir en voz alta.
- cierre: lúdico, nunca un examen. tipo "opinion" (2 opciones), "ab" (2 opciones que empiezan por "A " y "B ") o "siguiente" (opts vacío).
- clave: la expresión, palabra o idea central de la tarjeta, en francés, en minúsculas.
- c: el color visual de la tarjeta, la categoría que mejor le quede.

Perfiles (campo perfil): cada tarjeta la escribe una de estas 5 creadoras, con su tema, su tono y sus formatos. Escribe cada tarjeta con la voz del perfil que el plan del director le asigna.
${Object.entries(PERFILES).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Formatos (campo formato): expresion, mini_historia (una escena corta; puede terminar en «À suivre…» y la siguiente mini_historia del lote la continúa), dato_util, error_tipico (lo que dice un hispanohablante y lo correcto), pregunta, dictado_corto (fr_chispa es la frase para escuchar y escribir), comparacion_es_qc (español colombiano vs. francés de Quebec), vocabulario_contexto, tramite_quebec (cómo se dice y se hace un trámite real), frase_util, situacion_real, dato_contexto, tutorial_corto, problema_solucion, antes_despues.
Temas (campo tema): ${TEMAS.join(", ")}.

Rotación obligatoria dentro del lote: cada tarjeta con un formato distinto, un tema distinto y una idea distinta (nunca dos tarjetas sobre la misma palabra o sus derivados); nunca el formato de la última tarjeta vista. Mezcla fácil y difícil, corto y largo, serio y divertido. No repitas ninguna clave de la lista de recientes; si repasas algo, usa un ejemplo nuevo.
Usa las señales de la lectora: lo que no entendió (❓) no es un rechazo, pide lo mismo explicado más a fondo y más despacio, mismo tema con un ejemplo nuevo; haz más de lo que le gustó y de sus temas preferidos; haz menos de lo que salta rápido.
Su vida: si el mensaje trae temas de su semana (lo que contó, sus citas, lo que guardó en redes), úsalos tal cual para que la tarjeta le sirva esa semana; no inventes nada de su vida que no esté ahí. Los errores de su banco son para que la Profe construya una tarjeta con la forma correcta y un ejemplo nuevo; nunca muestres la forma errada como si fuera correcta.

Fuentes: antes de escribir, busca con la herramienta web_search en las fuentes permitidas (OQLF y su Banque de dépannage linguistique, Usito, Le Robert, Larousse, Radio-Canada, La Presse, Le Devoir, Naître et grandir, la Orden de fisioterapeutas OPPQ, la ciudad de Saint-Eustache, gobiernos de Quebec y de Canadá). Cada tarjeta lleva en source la URL exacta de un resultado de esa búsqueda que respalde lo que dice, y el nombre corto del sitio. Esa URL debe ser la página específica de esa expresión, palabra o trámite (una ficha, una definición, un artículo), no un índice, una lista general ni un documento largo; y cada tarjeta usa una URL distinta. Nada inventado: si no encuentras respaldo para un dato, no lo presentes como hecho y cambia la tarjeta por otra que sí puedas respaldar. Haz como máximo ${BUSQUEDAS} búsquedas: busca temas amplios que alcancen para varias tarjetas.`;

const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pildoras"],
  properties: {
    pildoras: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "perfil", "c", "formato", "tema", "clave", "dificultad", "largo", "tono",
          "gancho_fr", "gancho", "viñetas", "viñetas_es", "fr_chispa", "fr_trad", "cierre", "source",
        ],
        properties: {
          perfil: { type: "string", enum: Object.keys(PERFILES) },
          c: { type: "string", enum: Object.keys(CATS) },
          formato: { type: "string", enum: FORMATOS },
          tema: { type: "string", enum: TEMAS },
          clave: { type: "string" },
          dificultad: { type: "string", enum: ["facil", "media", "dificil"] },
          largo: { type: "string", enum: ["corto", "largo"] },
          tono: { type: "string", enum: ["serio", "divertido"] },
          gancho_fr: { type: "string" },
          gancho: { type: "string" },
          viñetas: { type: "array", items: { type: "string" } },
          viñetas_es: { type: "array", items: { type: "string" } },
          fr_chispa: { type: "string" },
          fr_trad: { type: "string" },
          cierre: {
            type: "object",
            additionalProperties: false,
            required: ["tipo", "txt", "opts"],
            properties: {
              tipo: { type: "string", enum: ["opinion", "ab", "siguiente"] },
              txt: { type: "string" },
              opts: { type: "array", items: { type: "string" } },
            },
          },
          source: {
            type: "object",
            additionalProperties: false,
            required: ["nombre", "url"],
            properties: { nombre: { type: "string" }, url: { type: "string" } },
          },
        },
      },
    },
  },
};

type Pildora = {
  perfil: string;
  c: string;
  formato: string;
  tema: string;
  clave: string;
  dificultad: string;
  largo: string;
  tono: string;
  gancho_fr: string;
  gancho: string;
  viñetas: string[];
  viñetas_es: string[];
  fr_chispa: string;
  fr_trad: string;
  cierre: { tipo: string; txt: string; opts: string[] };
  source: { nombre: string; url: string };
};

export type Senales = {
  fase?: number;
  cat_floja?: string;
  formatos?: string[];
  temas?: string[];
  claves?: string[];
  gustos?: string[];
  no_entendi?: string[];
  saltadas?: string[];
  pesos?: Record<string, number>;
  temas_gusta?: string[];
  temas_evita?: string[];
  vida?: string[];
  errores?: string[];
  repasar?: string[];
};

type Turno = { perfil: string; descubrir: boolean };

// Mismos límites que en la app (no se confía en lo que llega): ningún perfil pasa de 50 % ni baja de 5 %.
export function limitar(entrada: Record<string, number> | undefined): Record<string, number> {
  const k = Object.keys(PERFILES);
  const w: Record<string, number> = {};
  for (const p of k) {
    const v = Number(entrada?.[p]);
    w[p] = Number.isFinite(v) && v > 0 ? v : 1 / k.length;
  }
  // El factor que, recortando cada peso a los límites, hace que todo sume 100 %.
  const recorta = (x: string, f: number) => Math.min(PESO_MAX, Math.max(PESO_MIN, w[x] * f));
  const suma = (f: number) => k.reduce((a, x) => a + recorta(x, f), 0);
  let lo = 0, hi = 1;
  while (suma(hi) < 1 && hi < 1e12) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (suma(m) < 1) lo = m;
    else hi = m;
  }
  return Object.fromEntries(k.map((x) => [x, recorta(x, hi)]));
}

// El director: reparte las tarjetas del lote entre los perfiles según los pesos (al azar, con tope de 3
// por perfil), y 1 de cada 10 queda para descubrir un tema nuevo con un perfil cualquiera.
export function director(pesos: Record<string, number>, n: number, azar = Math.random): Turno[] {
  const cuenta: Record<string, number> = {};
  const turnos: Turno[] = [];
  const k = Object.keys(PERFILES);
  for (let i = 0; i < n; i++) {
    const libres = k.filter((p) => (cuenta[p] ?? 0) < MAX_POR_PERFIL);
    let perfil: string;
    const descubrir = azar() < DESCUBRIR;
    if (descubrir) {
      perfil = libres[Math.floor(azar() * libres.length)];
    } else {
      const suma = libres.reduce((a, p) => a + pesos[p], 0);
      let r = azar() * suma;
      perfil = libres.find((p) => (r -= pesos[p]) < 0) ?? libres[libres.length - 1];
    }
    cuenta[perfil] = (cuenta[perfil] ?? 0) + 1;
    turnos.push({ perfil, descubrir });
  }
  return turnos;
}

// Lista corta de textos, recortados, para el mensaje.
function lista(x: unknown, max: number, largo = 120): string[] {
  return (Array.isArray(x) ? x : []).slice(-max).map((s) => String(s).slice(0, largo));
}

// Misma URL aunque cambie la codificación o la barra final.
function normal(url: string): string {
  try {
    return decodeURI(url).replace(/\/$/, "").toLowerCase();
  } catch {
    return url.replace(/\/$/, "").toLowerCase();
  }
}

export async function generar(s: Senales, anthropic: Anthropic) {
  const fase = Math.min(3, Math.max(1, Math.round(Number(s.fase) || 1)));
  const formatos = lista(s.formatos, 8, 30);
  const claves = lista(s.claves, 80, 60);
  const recientes = new Set(claves.map((c) => c.trim().toLowerCase()));
  const pesos = limitar(s.pesos);
  const plan = director(pesos, PIDE);
  const pct = (x: number) => `${Math.round(x * 100)} %`;

  const pedido = [
    `Escribe ${PIDE} tarjetas. Fase ${fase}/3 (1 = más fácil, 3 = más difícil).`,
    s.cat_floja && s.cat_floja in CATS ? `Categoría con menos tarjetas vistas: ${s.cat_floja}.` : "",
    `Formatos vistos hace poco (el último al final): ${JSON.stringify(formatos)}`,
    `Temas vistos hace poco: ${JSON.stringify(lista(s.temas, 8, 30))}`,
    `Claves vistas en los últimos 14 días (no repetir): ${JSON.stringify(claves)}`,
    `Le gustó: ${JSON.stringify(lista(s.gustos, 10))}`,
    `No entendió: ${JSON.stringify(lista(s.no_entendi, 10))}`,
    `Saltó rápido: ${JSON.stringify(lista(s.saltadas, 10))}`,
    `Pesos de sus últimos 7 días: ${Object.entries(pesos).map(([p, w]) => `${p} ${pct(w)}`).join(", ")}`,
    `Temas que más le gustan: ${JSON.stringify(lista(s.temas_gusta, 4, 30))}`,
    `Temas que salta: ${JSON.stringify(lista(s.temas_evita, 4, 30))}`,
    `Su semana (lo que ella contó o guardó): ${JSON.stringify(lista(s.vida, 10, 140))}`,
    `Errores pendientes de su banco (escrito → correcto): ${JSON.stringify(lista(s.errores, 6, 140))}`,
    `Repasar con un ejemplo nuevo: ${JSON.stringify(lista(s.repasar, 5))}`,
    `Plan del director, una tarjeta por línea y en este orden:\n${plan.map((t, i) =>
      `${i + 1}. ${t.perfil}${t.descubrir ? " (descubrir: un tema o ángulo que ella todavía no ha visto, fuera de sus temas de siempre)" : ""}`).join("\n")}`,
  ].filter(Boolean).join("\n");

  const mensajes: Anthropic.MessageParam[] = [{ role: "user", content: pedido }];
  let respuesta: Anthropic.Message | undefined;
  try {
    // pause_turn: la búsqueda se puede pausar; se reenvía tal cual para que siga.
    for (let vuelta = 0; vuelta < 3; vuelta++) {
      respuesta = await anthropic.messages.create({
        model: MODELO,
        max_tokens: 20000,
        system: [{ type: "text", text: PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: BUSQUEDAS, allowed_domains: FUENTES }],
        messages: mensajes,
        output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
      } as Anthropic.MessageCreateParamsNonStreaming);
      if (respuesta.stop_reason !== "pause_turn") break;
      mensajes.push({ role: "assistant", content: respuesta.content });
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { error: "Clave de Anthropic inválida" };
    if (e instanceof Anthropic.RateLimitError) return { error: "Demasiadas solicitudes, intenta en un momento" };
    if (e instanceof Anthropic.APIError) return { error: `Error de Claude ${e.status}: ${e.message}` };
    throw e;
  }
  if (!respuesta) return { error: "Sin respuesta" };
  if (respuesta.stop_reason === "refusal") return { error: "Claude no quiso escribir estas tarjetas" };
  if (respuesta.stop_reason === "max_tokens") return { error: `La respuesta quedó cortada (${respuesta.usage.output_tokens} tokens)` };

  // URLs que de verdad salieron en la búsqueda: una fuente fuera de esta lista no se acepta.
  const encontradas = new Set<string>();
  const bloques = [
    ...mensajes.filter((m) => m.role === "assistant").flatMap((m) => m.content as Anthropic.ContentBlock[]),
    ...respuesta.content,
  ];
  for (const b of bloques) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) encontradas.add(normal(r.url));
    }
  }

  const texto = respuesta.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let datos: { pildoras: Pildora[] };
  try {
    datos = JSON.parse(texto);
  } catch {
    return { error: "Respuesta mal formada" };
  }

  // Una URL respalda una sola tarjeta, y los índices o PDFs generales no cuentan como fuente.
  const usadas = new Set<string>();
  const fuenteValida = (url: string) => {
    const u = normal(url);
    if (!encontradas.has(u) || usadas.has(u) || /\/index\/|\.pdf$/.test(u)) return false;
    usadas.add(u);
    return true;
  };
  const pildoras = datos.pildoras
    .filter((p) => p.gancho_fr && p.viñetas?.length && fuenteValida(p.source?.url ?? ""))
    .filter((p) => !recientes.has(p.clave.trim().toLowerCase()))
    .slice(0, CUANTAS)
    .map((p) => ({
      ...p,
      perfil: p.perfil in PERFILES ? p.perfil : "quotidien",
      v: 2,
      clave: p.clave.trim().toLowerCase(),
      viñetas: p.viñetas.slice(0, 3),
      viñetas_es: p.viñetas_es.slice(0, 3),
      cierre: p.cierre.tipo === "siguiente" ? { tipo: "siguiente", txt: p.cierre.txt } : { ...p.cierre, opts: p.cierre.opts.slice(0, 2) },
      niv: fase,
    }));
  return {
    pildoras,
    plan: plan.map((t) => t.perfil + (t.descubrir ? "*" : "")),
    descartadas: datos.pildoras.length - pildoras.length,
    busquedas: respuesta.usage.server_tool_use?.web_search_requests ?? 0,
    tokens: respuesta.usage.input_tokens + respuesta.usage.output_tokens,
  };
}
