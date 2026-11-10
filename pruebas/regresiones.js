// Pruebas de regresión de index.html: se corren dentro de la app abierta (preview o navegador), sin sesión.
// En la consola de la página:  (0, eval)(await (await fetch("pruebas/regresiones.js")).text())
// Devuelve una promesa con la lista de resultados y deja todo como estaba (restaura las funciones simuladas).
(async () => {
  const resultados = [];
  const ok = (nombre, cond, detalle = "") => resultados.push(`${cond ? "✓" : "✗"} ${nombre}${cond ? "" : ` — ${detalle}`}`);
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  const originales = { enviar, pedirVoz, cerrarMicro, hablar };

  // Escenario: sesión falsa en Grammaire, sin red.
  for (const v of document.querySelectorAll("main > section")) v.hidden = v.id !== "v-sesion";
  estado.sesion = { id: "prueba", fase_actual: "gramatica" };
  estado.faseIdx = 2;
  estado.segundos = 3700;
  estado.corriendo = true;
  $("s-chat").innerHTML = "";
  estado.ej = null;
  pintarReloj();

  try {
    // 1. Doble toque en ↑ con el micro abierto: un solo envío, con el texto final.
    const enviados = [];
    enviar = async (t, f, extra) => { enviados.push({ t, extra }); };
    micro = { base: "" };
    cerrarMicro = async () => { micro = null; await espera(120); escribirEnCaja("je suis allée au parc"); };
    $("s-texto").value = "vista previa";
    $("b-enviar").click();
    $("b-enviar").click();
    await espera(250);
    ok("doble toque en ↑ envía una sola vez", enviados.length === 1, `${enviados.length} envíos`);
    ok("se envía el texto transcrito, no la vista previa", enviados[0]?.t === "je suis allée au parc", enviados[0]?.t);
    cerrarMicro = originales.cerrarMicro;

    // 2. Dictado editado a mano.
    estado.dictado = true;
    escribirEnCaja("je suis allé au parc");
    ok("dictado sin tocar = dictated", tipoEntrada("je suis allé au parc", null) === "dictated");
    ok("dictado corregido a mano = edited_after_dictation", tipoEntrada("je suis allée au parc", null) === "edited_after_dictation");
    ok("aviso del sistema = typed", tipoEntrada("(Exercices : grammaire)", null) === "typed");
    estado.dictado = false;
    ok("escrito = typed", tipoEntrada("bonjour", null) === "typed");

    // 3. Cambio de vista mientras Lidia habla: se calla.
    cargandoVoz = true;
    const turno = turnoVoz;
    estado.vista = "sesion";
    location.hash = "#inicio";
    await espera(80);
    ok("cambiar de vista calla a Lidia", !cargandoVoz && turnoVoz > turno);
    history.replaceState(null, "", "#sesion");
    estado.vista = "sesion";
    for (const v of document.querySelectorAll("main > section")) v.hidden = v.id !== "v-sesion";

    // 4. Audio viejo que llega tarde: no suena.
    let tocado = false;
    pedirVoz = async () => { await espera(150); return "data:audio/wav;base64,"; };
    hablar = () => { tocado = true; };
    const antesSrc = audioLidia.src;
    hablarLidia("Bonjour Laura.");
    await espera(20);
    callar();
    await espera(250);
    ok("audio que llega después de callar no se toca", audioLidia.src === antesSrc && !tocado, audioLidia.src);
    pedirVoz = originales.pedirVoz;
    hablar = originales.hablar;

    // 5. Resultados estructurados: ids de la función, ambiguous si no respondió.
    enviados.length = 0;
    const lista = [
      { id: "e1", tipo: "choix", consigne: "", texto: "Je ___ sortie.", opciones: ["ai", "suis"], respuesta: "suis", explicacion: "", item_id: "i1" },
      { id: "e2", tipo: "trou", consigne: "", texto: "Nous ___ partis.", opciones: [], respuesta: "sommes", explicacion: "", item_id: null },
      { id: "e3", tipo: "repeter", consigne: "", texto: "Il fait froid.", opciones: [], respuesta: "Il fait froid.", explicacion: "", item_id: null },
    ];
    await pintarMensaje("lidia", "[[defi]] On pratique.\n\n[[exercices]] " + JSON.stringify(lista));
    const q = (s) => estado.ej.caja.querySelector(s);
    q('.ej-opciones button[data-k="1"]').click();
    q("#ej-siguiente").click();
    q("#ej-in").value = "sommes";
    q("#ej-verificar").click();
    q("#ej-siguiente").click();
    q("#ej-siguiente").click(); // «repeter» sin grabar
    await espera(50);
    const res = enviados[0]?.extra?.resultados;
    ok("resultados con el id de cada ejercicio", JSON.stringify(res?.map((r) => r.exercise_id)) === '["e1","e2","e3"]', JSON.stringify(res));
    ok("respuestas correctas = correct", res?.[0]?.status === "correct" && res?.[1]?.status === "correct");
    ok("ejercicio sin responder = ambiguous", res?.[2]?.status === "ambiguous" && res?.[2]?.source === "speech_checker");
    ok("el texto «(Résultats…)» se sigue mostrando", /^\(Résultats des exercices : 2\/3\)/.test(enviados[0]?.t || ""));

    // 6. Recarga durante un ejercicio: si el último mensaje es de Lidia con ejercicios, la serie vuelve.
    $("s-chat").innerHTML = "";
    estado.ej = null;
    await pintarMensaje("laura", "(Exercices : grammaire et révision du jour)");
    await pintarMensaje("lidia", "[[defi]] On pratique.\n\n[[exercices]] " + JSON.stringify(lista));
    ok("recarga: la serie pendiente se vuelve a montar", Boolean(estado.ej) && estado.ej.lista.length === 3);
    await pintarMensaje("laura", "(Résultats des exercices : 3/3)\n…");
    ok("recarga: una serie ya respondida no se vuelve a montar", !estado.ej);

    // 7. Pausa durante «repeter»: el micro del ejercicio se suelta.
    await pintarMensaje("lidia", "[[defi]] Répète.\n\n[[exercices]] " + JSON.stringify([lista[2]]));
    let parada = false;
    estado.ej.grabacion = { grabadora: { stop() { parada = true; this.onstop?.(); }, mimeType: "audio/webm" }, trozos: [], flujo: { getTracks: () => [] } };
    estado.corriendo = true;
    pausar();
    ok("pausa corta la grabación de «repeter»", parada && !estado.ej.grabacion);
    ok("pausa muestra «Reprendre»", !$("s-en-pausa").hidden);

    // 8. Grammaire: la acción principal es el ejercicio, no Parler.
    desmontarEjercicios();
    ok("Grammaire: botón de ejercicios visible", !$("b-actividad").hidden);
    ok("Grammaire: Parler en segundo plano", $("b-voz").classList.contains("sec"));

    // 9. Conversation guidée: modo pedido a la función y botón de consigna.
    estado.faseIdx = 0;
    estado.sesion.fase_actual = "conversacion";
    pintarReloj();
    guardarLocal(`lidia-submodo-${hoy()}`, "guidee");
    pintarModos();
    pintarActividad();
    ok("guidée: botón de consigna", !$("b-actividad").hidden && /prise de parole/.test($("b-actividad").textContent));
    ok("guidée: se pide el modo a la función", submodo() === "guidee");
    guardarLocal(`lidia-submodo-${hoy()}`, "libre");
    pintarModos();
    pintarActividad();
    ok("libre: sin botón de actividad", $("b-actividad").hidden && submodo() === null);

    // 10. Retomar la sesión de hoy: Lidia vuelve a decir su último mensaje.
    const sbFrom = sb.from, decirOrig = decir;
    let dicho = null;
    const consulta = (datos) => { const q = { select: () => q, eq: () => q, lt: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: Array.isArray(datos) ? datos[0] : datos }), then: (r) => r({ data: datos }) }; return q; };
    sb.from = (t) => t === "sesiones" ? consulta({ id: "s1", fecha: hoy(), fase_actual: "conversacion", segundos: 120, resumen: null })
      : consulta(t === "mensajes" ? [{ rol: "lidia", contenido: "[[pregunta]] Et samedi?" }] : []);
    decir = (t) => { dicho = t; };
    estado.corriendo = false;
    try { await abrirSesion(); } finally { sb.from = sbFrom; decir = decirOrig; pausar(); }
    ok("retomar la sesión: Lidia habla", dicho === "[[pregunta]] Et samedi?", String(dicho));

    // 11. Hebras dentro del bloque: al min 20 de Conversation se anuncia la fluidez una sola vez y se cuentan los segundos.
    enviados.length = 0;
    estado.sesion = { id: `prueba-hebras-${Date.now()}`, fase_actual: "conversacion" };
    estado.faseIdx = 0;
    estado.hebras = { input: 0, output: 0, lengua: 0, fluidez: 0 };
    estado.hebrasSemana = [{ input: 900, lengua: 900 }];
    estado.segundos = 19 * 60 + 57;
    tic(); tic(); tic();
    ok("min 20: aviso de etapa de fluidez", enviados.length === 1 && /^\(Nouvelle étape : Fluidité orale/.test(enviados[0].t), JSON.stringify(enviados.map((e) => e.t)));
    tic();
    ok("el aviso de etapa no se repite", enviados.length === 1);
    ok("segundos por hebra", estado.hebras.output === 2 && estado.hebras.fluidez === 2, JSON.stringify(estado.hebras));
    ok("chip de la hebra", /Fluidité orale/.test($("s-amb-hebra").textContent), $("s-amb-hebra").textContent);
    pintarHebrasSemana();
    ok("barras de la semana", !$("s-hebras").hidden && $("s-hebras").querySelectorAll("div").length === 4);
    ok("etiqueta del aviso de etapa", etiquetaAviso("(Nouvelle étape : Fluidité orale (4/3/2))") === "⏱ Fluidité orale (4/3/2)");

    // 12. Lidia no se queda callada en los ejercicios: lee la frase y comenta el resultado.
    const hablados = [];
    const hlOrig = hablarLidia;
    hablarLidia = (t) => { hablados.push(t); };
    try {
      await pintarMensaje("lidia", "[[defi]] Répète.\n\n[[exercices]] " + JSON.stringify([lista[2], lista[1]]));
      ok("repeter: Lidia lee la frase al aparecer", hablados.at(-1) === "Il fait froid.", JSON.stringify(hablados));
      q("#ej-siguiente").click();
      q("#ej-in").value = "étions";
      q("#ej-verificar").click();
      ok("ejercicio escrito: Lidia comenta el resultado", /^Pas tout à fait\. La bonne réponse : Nous sommes partis\./.test(hablados.at(-1) || ""), hablados.at(-1));
    } finally { hablarLidia = hlOrig; }

    // 13. Bloque adelantado a mano: los tramos cuentan desde ese momento, no desde el minuto teórico.
    estado.sesion = { id: `prueba-inicio-${Date.now()}`, fase_actual: "conversacion" };
    estado.faseIdx = 0;
    estado.segundos = 9 * 60;
    sb.from = () => ({ update: () => ({ eq: async () => ({}) }) });
    try { await cambiarFase(1); } finally { sb.from = sbFrom; }
    estado.segundos += 16 * 60;
    ok("bloque adelantado: min 16 de Oral = shadowing", minutoBloque() === 16 && tramoAhora().hebra === "fluidez", `${minutoBloque()} ${tramoAhora().hebra}`);
  } catch (e) {
    resultados.push(`✗ excepción: ${e.message}`);
  } finally {
    Object.assign(window, originales);
    enviar = originales.enviar; pedirVoz = originales.pedirVoz; cerrarMicro = originales.cerrarMicro; hablar = originales.hablar;
    micro = null;
  }
  return resultados;
})();
