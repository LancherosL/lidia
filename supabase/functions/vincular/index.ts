// Edge Function "vincular": conecta el ícono de la pantalla de inicio sin correo.
// - crear (con la sesión de Safari): genera un código de 6 dígitos que vale 10 minutos.
// - canjear (desde el ícono, sin sesión): si el código es válido, devuelve una llave de un solo uso
//   que la app cambia por su propia sesión. No se envía ningún correo.
// No usa verify_jwt: "crear" valida la sesión aquí mismo y "canjear" se protege con el código.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MINUTOS = 10; // los intentos máximos (5) viven en la función SQL vinculos_intentar

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(cuerpo: unknown, status = 200) {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function huella(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function crear(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await admin.auth.getUser(token);
  const usuaria = data?.user;
  if (!usuaria) return json({ error: "Primero entra a Lidia en Safari" }, 401);

  // Solo un código vivo a la vez.
  await admin.from("vinculos").update({ usado: true }).eq("user_id", usuaria.id).eq("usado", false);
  const codigo = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const id = crypto.randomUUID();
  const { error } = await admin.from("vinculos").insert({
    id,
    user_id: usuaria.id,
    codigo_hash: await huella(id + codigo),
    expira: new Date(Date.now() + MINUTOS * 60_000).toISOString(),
  });
  if (error) return json({ error: "No pude crear el código" }, 500);
  return json({ codigo, minutos: MINUTOS });
}

async function canjear(codigo: string) {
  if (!/^\d{6}$/.test(codigo)) return json({ error: "El código tiene 6 dígitos" }, 400);
  // Suma el intento antes de comparar (atómico en la base): no se puede adivinar en paralelo.
  const { data: vivos } = await admin.rpc("vinculos_intentar");

  for (const v of (vivos ?? []) as { id: string; user_id: string; codigo_hash: string }[]) {
    if ((await huella(v.id + codigo)) !== v.codigo_hash) continue;
    await admin.from("vinculos").update({ usado: true }).eq("id", v.id);
    const { data: u } = await admin.auth.admin.getUserById(v.user_id);
    if (!u?.user?.email) return json({ error: "No encontré la cuenta" }, 500);
    const { data: enlace, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: u.user.email });
    if (error || !enlace?.properties?.hashed_token) return json({ error: "No pude abrir la sesión" }, 500);
    return json({ token_hash: enlace.properties.hashed_token });
  }

  // Código equivocado: el intento ya quedó contado; al quinto, vinculos_intentar anula el código.
  await new Promise((r) => setTimeout(r, 800));
  return json({ error: "Código incorrecto o vencido. Pide uno nuevo en Safari." }, 401);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  let entrada: { accion?: string; codigo?: string } = {};
  try {
    entrada = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }
  if (entrada.accion === "crear") return crear(req);
  if (entrada.accion === "canjear") return canjear(String(entrada.codigo ?? "").replace(/\D/g, ""));
  return json({ error: "Acción desconocida" }, 400);
});
