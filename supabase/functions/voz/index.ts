// Edge Function "voz": convierte un texto en audio con Gemini TTS (voz C de la prueba ciega del 7-nov, Aoede)
// y lo guarda en caché en el bucket privado "voz", para no volver a generar la misma frase.
// La clave vive solo aquí, como secreto GEMINI_API_KEY. (Hasta el 7-nov fue ElevenLabs, voz B: se acabó el cupo.)
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODELO = "gemini-3.8-flash-tts";
const VOZ = "Aoede";
const MAX_CARACTERES = 600;

// Gemini lee las «notas del director» como instrucciones, no en voz alta (si no, lee las notas).
const NOTAS = {
  normal: "Pace: 0.95x, natural pauses, correct liaisons.",
  lento: "Pace: slow, about 0.75x, every syllable clear, for a learner repeating after you. Correct liaisons.",
};
function guion(texto: string, lento: boolean) {
  return "Read aloud ONLY the transcript below. Do not read these notes.\n\n### DIRECTOR'S NOTES\n" +
    "Voice: feminine, a warm teacher from Québec, about 30 years old.\n" +
    "Accent: Québécois French (Québec, not France).\n" +
    `${lento ? NOTAS.lento : NOTAS.normal}\n\n### TRANSCRIPT\n${texto}`;
}

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

function deBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Si Gemini manda PCM crudo (audio/L16), se le pone la cabecera WAV para que el navegador lo toque.
function aWav(pcm: Uint8Array, hz: number): Uint8Array {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const claveGemini = Deno.env.get("GEMINI_API_KEY");
  if (!claveGemini) return json({ error: "Falta el secreto GEMINI_API_KEY en Supabase" }, 500);

  // Solo con la sesión de Laura (además de verify_jwt): así nadie más gasta el cupo.
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: usuaria } = await admin.auth.getUser(token);
  if (!usuaria?.user) return json({ error: "Sin sesión" }, 401);

  let texto = "", directo = false, lento = false;
  try {
    const cuerpo = await req.json();
    texto = String(cuerpo.texto ?? "").replace(/\s+/g, " ").trim();
    directo = cuerpo.directo === true;
    lento = cuerpo.lento === true;
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  if (!texto) return json({ error: "Falta el texto" }, 400);
  if (texto.length > MAX_CARACTERES) texto = texto.slice(0, MAX_CARACTERES);

  // Misma frase con la misma voz y el mismo ritmo = mismo archivo.
  const ruta = `cache/${await sha256(`${MODELO}|${VOZ}|${lento ? "lento" : "normal"}|${texto}`)}.wav`;
  const firmar = () => admin.storage.from("voz").createSignedUrl(ruta, 3600);
  const yaEsta = await firmar();
  if (yaEsta.data?.signedUrl) return json({ url: yaEsta.data.signedUrl, cache: true });

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": claveGemini, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: guion(texto, lento) }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOZ } } } },
    }),
  });
  const d = await r.json().catch(() => ({}));
  const parte = d?.candidates?.[0]?.content?.parts?.find((p: { inlineData?: unknown }) => p.inlineData)?.inlineData;
  if (!r.ok || !parte?.data) return json({ error: `Gemini ${r.status}: ${d?.error?.message ?? "sin audio"}` }, 502);
  const tipo = String(parte.mimeType || "");
  let audio = deBase64(parte.data);
  if (/L16|pcm/i.test(tipo)) audio = aWav(audio, Number(/rate=(\d+)/.exec(tipo)?.[1] ?? 24000));

  const subir = () => admin.storage.from("voz").upload(ruta, audio, { contentType: "audio/wav", upsert: true });
  // Lidia pide «directo»: el audio nuevo sale ya y se guarda en caché después, sin hacerla esperar.
  // Défilé sigue recibiendo la URL firmada.
  if (directo) {
    const guardar = subir().then(({ error }) => { if (error) console.error(`No pude guardar el audio: ${error.message}`); });
    // @ts-ignore EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(guardar); else await guardar;
    return new Response(audio, { headers: { ...CORS, "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
  }
  const subida = await subir();
  if (subida.error) return json({ error: `No pude guardar el audio: ${subida.error.message}` }, 500);
  const firmada = await firmar();
  if (!firmada.data?.signedUrl) return json({ error: "No pude firmar el audio" }, 500);
  return json({ url: firmada.data.signedUrl, cache: false });
});
