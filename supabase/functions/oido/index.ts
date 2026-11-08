// Edge Function "oido": transcribe lo que Laura dice con Gemini.
// Entiende francés con palabras en español en medio («acheter des cebollas»), que el dictado del
// navegador convierte en palabras francesas raras. La clave vive solo aquí (GEMINI_API_KEY).
// (Hasta el 7-nov fue ElevenLabs Scribe: se acabó el cupo.)
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODELO = "gemini-3.5-flash";
const MAX_BYTES = 15 * 1024 * 1024;
const INSTRUCCION =
  "Transcribe exactly what is said, word for word, in the language it was said. " +
  "The speaker is a Spanish speaker learning Québec French: most of it is French, but she may say some words in Spanish " +
  "when she does not know them; write those words in Spanish, as said. Do not correct her grammar or pronunciation, " +
  "do not translate, do not add anything. Output only the transcript.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function aBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const claveGemini = Deno.env.get("GEMINI_API_KEY");
  if (!claveGemini) return json({ error: "Falta el secreto GEMINI_API_KEY en Supabase" }, 500);

  // Solo con la sesión de Laura (además de verify_jwt): así nadie más gasta el cupo.
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: usuaria } = await admin.auth.getUser(token);
  if (!usuaria?.user) return json({ error: "Sin sesión" }, 401);

  // El cuerpo es el audio tal cual lo grabó el navegador (webm en Chrome, mp4 en Safari).
  const tipo = (req.headers.get("Content-Type") || "audio/webm").split(";")[0];
  const audio = new Uint8Array(await req.arrayBuffer());
  if (!audio.length) return json({ error: "Falta el audio" }, 400);
  if (audio.length > MAX_BYTES) return json({ error: "Audio demasiado largo" }, 413);

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": claveGemini, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: INSTRUCCION }, { inlineData: { mimeType: tipo, data: aBase64(audio) } }] }],
      generationConfig: { temperature: 0 },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: `Gemini ${r.status}: ${d?.error?.message ?? ""}` }, 502);
  const partes = d?.candidates?.[0]?.content?.parts ?? [];
  const texto = partes.filter((p: { text?: string; thought?: boolean }) => p.text && !p.thought).map((p: { text: string }) => p.text).join(" ");
  return json({ texto: texto.replace(/\s+/g, " ").trim() });
});
