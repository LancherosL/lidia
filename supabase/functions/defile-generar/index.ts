// Edge Function "defile-generar": escribe 5 píldoras nuevas para Défile.
// La clave de Anthropic vive solo aquí, como secreto ANTHROPIC_API_KEY. verify_jwt: solo con sesión.
import Anthropic from "npm:@anthropic-ai/sdk@0.136.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODELO = "claude-haiku-5-5";
const CUANTAS = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Mismas claves y nombres que CATS en defile/index.html.
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

// Prompt fijo (se cachea); lo que cambia en cada llamada va en el mensaje.
const PROMPT = `Escribes píldoras para Défile, un feed de dopamina intelectual estilo TikTok mental que reemplaza el scroll de redes.
Lectora: colombiana en Quebec, francés intermedio, aprende francés de Quebec.

Cada píldora tiene:
- gancho: titular impactante en español, una frase que deja con ganas de leer.
- gancho_fr: el mismo gancho en francés.
- viñetas: máximo 3, cortas: dato, paradoja y revelación. Puedes usar <b>negrita</b> y empezar con un emoji.
- fr_chispa: una frase corta en francés, natural, que la lectora pueda repetir.
- fr_trad: su traducción al español.
- cierre: lúdico, nunca un examen. tipo "opinion" (pregunta + 2 opciones), "ab" (pregunta + 2 opciones que empiezan por "A " y "B ") o "siguiente" (frase corta para seguir deslizando, opts vacío). Las opciones pueden llevar emoji.

La proporción de francés sube con la fase: en la fase 1 casi todo va en español; en la fase 3 las viñetas pueden mezclar mucho francés.
No repitas los ganchos que se te indiquen. Datos verdaderos y verificables; si no estás segura de un dato, no lo uses.`;

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
        required: ["gancho", "gancho_fr", "viñetas", "fr_chispa", "fr_trad", "cierre"],
        properties: {
          gancho: { type: "string" },
          gancho_fr: { type: "string" },
          viñetas: { type: "array", items: { type: "string" } },
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
        },
      },
    },
  },
};

type Pildora = {
  gancho: string;
  gancho_fr: string;
  viñetas: string[];
  fr_chispa: string;
  fr_trad: string;
  cierre: { tipo: string; txt: string; opts: string[] };
};

function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const claveAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  if (!claveAnthropic) return json({ error: "Falta el secreto ANTHROPIC_API_KEY en Supabase" }, 500);

  // verify_jwt también deja pasar la llave anónima: solo genera con una sesión real.
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: quien } = await db.auth.getUser();
  if (!quien?.user) return json({ error: "Necesitas iniciar sesión" }, 401);

  let entrada: { cat?: string; fase?: number; pct?: number; ya?: string[] };
  try {
    entrada = await req.json();
  } catch {
    return json({ error: "Cuerpo inválido" }, 400);
  }
  const cat = String(entrada.cat ?? "");
  if (!(cat in CATS)) return json({ error: "Categoría desconocida" }, 400);
  const fase = Math.min(3, Math.max(1, Math.round(Number(entrada.fase) || 1)));
  const pct = Math.min(100, Math.max(0, Math.round(Number(entrada.pct) || 0)));
  const ya = (Array.isArray(entrada.ya) ? entrada.ya : []).slice(0, 12).map((g) => String(g).slice(0, 160));

  const pedido =
    `Escribe ${CUANTAS} píldoras.\nFase ${fase}/3. ${pct}% francés.\n` +
    `Categoría: ${CATS[cat]} (clave: ${cat}).\nNo repetir estos ganchos: ${JSON.stringify(ya)}`;

  const anthropic = new Anthropic({ apiKey: claveAnthropic });
  let respuesta;
  try {
    respuesta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 8000,
      system: [{ type: "text", text: PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: pedido }],
      output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "Clave de Anthropic inválida" }, 500);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Demasiadas solicitudes, intenta en un momento" }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: `Error de Claude ${e.status}: ${e.message}` }, 502);
    throw e;
  }
  if (respuesta.stop_reason === "refusal") return json({ error: "Claude no quiso escribir estas píldoras" }, 502);
  if (respuesta.stop_reason === "max_tokens") return json({ error: "La respuesta quedó cortada" }, 502);

  const texto = respuesta.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let datos: { pildoras: Pildora[] };
  try {
    datos = JSON.parse(texto);
  } catch {
    return json({ error: "Respuesta mal formada" }, 502);
  }

  const pildoras = datos.pildoras
    .filter((p) => p.gancho && p.viñetas?.length)
    .slice(0, CUANTAS)
    .map((p) => ({
      ...p,
      viñetas: p.viñetas.slice(0, 3),
      cierre: p.cierre.tipo === "siguiente" ? { tipo: "siguiente", txt: p.cierre.txt } : { ...p.cierre, opts: p.cierre.opts.slice(0, 2) },
      c: cat,
      niv: fase,
    }));
  return json({ pildoras });
});
