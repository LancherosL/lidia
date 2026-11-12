// Edge Function "lidia": recibe un turno de la sesión, llama a Claude y guarda todo en el banco.
// La clave de Anthropic vive solo aquí, como secreto ANTHROPIC_API_KEY.
import Anthropic from "npm:@anthropic-ai/sdk@0.136.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { PROMPT_LIDIA } from "./prompt.ts";
import {
  construirActividad, textoActividad, normalizarEntrada, ponerIds, ejerciciosEmitidos,
  validarResultados, validarResultadosModelo, repasar, esAvisoSistema, tramoActual,
} from "./reglas.js";

const MODELO_CHARLA = "claude-haiku-5-5";
const MODELO_CORRECCION = "claude-sonnet-5-5"; // fotos y simulacros
const TURNOS_HISTORIAL = 16; // 8 turnos de Laura y 8 de Lidia
const MAX_RECUERDOS = 80; // cuaderno largo (perfil.memoria): los más nuevos quedan
const SESIONES_ANTERIORES = 3; // resúmenes de las últimas sesiones que ve Lidia
const ZONA = "America/Toronto";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TIPOS_BLOQUE = ["pregunta", "exemple", "correction", "defi", "bravo", "plus"];
// Ejercicios que la app muestra como actividad (ver lidia-prompt.md, «Ejercicios por bloque»).
const TIPOS_EJERCICIO = ["choix", "trou", "transformer", "ordre", "repeter", "dictee", "rediger"];

