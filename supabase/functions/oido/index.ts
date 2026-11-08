// Edge Function "oido": transcribe lo que Laura dice con ElevenLabs Scribe.
// Entiende francés con palabras en español en medio («acheter des cebollas»), que el dictado del
// navegador convierte en palabras francesas raras. La clave vive solo aquí (ELEVENLABS_API_KEY).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODELO = "scribe_v2";
const MAX_BYTES = 20 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const claveEleven = Deno.env.get("ELEVENLABS_API_KEY");
  if (!claveEleven) return json({ error: "Falta el secreto ELEVENLABS_API_KEY en Supabase" }, 500);

  // Solo con la sesión de Laura (además de verify_jwt): así nadie más gasta el cupo.
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: usuaria } = await admin.auth.getUser(token);
  if (!usuaria?.user) return json({ error: "Sin sesión" }, 401);

  // El cuerpo es el audio tal cual lo grabó el navegador (webm en Chrome, mp4 en Safari).
  const tipo = req.headers.get("Content-Type") || "audio/webm";
  const audio = new Uint8Array(await req.arrayBuffer());
  if (!audio.length) return json({ error: "Falta el audio" }, 400);
  if (audio.length > MAX_BYTES) return json({ error: "Audio demasiado largo" }, 413);

  const form = new FormData();
  form.append("model_id", MODELO);
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([audio], { type: tipo }), tipo.includes("mp4") ? "voz.mp4" : "voz.webm");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": claveEleven },
    body: form,
  });
  if (!r.ok) {
    let detalle = `ElevenLabs ${r.status}`;
    try { detalle += `: ${(await r.json()).detail?.message ?? ""}`; } catch {}
    return json({ error: detalle }, 502);
  }
  const d = await r.json();
  return json({ texto: String(d.text ?? "").trim(), idioma: d.language_code ?? null });
});
