// Edge Function "lidia": recibe un turno de la sesión, llama a Claude y guarda todo en el banco.
// La clave de Anthropic vive solo aquí, como secreto ANTHROPIC_API_KEY.
import Anthropic from "npm:@anthropic-ai/sdk@0.136.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { PROMPT_LIDIA } from "./prompt.ts";
import {
  construirActividad, textoActividad, normalizarEntrada, ponerIds, ejerciciosEmitidos,
  validarResultados, validarResultadosModelo, repasar, esAvisoSistema,
} from "./reglas.js";

const MODELO_CHARLA = "claude-haiku-5-5";
const MODELO_CORRECCION = "claude-sonnet-5-5"; // fotos y simulacros
const TURNOS_HISTORIAL = 16; // 8 turnos de Laura y 8 de Lidia
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
const MODO_BLOQUE: Record<string, string> = {
  conversacion:
    "CONVERSATION (30 min). Charla real sobre su vida, una pregunta a la vez. Corriges enseñando (qué dijo, forma correcta, por qué, comparación con el español). Aquí sí se habla.",
  oral:
    "ORAL (30 min). No es charla libre. Minutos 0-12: trabajas con su material (`material_oral`): qué vio, qué no entendió; explicas 3-4 expresiones que oyó, con su sentido y un ejemplo. Minutos 12-28: series de `ejercicios` `repeter` y `dictee` (5-6 por serie). Minutos 28-30: las 3 frases que mejor salieron.",
  gramatica:
    "GRAMMAIRE (30 min). PROHIBIDO pedirle que hable, que diga algo en voz alta o que repita oralmente: aquí todo es lectura, explicación y ejercicios escritos. Minutos 0-12: LECCIÓN del punto del día, enseñando como a alguien que no lo sabe: 3-4 ejemplos de su vida → le preguntas por escrito qué patrón ve → explicas la regla con su nombre (el del TECFÉE), cuándo se usa, cómo se forma paso a paso, el error típico del hispanohablante y la comparación con el español. Usa `plus` para la explicación completa. Comprueba que entendió con un `choix` o `trou`. Minutos 12-27: 2-3 series de 5-6 `ejercicios` (choix, trou, transformer, ordre), de fácil a difícil, intercalando los `items_hoy`. Minutos 27-30: repaso de lo que falló.",
  escritura:
    "ÉCRITURE (30 min). Minutos 0-3: un `rediger` con una tarea real. Cuando llegue el texto: corrígelo entero, error por error (lo que escribió → la forma correcta → la regla → la comparación con el español), con la lista completa en `plus`; dile qué hizo bien de verdad; pídele que reescriba solo las frases con errores. Minutos 20-30: segunda versión y cierre.",
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
  required: ["bloques", "ejercicios", "voz", "nuevos_items", "resultados_items", "resumen_sesion", "resultado_cierre"],
  properties: {
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
    voz: { type: ["string", "null"] },
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
    resultado_cierre: { type: ["integer", "null"] },
  },
};

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
  };
  try {
    entrada = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  // `items_hoy` del cliente se ignora: los ítems que tocan hoy los calcula el servidor.
  const { sesion_id, fase, mensaje, foto_path, resumen_sesion, simulacro = false, material = null } = entrada;
  const modoEntrada = normalizarEntrada(entrada.entrada);
  const actividad = construirActividad(fase, entrada.actividad?.mode, mensaje);
  if (!sesion_id || !fase || typeof mensaje !== "string") {
    return json({ error: "Faltan sesion_id, fase o mensaje" }, 400);
  }

  const [perfilR, sesionR, ayerR, historialR, fechasR, hoyR, emitidosR] = await Promise.all([
    db.from("perfil").select("fase_plan, tema_semana").maybeSingle(),
    db.from("sesiones").select("id, fecha").eq("id", sesion_id).maybeSingle(),
    db.from("sesiones").select("resumen").neq("id", sesion_id).not("resumen", "is", null)
      .order("creado", { ascending: false }).limit(1).maybeSingle(),
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
    resumen_ayer: ayerR.data?.resumen ?? null,
    resumen_sesion: resumen_sesion ?? null,
    material_oral: material || null,
    minuto_bloque: typeof entrada.minuto_bloque === "number" ? entrada.minuto_bloque : null,
    entrada: modoEntrada,
    modo_bloque: MODO_BLOQUE[fase] ?? null,
    actividad,
    resultados_aplicados: validacion.aceptados.length
      ? validacion.aceptados.map((r) => ({ tipo: r.tipo, respuesta: r.answer, estado: r.status }))
      : null,
    ...racha((fechasR.data ?? []).map((s: { fecha: string }) => s.fecha)),
  };
  // La actividad va justo antes del mensaje de Laura: lo último que lee Lidia.
  const textoUsuario = `<contexto>\n${JSON.stringify(contexto)}\n</contexto>\n\n<actividad>\n${textoActividad(actividad)}\n</actividad>\n\n${mensaje}`;
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
  let respuesta;
  try {
    respuesta = await anthropic.beta.messages.create({
      model: corrige ? MODELO_CORRECCION : MODELO_CHARLA,
      max_tokens: corrige ? 16000 : 8000,
      system: [{ type: "text", text: PROMPT_LIDIA, cache_control: { type: "ephemeral" } }],
      messages: historial,
      output_config: { effort: corrige ? "medium" : "low", format: { type: "json_schema", schema: ESQUEMA_RESPUESTA } },
      // Si un filtro de seguridad rechaza la corrección, Anthropic la reintenta con otro modelo.
      ...(corrige ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "Clave de Anthropic inválida" }, 500);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Demasiadas solicitudes, intenta en un momento" }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: `Error de Claude ${e.status}: ${e.message}` }, 502);
    throw e;
  }

  if (respuesta.stop_reason === "refusal") return json({ error: "Claude rechazó la solicitud" }, 502);
  if (respuesta.stop_reason === "max_tokens") return json({ error: "La respuesta de Lidia quedó cortada" }, 502);
  const texto = respuesta.content.find((b) => b.type === "text");
  let lidia;
  try {
    lidia = JSON.parse(texto && "text" in texto ? texto.text : "");
  } catch {
    return json({ error: "Lidia no devolvió JSON válido" }, 502);
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

  return json({ ...lidia, actividad, validacion: { aplicados: cambios, rechazos }, modelo: respuesta.model, uso: respuesta.usage });
});