// Lo que se hace en cada bloque. Va en cada turno, al final del contexto, para que Lidia no convierta
// todo en conversación (ver lidia-prompt.md, «Cada bloque tiene su propio formato»).
// Las 4 hebras de Nation van DENTRO de los bloques (9-nov-2026, opción C): cada bloque tiene tramos por minuto.
const MODO_BLOQUE: Record<string, string> = {
  conversacion:
    "CONVERSATION (30 min) = OUTPUT ORAL (min 0-20) + FLUIDEZ ORAL (min 20-30). Min 0-20: tema del día sobre su vida, una pregunta a la vez; producción empujada (preguntas que la obligan a decir más y mejor); corriges enseñando al final de su turno (qué dijo, forma correcta, por qué, comparación con el español) y le pides volver a decir la versión correcta. Min 20-30: fluidez con 4/3/2 sobre un tema FAMILIAR de esta semana (búscalo en `cuaderno_laura` o en los resúmenes): cuenta lo mismo en 4 minutos, luego en 3, luego en 2, con otra pregunta o interlocutor cada vez; o recontar sin notas lo ya trabajado. En ese tramo NADA de palabras nuevas ni correcciones durante: al final, una sola observación sobre fluidez (más rápido, menos pausas, mismas ideas).",
  oral:
    "ORAL (30 min) = INPUT (min 0-15) + FLUIDEZ: SHADOWING (min 15-30). NO es conversación. La APP le muestra a Laura una tarjeta «Texte du jour» con `texto_del_dia` y 4 pasos que ella sigue sola: 1) escucha sin leer (la app lee el texto), 2) escucha leyendo, 3) las 3 preguntas de comprensión (la app las muestra una por una), 4) shadowing. TÚ NO lees el texto, NO lo pegas y NO haces las preguntas: eso lo hace la tarjeta. Nunca pidas otro material ni digas que no hay. Tu papel: (a) con «(Nouvelle phase : …)»: 1-2 frases que presentan el tema del día y le dicen que toque «▶ Écouter le texte» en la tarjeta; `voz` igual de corta; sin pregunta. (b) Con un mensaje «(Compréhension k/3 : pregunta)» seguido de su respuesta: evalúas SOLO la comprensión: si entendió, qué le faltó, y la frase exacta del texto que da la respuesta; como máximo una microcorrección de lengua si el error es grave; la ortografía no cuenta. Sin pregunta tuya (la tarjeta muestra la siguiente), salvo en k=3: ahí, si respondió sin esfuerzo, UNA pregunta de inferencia u opinión para ir más lejos. (c) Con «(Exercices : …)»: shadowing con `ejercicios` `repeter` y 1-2 `dictee` del texto, y guarda las expresiones del día en `nuevos_items` (tipo `expresion`; `correcto` = la parte en francés, `nota` = la traducción). NIVEL i+1 SIEMPRE (Laura vive en Quebec y entiende de sobra el francés de su vida diaria): si el texto es fácil para ella (días `base`, o frases de 3-4 palabras), el shadowing usa frases LARGAS (10-18 palabras: une dos frases del texto o amplíalas con un conector culto), el dictado una frase de 15 palabras o más, y añade 3-5 expresiones más ricas sobre el tema (sinónimos cultos, québécismes con su registro, conectores). Las `frases_shadowing` del archivo son el mínimo, nunca el techo. Nunca inventes cifras, títulos ni datos que no estén en el texto; si citas la fuente, usa `fuente_url`. Si `texto_del_dia.vuelta` es 2 o más: más exigencia (frases más largas, y en k=3 un mini debate con 2 argumentos).",
  gramatica:
    "GRAMMAIRE (30 min) = LENGUA DELIBERADA. PROHIBIDO pedirle que hable, que diga algo en voz alta o que repita oralmente: aquí todo es lectura, explicación y ejercicios escritos. Solo lo que pesa en el TECFÉE: acuerdos (participio pasado, adjetivos, tout/tous), homófonos (a/à, ce/se, ces/ses, leur/leurs), conjugación y concordancia de tiempos, subjonctif, relativos dont/que/où, conectores, puntuación, anglicismos e impropiedades. Intercala el mismo día formas que se confunden (imparfait/passé composé, subjonctif/indicatif, dont/que/où). Laura recupera de memoria antes de ver la respuesta. Minutos 0-12: LECCIÓN del punto del día, enseñando como a alguien que no lo sabe: 3-4 ejemplos de su vida → le preguntas por escrito qué patrón ve → explicas la regla con su nombre (el del TECFÉE), cuándo se usa, cómo se forma paso a paso, el error típico del hispanohablante y la comparación con el español. Usa `plus` para la explicación completa. Comprueba que entendió con un `choix` o `trou`. Minutos 12-27: 2-3 series de 5-6 `ejercicios` (choix, trou, transformer, ordre), de fácil a difícil, intercalando los `items_hoy`. Minutos 27-30: repaso de lo que falló.",
  escritura:
    "ÉCRITURE (30 min) = OUTPUT ESCRITO (min 0-20) + FLUIDEZ ESCRITA (min 20-30). Min 0-3: un `rediger` con una tarea real (párrafo, correo o compte rendu corto) o un dictado TECFÉE. Cuando llegue el texto: corrígelo entero, error por error (lo que escribió → la forma correcta → la regla → la comparación con el español), con la lista completa en `plus`; dile qué hizo bien de verdad; pídele que reescriba solo las frases con errores. Min 20-30: «10 minutes d'écriture»: un `rediger` sobre un tema FAMILIAR, escribir 10 minutos sin parar, sin diccionario y sin corrección durante; al recibirlo, comentas solo cantidad de palabras y fluidez (máximo 1 observación de lengua). El cierre de la sesión va al final.",
};

// Los bloques se guardan como texto «[[tipo]] texto», que es lo que lee la app y lo que Lidia ve en el historial.
// Los ejercicios van al final, en una sola línea «[[exercices]] [json]».
function aTexto(bloques: { tipo: string; texto: string }[], ejercicios: unknown[] = []): string {
  const partes = bloques.map((b) => `[[${b.tipo}]] ${b.texto.trim()}`);
  if (ejercicios.length) partes.push(`[[exercices]] ${JSON.stringify(ejercicios)}`);
  return partes.join("\n\n");
}

