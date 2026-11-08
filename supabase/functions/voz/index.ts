// Edge Function "voz": convierte un texto en audio con ElevenLabs (voz B de la prueba ciega del 7-nov)
// y lo guarda en caché en el bucket privado "voz", para no volver a generar la misma frase.
// La clave vive solo aquí, como secreto ELEVENLABS_API_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODELO = "eleven_v4";
const VOZ = "EXAVITQu4vr4xnSDxMaL"; // Sarah
const VELOCIDAD = 0.95;
const MAX_CARACTERES = 600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "content-type",
};

function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function sha256(texto: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const claveEleven = Deno.env.get("ELEVENLABS_API_KEY");
  if (!claveEleven) return json({ error: "Falta el secreto ELEVENLABS_API_KEY en Supabase" }, 500);

  // Solo con la sesión de Laura (además de verify_jwt): así nadie más gasta el cupo.
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: usuaria } = await admin.auth.getUser(token);
  if (!usuaria?.user) return json({ error: "Sin sesión" }, 401);

  let texto = "", directo = false;
  try {
    const cuerpo = await req.json();
    texto = String(cuerpo.texto ?? "").replace(/\s+/g, " ").trim();
    directo = cuerpo.directo === true;
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  if (!texto) return json({ error: "Falta el texto" }, 400);
  if (texto.length > MAX_CARACTERES) texto = texto.slice(0, MAX_CARACTERES);

  // Misma frase con la misma voz = mismo archivo.
  const ruta = `cache/${await sha256(`${MODELO}|${VOZ}|${VELOCIDAD}|${texto}`)}.mp3`;
  const firmar = () => admin.storage.from("voz").createSignedUrl(ruta, 3600);
  const yaEsta = await firmar();
  if (yaEsta.data?.signedUrl) return json({ url: yaEsta.data.signedUrl, cache: true });

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOZ}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": claveEleven, "Content-Type": "application/json" },
    body: JSON.stringify({ text: texto, model_id: MODELO, language_code: "fr", voice_settings: { speed: VELOCIDAD } }),
  });
  if (!r.ok) {
    let detalle = `ElevenLabs ${r.status}`;
    try { detalle += `: ${(await r.json()).detail?.message ?? ""}`; } catch {}
    return json({ error: detalle }, 502);
  }
  const audio = new Uint8Array(await r.arrayBuffer());
  const subir = () => admin.storage.from("voz").upload(ruta, audio, { contentType: "audio/mpeg", upsert: true });
  // Lidia pide «directo»: el audio nuevo sale ya y se guarda en caché después, sin hacerla esperar.
  // Défilé sigue recibiendo la URL firmada.
  if (directo) {
    const guardar = subir().then(({ error }) => { if (error) console.error(`No pude guardar el audio: ${error.message}`); });
    // @ts-ignore EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(guardar); else await guardar;
    return new Response(audio, { headers: { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  }
  const subida = await subir();
  if (subida.error) return json({ error: `No pude guardar el audio: ${subida.error.message}` }, 500);
  const firmada = await firmar();
  if (!firmada.data?.signedUrl) return json({ error: "No pude firmar el audio" }, 500);
  return json({ url: firmada.data.signedUrl, cache: false });
});
