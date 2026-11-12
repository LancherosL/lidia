// Edge Function "oido": transcribe lo que Laura dice. Todo gratis (decisión de Laura, 9-nov-2026: $0).
// 1. Gemini (entiende el español en medio del francés). Su plan gratis da solo 20 transcripciones al día.
// 2. Si Gemini se agota, falla o devuelve algo que no es una transcripción: Azure Speech fr-CA
//    (plan F0, 5 h al mes; secretos AZURE_SPEECH_KEY y AZURE_SPEECH_REGION). Azure solo entiende WAV:
//    la app manda el audio en WAV 16 kHz mono.
// Si las dos fallan, la app se queda con lo que escribió el dictado del navegador.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODELO = "gemini-3.5-flash";
const MAX_BYTES = 15 * 1024 * 1024;
const INSTRUCCION =
  "Transcribe exactly what is said, word for word, in the language it was said. " +
  "The speaker is a Spanish speaker learning Québec French: most of it is French, but she may say some words in Spanish " +
  "when she does not know them; write those words in Spanish, as said. Do not correct her grammar or pronunciation, " +
  "do not translate, do not add anything. She is a woman: keep feminine agreements when that is what she says. " +
  "When a sound is unclear, prefer the word that fits the conversation context given below. " +
  "Return only the words she said in the field `texto`: no timestamps, no notes, no analysis.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-contexto",
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

// Lo que no es una transcripción: otra escritura (árabe, cirílico, chino…), marcas de tiempo o comentarios del modelo.
function esBasura(t: string): boolean {
  return /[\u0590-\u06FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]/.test(t) ||
    /\d\d:\d\d\s*-\s*\d\d:\d\d/.test(t) ||
    /\b(the user wants|transcript|let's listen|audio content)\b/i.test(t);
}

async function gemini(audio: Uint8Array, tipo: string, instruccion: string): Promise<string | null> {
  const clave = Deno.env.get("GEMINI_API_KEY");
  if (!clave) return null;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": clave, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: instruccion }, { inlineData: { mimeType: tipo, data: aBase64(audio) } }] }],
      // Respuesta en JSON con un solo campo: así no se cuelan notas ni razonamiento en la transcripción.
      generationConfig: {
        temperature: 0,
        thinkingConfig: { thinkingLevel: "low" },
        responseMimeType: "application/json",
        responseSchema: { type: "OBJECT", properties: { texto: { type: "STRING" } }, required: ["texto"] },
      },
    }),
  }).catch(() => null);
  if (!r) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.warn(`oido: Gemini ${r.status} ${String(d?.error?.message ?? "").slice(0, 120)}`); return null; }
  const partes = d?.candidates?.[0]?.content?.parts ?? [];
  const crudo = partes.filter((p: { text?: string; thought?: boolean }) => p.text && !p.thought).map((p: { text: string }) => p.text).join("");
  let texto = "";
  try { texto = String(JSON.parse(crudo).texto ?? ""); } catch { texto = ""; }
  texto = texto.replace(/\s+/g, " ").trim();
  if (!texto || esBasura(texto)) { console.warn("oido: Gemini devolvió algo que no es una transcripción"); return null; }
  return texto;
}

// Azure: audio corto de hasta 60 s por petición; el WAV se parte en trozos de 50 s.
function wavCon(pcm: Uint8Array, hz: number): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length);
  const v = new DataView(wav.buffer);
  const txt = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  txt(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); txt(8, "WAVE"); txt(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, hz, true); v.setUint32(28, hz * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  txt(36, "data"); v.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}
async function azure(audio: Uint8Array): Promise<string | null> {
  const clave = Deno.env.get("AZURE_SPEECH_KEY");
  const region = Deno.env.get("AZURE_SPEECH_REGION");
  if (!clave || !region || audio.length < 44) return null;
  const v = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  if (String.fromCharCode(...audio.subarray(0, 4)) !== "RIFF") return null;
  const hz = v.getUint32(24, true);
  const pcm = audio.subarray(44);
  const trozo = hz * 2 * 50;
  const partes: string[] = [];
  for (let i = 0; i < pcm.length; i += trozo) {
    const r = await fetch(
      `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=fr-CA&format=simple`,
      {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": clave, "Content-Type": `audio/wav; codecs=audio/pcm; samplerate=${hz}` },
        body: wavCon(pcm.subarray(i, i + trozo), hz),
      },
    ).catch(() => null);
    if (!r) return partes.length ? partes.join(" ") : null;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.warn(`oido: Azure ${r.status}`); return partes.length ? partes.join(" ") : null; }
    if (d.RecognitionStatus === "Success" && d.DisplayText) partes.push(String(d.DisplayText));
  }
  const texto = partes.join(" ").replace(/\s+/g, " ").trim();
  return texto || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  // Solo con la sesión de Laura (además de verify_jwt): así nadie más gasta el cupo.
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: usuaria } = await admin.auth.getUser(token);
  if (!usuaria?.user) return json({ error: "Sin sesión" }, 401);

  // El cuerpo es el audio: WAV 16 kHz si la app pudo convertirlo; si no, tal cual (webm en Chrome, mp4 en Safari).
  const tipo = (req.headers.get("Content-Type") || "audio/webm").split(";")[0];
  const audio = new Uint8Array(await req.arrayBuffer());
  if (!audio.length) return json({ error: "Falta el audio" }, 400);
  if (audio.length > MAX_BYTES) return json({ error: "Audio demasiado largo" }, 413);
  // Contexto opcional (lo último que dijo Lidia): ayuda a oír bien, nunca se transcribe.
  let contexto = "";
  try { contexto = decodeURIComponent(req.headers.get("x-contexto") ?? "").slice(0, 600); } catch { /* sin contexto */ }
  // Su cuaderno (perfil.memoria) trae los nombres de su vida: Gemini los reconoce mejor.
  const { data: perfil } = await admin.from("perfil").select("memoria").eq("user_id", usuaria.user.id).maybeSingle();
  const vida = (perfil?.memoria ?? []).join(" ").slice(0, 1500);
  if (vida) contexto = `Facts about her life (names and places she may say): ${vida}\n${contexto}`;
  const instruccion = contexto ? `${INSTRUCCION}\n\nConversation context (do not transcribe it): ${contexto}` : INSTRUCCION;

  let motor = "gemini";
  let texto = await gemini(audio, tipo, instruccion);
  if (!texto && tipo === "audio/wav") { motor = "azure"; texto = await azure(audio); }
  if (!texto) return json({ error: "No pude transcribir el audio" }, 502);
  return json({ texto, motor });
});