// Forma exacta del JSON que devuelve Lidia (ver lidia-prompt.md).
const ESQUEMA_RESPUESTA = {
  type: "object",
  additionalProperties: false,
  // `voz` va primero: con la respuesta en flujo, la app empieza a hablar antes de que llegue el resto.
  required: ["voz", "bloques", "ejercicios", "nuevos_items", "resultados_items", "resumen_sesion", "recuerdos", "resultado_cierre"],
  properties: {
    voz: { type: ["string", "null"] },
    // El mensaje partido por tipo: la app pinta cada tipo con su color, etiqueta e icono.
    bloques: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tipo", "texto"],
        properties: {
          tipo: { type: "string", enum: TIPOS_BLOQUE },
          texto: { type: "string" },
        },
      },
    },
    ejercicios: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tipo", "consigne", "texto", "opciones", "respuesta", "explicacion", "item_id"],
        properties: {
          tipo: { type: "string", enum: TIPOS_EJERCICIO },
          consigne: { type: "string" },
          texto: { type: "string" },
          opciones: { type: "array", items: { type: "string" } },
          respuesta: { type: "string" },
          explicacion: { type: "string" },
          item_id: { type: ["string", "null"] },
        },
      },
    },
    nuevos_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tipo", "original", "correcto", "patron", "nota"],
        properties: {
          tipo: { type: "string", enum: ["error", "expresion", "palabra"] },
          original: { type: ["string", "null"] },
          correcto: { type: "string" },
          patron: { type: "string", enum: ["como_suena", "espanol", "verbo_bloque", "genero_numero", "otro"] },
          nota: { type: ["string", "null"] },
        },
      },
    },
    resultados_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "acierto"],
        properties: { id: { type: "string" }, acierto: { type: "boolean" } },
      },
    },
    resumen_sesion: { type: "string" },
    // Hechos estables de la vida de Laura que no estaban en `cuaderno_laura` (casi siempre vacío).
    recuerdos: { type: "array", items: { type: "string" } },
    resultado_cierre: { type: ["integer", "null"] },
  },
};

// ── Diagnóstico de nivel (Paso 0 del plan, 11-nov-2026) ──
const NIVELES = ["A1", "A2", "A2+", "B1", "B1+", "B2", "B2+", "C1", "C1+", "C2"];
const NIVEL_DESTREZA = {
  type: "object", additionalProperties: false, required: ["nivel", "justificacion"],
  properties: { nivel: { type: "string", enum: NIVELES }, justificacion: { type: "string" } },
};
const ESQUEMA_DIAGNOSTICO = {
  type: "object",
  additionalProperties: false,
  required: ["comprension", "oral", "escrito", "global", "fortalezas", "prioridades", "recomendacion", "mensaje"],
  properties: {
    comprension: NIVEL_DESTREZA,
    oral: NIVEL_DESTREZA,
    escrito: NIVEL_DESTREZA,
    global: { type: "string", enum: NIVELES },
    fortalezas: { type: "array", items: { type: "string" } },
    prioridades: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["tema", "ejemplo", "por_que"],
        properties: { tema: { type: "string" }, ejemplo: { type: "string" }, por_que: { type: "string" } },
      },
    },
    recomendacion: { type: "string" },
    mensaje: { type: "string" },
  },
};
const PROMPT_DIAGNOSTICO = `Eres evaluadora certificada de francés (DELF/DALF, CECR) y conoces el TECFÉE de Quebec. Evalúas el diagnóstico de Laura, colombiana hispanohablante que vive en Saint-Eustache (Quebec) y aprende francés québécois. Recibes un JSON con:
- escucha: 3 audios graduados (A2, B1, B2/C1), 2 preguntas de opción múltiple cada uno, con sus aciertos y cuántas veces escuchó.
- oral: 4 consignas graduadas (A2, B1, B2, C1) con la transcripción AUTOMÁTICA de lo que dijo y los segundos. La transcripción la hizo una máquina: no cuentes tildes, puntuación ni letras raras; sí cuentan la gramática, el vocabulario, la coherencia, el alcance y cuánto produce. Si saltó una consigna, eso indica su techo.
- escrito: un correo a una garderie, tecleado (aquí sí cuentan la ortografía, los acuerdos, la puntuación y el registro formal, con criterios del TECFÉE).
Reglas: nivela por destreza según el CECR, con honestidad y sin inflar. Con poca evidencia, elige el nivel más bajo defendible y dilo en la justificación. Comprensión: el nivel más alto en el que acertó las 2 preguntas (con 1/2, el nivel intermedio, por ejemplo B1+ si acertó B1 entero y la mitad de B2/C1). Usa los signos + (A2+, B1+, B2+, C1+) cuando esté entre dos niveles.
Devuelve: justificaciones en español (2-3 frases, citando lo que dijo o escribió); 2-3 fortalezas reales; las 3 prioridades más rentables, cada una con un ejemplo exacto de su producción y el porqué; recomendacion: qué debe ajustar Lidia en sus clases (nivel de los textos del Oral, foco de Gramática, exigencia en Conversación y Écriture), en 2-3 frases; mensaje: 3-4 frases en francés québécois, cálido y directo, para Laura, con su nivel y un primer objetivo concreto.`;

