// Edge Function "voz": convierte un texto en audio y lo guarda en caché en el bucket privado "voz",
// para no volver a generar la misma frase.
// Voz principal (9-nov-2026, decisión de Laura: $0): Azure fr-CA-SylvieNeural, plan F0 gratis
// (secretos AZURE_SPEECH_KEY y AZURE_SPEECH_REGION). Respaldo: Gemini Aoede con su límite gratis (GEMINI_API_KEY).
// Si Azure no está configurado o falla, se usa Gemini. Nada de esto es de pago.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODELO = "gemini-3.8-flash-tts";
const VOZ_AZURE = "fr-CA-SylvieNeural";
// Velocidad en SSML: 0,95 normal y 0,75 lento (dictado y shadowing).
const RITMO_AZURE = { normal: "-5%", lento: "-25%" };
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

function escaparXml(t: string) {
  return t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

// Azure Speech (REST oficial). Devuelve mp3, o null si no está configurado o falla.
async function vozAzure(texto: string, lento: boolean): Promise<Uint8Array | null> {
  const clave = Deno.env.get("AZURE_SPEECH_KEY");
  const region = Deno.env.get("AZURE_SPEECH_REGION");
  if (!clave || !region) return null;
  const ssml = `<speak version='1.0' xml:lang='fr-CA'><voice name='${VOZ_AZURE}'>` +
    `<prosody rate='${lento ? RITMO_AZURE.lento : RITMO_AZURE.normal}'>${escaparXml(texto)}</prosody></voice></speak>`;
  try {
    const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": clave,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "lidia",
      },
      body: ssml,
    });
    if (!r.ok) { console.error(`Azure ${r.status}: ${(await r.text()).slice(0, 200)}`); return null; }
    const audio = new Uint8Array(await r.arrayBuffer());
    return audio.length ? audio : null;
  } catch (e) {
    console.error(`Azure: ${(e as Error).message}`);
    return null;
  }
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

  // Misma frase con la misma voz y el mismo ritmo = mismo archivo (Azure en mp3, Gemini en wav).
  const ritmo = lento ? "lento" : "normal";
  const rutaAzure = `cache/${await sha256(`azure|${VOZ_AZURE}|${ritmo}|${texto}`)}.mp3`;
  const rutaGemini = `cache/${await sha256(`${MODELO}|${VOZ}|${ritmo}|${texto}`)}.wav`;
  const firmar = (r: string) => admin.storage.from("voz").createSignedUrl(r, 3600);
  const azureActiva = Boolean(Deno.env.get("AZURE_SPEECH_KEY") && Deno.env.get("AZURE_SPEECH_REGION"));
  for (const r of azureActiva ? [rutaAzure] : [rutaAzure, rutaGemini]) {
    const yaEsta = await firmar(r);
    if (yaEsta.data?.signedUrl) return json({ url: yaEsta.data.signedUrl, cache: true });
  }

  let audio: Uint8Array | null = await vozAzure(texto, lento);
  let ruta = rutaAzure;
  let tipoAudio = "audio/mpeg";
  if (!audio) {
    // Respaldo: Gemini, con su límite gratis (10 frases al día). Primero, por si ya la tenía en caché.
    const yaEsta = await firmar(rutaGemini);
    if (yaEsta.data?.signedUrl) return json({ url: yaEsta.data.signedUrl, cache: true });
    const claveGemini = Deno.env.get("GEMINI_API_KEY");
    if (!claveGemini) return json({ error: "Sin voz: falta AZURE_SPEECH_KEY y GEMINI_API_KEY" }, 502);
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
    audio = deBase64(parte.data);
    if (/L16|pcm/i.test(tipo)) audio = aWav(audio, Number(/rate=(\d+)/.exec(tipo)?.[1] ?? 24000));
    ruta = rutaGemini;
    tipoAudio = "audio/wav";
  }
  const listo = audio;

  const subir = () => admin.storage.from("voz").upload(ruta, listo, { contentType: tipoAudio, upsert: true });
  // Lidia pide «directo»: el audio nuevo sale ya y se guarda en caché después, sin hacerla esperar.
  // Défilé sigue recibiendo la URL firmada.
  if (directo) {
    const guardar = subir().then(({ error }) => { if (error) console.error(`No pude guardar el audio: ${error.message}`); });
    // @ts-ignore EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(guardar); else await guardar;
    return new Response(listo, { headers: { ...CORS, "Content-Type": tipoAudio, "Cache-Control": "no-store" } });
  }
  const subida = await subir();
  if (subida.error) return json({ error: `No pude guardar el audio: ${subida.error.message}` }, 500);
  const firmada = await firmar(ruta);
  if (!firmada.data?.signedUrl) return json({ error: "No pude firmar el audio" }, 500);
  return json({ url: firmada.data.signedUrl, cache: false });
});
