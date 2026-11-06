// Edge Function "defile-generar": escribe el siguiente lote de tarjetas para Défilé.
// La clave de Anthropic vive solo aquí, como secreto ANTHROPIC_API_KEY. verify_jwt: solo con sesión.
// Cada tarjeta sale de una búsqueda en fuentes confiables; sin fuente encontrada, no se presenta.
import Anthropic from "npm:@anthropic-ai/sdk@0.136.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { generar, type Senales } from "./generar.ts";

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
  const claveAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  if (!claveAnthropic) return json({ error: "Falta el secreto ANTHROPIC_API_KEY en Supabase" }, 500);

  // verify_jwt también deja pasar la llave anónima: solo genera con una sesión real.
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: quien } = await db.auth.getUser();
  if (!quien?.user) return json({ error: "Necesitas iniciar sesión" }, 401);

  let s: Senales;
  try {
    s = await req.json();
  } catch {
    return json({ error: "Cuerpo inválido" }, 400);
  }
  const r = await generar(s, new Anthropic({ apiKey: claveAnthropic }));
  return json(r, "error" in r ? 502 : 200);
});