type Item = { id: string; intervalo: number; aciertos_seguidos: number };
type ItemBanco = Item & { tipo: string; original: string | null; correcto: string };

// Mismo ítem = mismo tipo y mismo texto original (o correcto si no hay original), sin mayúsculas ni espacios extra.
function claveItem(it: { tipo: string; original?: string | null; correcto?: string | null }): string {
  return `${it.tipo}|${(it.original || it.correcto || "").trim().replace(/\s+/g, " ").toLowerCase()}`;
}

function hoyMas(dias: number): string {
  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: ZONA }); // YYYY-MM-DD
  const d = new Date(`${hoy}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Racha amable (CLAUDE.md, regla 6): cuenta días con sesión hacia atrás desde hoy.
// Un día suelto sin estudiar se congela una sola vez (no suma ni corta); dos días seguidos la reinician.
const HITOS = [7, 30, 60];
function racha(fechas: string[]) {
  const dias = new Set(fechas);
  let dias_seguidos = 0;
  let congelada = false;
  let atras = dias.has(hoyMas(0)) ? 0 : 1; // si hoy todavía no hay sesión, se cuenta desde ayer
  while (true) {
    if (dias.has(hoyMas(-atras))) {
      dias_seguidos++;
      atras++;
    } else if (!congelada && dias_seguidos > 0 && dias.has(hoyMas(-atras - 1))) {
      congelada = true;
      atras++;
    } else break;
  }
  return { dias_seguidos, racha_congelada: congelada, hito: HITOS.includes(dias_seguidos) ? dias_seguidos : null };
}

// El repaso espaciado (1/3/7/21/60) y la validación de resultados viven en reglas.js.

function aBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Últimos turnos como mensajes alternados user/assistant que empiezan por user.
function armarHistorial(filas: { rol: string; contenido: string | null }[]): Anthropic.MessageParam[] {
  const msgs: Anthropic.MessageParam[] = [];
  for (const f of filas) {
    const role = f.rol === "laura" ? "user" : "assistant";
    const texto = f.contenido ?? "";
    if (!msgs.length && role === "assistant") continue;
    const ultimo = msgs[msgs.length - 1];
    if (ultimo && ultimo.role === role) ultimo.content += `\n\n${texto}`;
    else msgs.push({ role, content: texto });
  }
  return msgs;
}

function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const claveAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  if (!claveAnthropic) return json({ error: "Falta el secreto ANTHROPIC_API_KEY en Supabase" }, 500);
  const anthropic = new Anthropic({ apiKey: claveAnthropic });

  // Cliente con el token de Laura: RLS limita todo a sus filas.
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });

  let entrada: {
    sesion_id: string;
    fase: string;
    mensaje: string;
    foto_path?: string | null; // ruta en el bucket "textos"
    resumen_sesion?: string | null;
    items_hoy?: unknown[];
    simulacro?: boolean;
    material?: string | null; // lo que Laura escucha hoy en el bloque oral
    entrada?: string; // dictated | typed | edited_after_dictation (también los viejos dictado/escrito)
    minuto_bloque?: number;
    actividad?: { mode?: string } | null; // el cliente solo pide un modo; el resto lo decide reglas.js
    resultados_ejercicios?: unknown; // [{exercise_id, answer, status, source}] de la serie que terminó Laura
    flujo?: boolean; // true: responde en NDJSON, primero la voz y luego todo (la app empieza a hablar antes)
  };
  try {
    entrada = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  // Diagnóstico de nivel: rama aparte (Sonnet), guarda el resultado y el nivel en perfil.nivel.
  if ((entrada as { diagnostico?: unknown }).diagnostico) {
    const respuestas = (entrada as { diagnostico: unknown }).diagnostico;
    const { data: perfil } = await db.from("perfil").select("user_id").maybeSingle();
    if (!perfil?.user_id) return json({ error: "Sin sesión" }, 401);
    let resp;
    try {
      resp = await anthropic.beta.messages.create({
        model: MODELO_CORRECCION,
        max_tokens: 6000,
        system: PROMPT_DIAGNOSTICO,
        messages: [{ role: "user", content: JSON.stringify(respuestas).slice(0, 60000) }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: ESQUEMA_DIAGNOSTICO } },
      } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    } catch (e) {
      if (e instanceof Anthropic.APIError) return json({ error: `Error de Claude ${e.status}: ${e.message}` }, 502);
      throw e;
    }
    const bloque = resp.content.find((b) => b.type === "text");
    let resultado;
    try { resultado = JSON.parse(bloque && "text" in bloque ? bloque.text : ""); } catch { return json({ error: "Evaluación ilegible" }, 502); }
    resultado.fecha = hoyMas(0);
    await db.from("diagnosticos").insert({ respuestas, resultado });
    await db.from("perfil").update({ nivel: resultado }).eq("user_id", perfil.user_id);
    return json({ resultado });
  }
  // `items_hoy` del cliente se ignora: los ítems que tocan hoy los calcula el servidor.
  const { sesion_id, fase, mensaje, foto_path, resumen_sesion, simulacro = false, material = null } = entrada;
  const modoEntrada = normalizarEntrada(entrada.entrada);
  const actividad = construirActividad(fase, entrada.actividad?.mode, mensaje);
  // Tramo (hebra) según el minuto del bloque; sin minuto, el primero.
  const tramo = tramoActual(fase, typeof entrada.minuto_bloque === "number" ? entrada.minuto_bloque : 0);
  if (!sesion_id || !fase || typeof mensaje !== "string") {
    return json({ error: "Faltan sesion_id, fase o mensaje" }, 400);
  }

  const [perfilR, sesionR, ayerR, historialR, fechasR, hoyR, emitidosR] = await Promise.all([
    db.from("perfil").select("user_id, fase_plan, tema_semana, memoria, nivel").maybeSingle(),
    db.from("sesiones").select("id, fecha, texto_n").eq("id", sesion_id).maybeSingle(),
    db.from("sesiones").select("fecha, resumen").neq("id", sesion_id).not("resumen", "is", null)
      .order("creado", { ascending: false }).limit(SESIONES_ANTERIORES),
    db.from("mensajes").select("rol, contenido").eq("sesion_id", sesion_id)
      .order("creado", { ascending: false }).limit(TURNOS_HISTORIAL),
    db.from("sesiones").select("fecha").order("fecha", { ascending: false }).limit(400),
    db.from("banco").select("id, tipo, original, correcto, patron")
      .lte("proxima", hoyMas(0)).eq("dominado", false).order("proxima").limit(12),
    db.from("mensajes").select("contenido").eq("sesion_id", sesion_id).eq("rol", "lidia")
      .like("contenido", "%[[exercices]]%").order("creado", { ascending: false }).limit(20),
  ]);
  if (!sesionR.data) return json({ error: "Sesión no encontrada" }, 404);
  const items_hoy = hoyR.data ?? [];

  // Texto del día del Oral (tabla textos_oral, 52 días en rotación). Cada sesión toma el siguiente número
  // la primera vez que entra al Oral; después del día 52 vuelve al 1 (segunda vuelta, más nivel).
  let texto_del_dia: Record<string, unknown> | null = null;
  if (fase === "oral") {
    let n = sesionR.data.texto_n as number | null;
    if (!n) {
      const { data: ultimo } = await db.from("sesiones").select("texto_n").neq("id", sesion_id).not("texto_n", "is", null)
        .order("texto_n", { ascending: false }).limit(1).maybeSingle();
      n = (ultimo?.texto_n ?? 0) + 1;
      await db.from("sesiones").update({ texto_n: n }).eq("id", sesion_id);
    }
    const { data: textos } = await db.from("textos_oral")
      .select("dia, tema, eje, nivel, texto_fr, frases_shadowing, preguntas, expresiones, fuente_url").order("dia");
    if (textos?.length) {
      const total = textos.length;
      const t = textos[(n - 1) % total]; // si falta un día, el orden sigue con el siguiente que exista
      texto_del_dia = { ...t, vuelta: Math.ceil(n / total) };
    }
  }

  // Resultados de ejercicios: la fuente de verdad son los ejercicios emitidos en esta sesión, no el texto.
  const emitidos = ejerciciosEmitidos((emitidosR.data ?? []).map((m: { contenido: string }) => m.contenido));
  const validacion = validarResultados(entrada.resultados_ejercicios, emitidos);

  // Foto opcional: se descarga del bucket con los permisos de Laura.
  let imagen: Anthropic.ImageBlockParam | null = null;
  if (foto_path) {
    const { data: archivo, error } = await db.storage.from("textos").download(foto_path);
    if (error || !archivo) return json({ error: "No pude leer la foto" }, 400);
    const tipo = (archivo.type || "image/jpeg") as "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    imagen = {
      type: "image",
      source: { type: "base64", media_type: tipo, data: aBase64(new Uint8Array(await archivo.arrayBuffer())) },
    };
  }

  // Lo que cambia en cada llamada va después del prompt cacheado.
  const contexto = {
    fase_sesion: fase,
    fase_plan: perfilR.data?.fase_plan ?? 1,
    tema_semana: perfilR.data?.tema_semana ?? "Ma vie au Québec",
    items_hoy,
    // Memoria larga: hechos de su vida (no le vuelvas a preguntar lo que ya está aquí) y las últimas sesiones.
    cuaderno_laura: perfilR.data?.memoria ?? [],
    // Nivel medido en el diagnóstico (o null si no lo ha hecho). Ajusta la dificultad con esto, no a ojo:
    // input un poco por encima de `comprension` (i+1), exigencia de producción un poco por encima de `oral`/`escrito`,
    // y trabaja sus `prioridades`.
    nivel_laura: perfilR.data?.nivel
      ? {
        comprension: perfilR.data.nivel.comprension?.nivel, oral: perfilR.data.nivel.oral?.nivel,
        escrito: perfilR.data.nivel.escrito?.nivel, global: perfilR.data.nivel.global, fecha: perfilR.data.nivel.fecha,
        prioridades: (perfilR.data.nivel.prioridades ?? []).map((p: { tema: string }) => p.tema),
        recomendacion: perfilR.data.nivel.recomendacion,
        como_ajustar: "Input un poco por encima de `comprension` (i+1); exige producción un poco por encima de `oral` y `escrito`; trabaja sus `prioridades`. No vuelvas a evaluar su nivel a ojo.",
      }
      : null,
    resumen_ayer: ayerR.data?.[0]?.resumen ?? null,
    sesiones_anteriores: (ayerR.data ?? []).slice(1).map((r: { fecha: string; resumen: string }) => `${r.fecha}: ${r.resumen}`),
    resumen_sesion: resumen_sesion ?? null,
    material_oral: material || null,
    texto_del_dia,
    minuto_bloque: typeof entrada.minuto_bloque === "number" ? entrada.minuto_bloque : null,
    entrada: modoEntrada,
    modo_bloque: MODO_BLOQUE[fase] ?? null,
    hebra_actual: tramo,
    actividad,
    resultados_aplicados: validacion.aceptados.length
      ? validacion.aceptados.map((r) => ({ tipo: r.tipo, respuesta: r.answer, estado: r.status }))
      : null,
    ...racha((fechasR.data ?? []).map((s: { fecha: string }) => s.fecha)),
  };
  // La actividad va justo antes del mensaje de Laura: lo último que lee Lidia.
  const textoUsuario = `<contexto>\n${JSON.stringify(contexto)}\n</contexto>\n\n<actividad>\n${textoActividad(actividad, tramo)}\n</actividad>\n\n${mensaje}`;
  const historial = armarHistorial((historialR.data ?? []).reverse());
  const ultimo = historial[historial.length - 1];
  const contenidoNuevo: Anthropic.ContentBlockParam[] = imagen
    ? [imagen, { type: "text", text: textoUsuario }]
    : [{ type: "text", text: textoUsuario }];
  if (ultimo?.role === "user") {
    // Dos turnos seguidos de Laura (p. ej. Lidia falló antes): se juntan en uno.
    ultimo.content = [{ type: "text", text: ultimo.content as string }, ...contenidoNuevo];
  } else {
    historial.push({ role: "user", content: contenidoNuevo });
  }

  const corrige = Boolean(imagen) || simulacro;
  const parametros = {
    model: corrige ? MODELO_CORRECCION : MODELO_CHARLA,
    max_tokens: corrige ? 16000 : 8000,
    system: [{ type: "text", text: PROMPT_LIDIA, cache_control: { type: "ephemeral" } }],
    messages: historial,
    output_config: { effort: corrige ? "medium" : "low", format: { type: "json_schema", schema: ESQUEMA_RESPUESTA } },
    // Si un filtro de seguridad rechaza la corrección, Anthropic la reintenta con otro modelo.
    ...(corrige ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  } as Anthropic.Beta.MessageCreateParamsNonStreaming;

  function errorClaude(e: unknown): [number, { error: string }] {
    if (e instanceof Anthropic.AuthenticationError) return [500, { error: "Clave de Anthropic inválida" }];
    if (e instanceof Anthropic.RateLimitError) return [429, { error: "Demasiadas solicitudes, intenta en un momento" }];
    if (e instanceof Anthropic.APIError) return [502, { error: `Error de Claude ${e.status}: ${e.message}` }];
    throw e;
  }

  // Todo lo que pasa después de la respuesta de Claude: validar, guardar y armar lo que recibe la app.
  async function terminar(respuesta: Anthropic.Beta.BetaMessage): Promise<[number, Record<string, unknown>]> {
    if (respuesta.stop_reason === "refusal") return [502, { error: "Claude rechazó la solicitud" }];
    if (respuesta.stop_reason === "max_tokens") return [502, { error: "La respuesta de Lidia quedó cortada" }];
    const texto = respuesta.content.find((b) => b.type === "text");
    let lidia;
    try {
      lidia = JSON.parse(texto && "text" in texto ? texto.text : "");
    } catch {
      return [502, { error: "Lidia no devolvió JSON válido" }];
    }
    // Cada ejercicio lleva un id del servidor: es lo único que la app puede devolver como resultado.
    lidia.ejercicios = ponerIds(lidia.ejercicios ?? [], () => crypto.randomUUID());
    lidia.mensaje = aTexto(lidia.bloques, lidia.ejercicios);

    // Guardar: mensajes, ítems nuevos, repaso de ítems y estado de la sesión.
    await db.from("mensajes").insert([
      { sesion_id, rol: "laura", fase, contenido: mensaje, imagen_url: foto_path ?? null },
      { sesion_id, rol: "lidia", fase, contenido: lidia.mensaje },
    ]);

    // Banco: primero los resultados validados de los ejercicios; después lo que propone el modelo, validado.
    const hayIntento = !esAvisoSistema(mensaje);
    const yaAplicados = new Set<string>();
    const cambios: { item_id: string; status: string }[] = [];
    for (const r of validacion.aceptados) {
      if (r.item_id && !yaAplicados.has(r.item_id)) { yaAplicados.add(r.item_id); cambios.push({ item_id: r.item_id, status: r.status }); }
    }
    const idsHoy = new Set(items_hoy.map((it: { id: string }) => it.id));
    const delModelo = validarResultadosModelo(lidia.resultados_items, idsHoy, hayIntento, yaAplicados);
    cambios.push(...delModelo.aceptados);

    // Un error que ya está en el banco no se duplica: si Laura lo volvió a cometer en un intento real, cuenta como fallo.
    if (lidia.nuevos_items.length) {
      const { data: banco } = await db.from("banco").select("id, tipo, original, correcto, intervalo, aciertos_seguidos");
      const existentes = new Map((banco ?? []).map((b: ItemBanco) => [claveItem(b), b]));
      const vistos = new Set<string>();
      const nuevos: Record<string, unknown>[] = [];
      for (const it of lidia.nuevos_items) {
        const k = claveItem(it);
        if (vistos.has(k)) continue;
        vistos.add(k);
        const previo = existentes.get(k);
        if (!previo) nuevos.push({ ...it, fuente: "lidia", intervalo: 1, proxima: hoyMas(1) });
        else if (hayIntento && it.tipo === "error" && !yaAplicados.has(previo.id)) {
          yaAplicados.add(previo.id);
          cambios.push({ item_id: previo.id, status: "incorrect" });
        }
      }
      if (nuevos.length) await db.from("banco").insert(nuevos);
    }

    // Solo ítems que existen y son de Laura (RLS); `ambiguous` y `minor_error` no cambian el repaso.
    if (cambios.length) {
      const { data: items } = await db.from("banco").select("id, intervalo, aciertos_seguidos").in("id", cambios.map((c) => c.item_id));
      const porId = new Map((items ?? []).map((it: Item) => [it.id, it]));
      await Promise.all(cambios.map((c) => {
        const item = porId.get(c.item_id);
        if (!item) { validacion.rechazos.push({ exercise_id: null, motivo: `ítem ${c.item_id} no existe o no es de Laura` }); return null; }
        const nuevo = repasar(item, c.status as "correct", hoyMas);
        return nuevo ? db.from("banco").update(nuevo).eq("id", item.id) : null;
      }));
    }
    const rechazos = [...validacion.rechazos, ...delModelo.rechazos];
    if (rechazos.length) console.warn(`lidia: rechazos de validación ${JSON.stringify(rechazos)}`);

    const cambiosSesion: Record<string, unknown> = { fase_actual: fase, resumen: lidia.resumen_sesion };
    if (lidia.resultado_cierre !== null) cambiosSesion.resultado = lidia.resultado_cierre;
    await db.from("sesiones").update(cambiosSesion).eq("id", sesion_id);


    // Cuaderno largo: hechos nuevos de su vida, sin repetir, con tope.
    const nuevosRecuerdos = (Array.isArray(lidia.recuerdos) ? lidia.recuerdos : [])
      .map((r: unknown) => String(r ?? "").trim().slice(0, 300)).filter(Boolean);
    if (nuevosRecuerdos.length && perfilR.data?.user_id) {
      const previos: string[] = perfilR.data.memoria ?? [];
      const ya = new Set(previos.map((r) => r.toLowerCase()));
      const memoria = [...previos, ...nuevosRecuerdos.filter((r: string) => !ya.has(r.toLowerCase()))].slice(-MAX_RECUERDOS);
      await db.from("perfil").update({ memoria }).eq("user_id", perfilR.data.user_id);
    }
    return [200, { ...lidia, actividad, validacion: { aplicados: cambios, rechazos }, modelo: respuesta.model, uso: respuesta.usage }];
  }

  // Sin flujo: igual que antes, un solo JSON.
  if (!entrada.flujo) {
    let respuesta;
    try {
      respuesta = await anthropic.beta.messages.create(parametros);
    } catch (e) {
      const [st, cuerpo] = errorClaude(e);
      return json(cuerpo, st);
    }
    const [st, cuerpo] = await terminar(respuesta);
    return json(cuerpo, st);
  }

  // Con flujo (NDJSON): una línea {"tipo":"voz"} apenas Claude termina de escribir `voz`
  // (es el primer campo del JSON) y al final {"tipo":"fin", ...} o {"tipo":"error"}.
  const codificador = new TextEncoder();
  const flujo = new ReadableStream({
    async start(control) {
      const linea = (o: unknown) => control.enqueue(codificador.encode(JSON.stringify(o) + "\n"));
      try {
        const stream = anthropic.beta.messages.stream(parametros);
        let acumulado = "";
        let vozMandada = false;
        for await (const ev of stream) {
          if (vozMandada || ev.type !== "content_block_delta" || ev.delta.type !== "text_delta") continue;
          acumulado += ev.delta.text;
          const m = acumulado.match(/^\s*\{\s*"voz"\s*:\s*(null|"(?:[^"\\]|\\.)*")/);
          if (m) {
            vozMandada = true;
            const voz = JSON.parse(m[1]);
            if (voz) linea({ tipo: "voz", voz });
          } else if (acumulado.length > 4000) vozMandada = true;
        }
        const [st, cuerpo] = await terminar(await stream.finalMessage());
        linea(st === 200 ? { tipo: "fin", ...cuerpo } : { tipo: "error", status: st, ...cuerpo });
      } catch (e) {
        try {
          const [st, cuerpo] = errorClaude(e);
          linea({ tipo: "error", status: st, ...cuerpo });
        } catch {
          linea({ tipo: "error", status: 500, error: String((e as Error)?.message ?? e) });
        }
      }
      control.close();
    },
  });
  return new Response(flujo, { headers: { ...CORS, "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
});
