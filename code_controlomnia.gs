/**
 * Omnia Control — Apps Script unificado
 * =========================================================================
 * Esta es la ÚNICA base de datos y el ÚNICO backend para todas las apps de
 * Omnia Technology (CRM, POS, Rutas, las que agregues después). Reemplaza
 * la idea de que cada app tenga su propio generador de claves: todas las
 * claves de licencia se emiten y verifican aquí, contra el mismo Sheet.
 *
 * QUÉ HACE ESTE ARCHIVO
 * ---------------------------------------------------------------------
 *  1. Sirve de API para el Control Maestro (listar/crear/editar registros).
 *  2. Expone el endpoint que cada app cliente consulta para saber si su
 *     licencia sigue activa (GET ?action=verify).
 *  3. Recibe solicitudes de demo desde el sitio público y genera la
 *     licencia con expiración automática según el producto.
 *  4. Crea sesiones de Stripe Checkout y procesa el webhook de Stripe
 *     (sin necesitar Node ni un servidor aparte).
 *  5. Corre sola cada hora (trigger de tiempo) para expirar demos vencidas
 *     y mandar avisos de "tu demo está por vencer" / "tu demo venció" /
 *     "tu licencia se bloqueó por falta de pago" — todo por correo, con
 *     MailApp, sin depender de un proveedor externo.
 *  6. Valida la clave del administrador para el login del Control Maestro.
 *
 * ANTES DE PUBLICAR — CONFIGURA TUS SECRETOS
 * ---------------------------------------------------------------------
 * Nunca pongas claves reales escritas en este archivo. Ve a
 * Configuración del proyecto (ícono de engrane) → Propiedades del script
 * → añade:
 *   ADMIN_KEY               tu clave de acceso al Control Maestro
 *   STRIPE_SECRET_KEY       sk_live_... (o sk_test_... mientras pruebas)
 *   STRIPE_WEBHOOK_SECRET   whsec_...
 *   NOTIFICATION_EMAIL      correo donde quieres recibir avisos de tickets
 *   AUTOMATION_WEBHOOK_URL  (opcional) URL de un agente que quieras avisar
 *
 * PREPARA EL SHEET con estas pestañas y encabezados exactos:
 *   Products     → id, name, category, proPrice, billingCycle, demoDurationDays, description, stripePriceId, appUrl
 *                   (appUrl es opcional: la URL pública de esa app, ej. https://tu-usuario.github.io/tu-app/.
 *                   Si la llenas, el correo de demo le manda al cliente el link directo además de la clave.)
 *   Licenses     → id, productId, clientName, email, type, key, status, createdAt, expiresAt, stripeCustomerId, stripeSubscriptionId, lastNotifiedAt
 *   Sales        → id, productId, clientName, email, amount, date, stripeSessionId
 *   Payments     → id, licenseId, clientName, amount, date, status
 *   DemoRequests → id, productId, name, email, company, licenseId, createdAt
 *   Tickets      → id, clientName, email, subject, message, status, priority, createdAt
 *   Leads        → id, businessName, contactName, whatsapp, email, city, products, notes, createdAt, status
 *                   (Leads = solicitudes de "contratar/pedir información" que NO generan licencia
 *                   automáticamente — quedan como pendientes de seguimiento manual desde el Control
 *                   Maestro hasta que decidas cobrar y crear la venta/licencia tú mismo.)
 *
 * PUBLICAR: Implementar → Nueva implementación → Aplicación web →
 * Ejecutar como "Yo" → Acceso "Cualquier usuario". Copia la URL /exec.
 *
 * ACTIVAR LA AUTOMATIZACIÓN: Triggers (reloj, barra lateral) → Añadir
 * trigger → función "revisarLicencias" → Basado en tiempo → cada hora.
 */

const SHEET_NAMES = {
  products: "Products", licenses: "Licenses", sales: "Sales",
  payments: "Payments", demos: "DemoRequests", tickets: "Tickets",
  leads: "Leads", config: "Config",
};
const DIAS_AVISO_PREVIO = 2; // manda el recordatorio de "tu demo vence pronto" con estos días de anticipación

// =====================================================================
// ENTRADA HTTP
// =====================================================================
function doGet(e) {
  const action = e.parameter.action;

  if (action === "list") return jsonResponse(sheetToObjects(getSheet(e.parameter.sheet)));
  if (action === "verify") return handleVerify(e.parameter.key, e.parameter.productId);
  if (action === "verificarAdminKey") return handleVerificarAdminKey(e.parameter.key);
  if (action === "products") return jsonResponse(sheetToObjects(getSheet(SHEET_NAMES.products)));

  return jsonResponse({ error: "Acción no soportada" });
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);

  // Webhook de Stripe: no trae "action", trae "type" y "data" (formato del evento de Stripe).
  if (body.type && body.data && !body.action) {
    return handleStripeWebhook(e, body);
  }

  const { action, sheet: sheetName, data, id } = body;

  if (action === "create") { appendRow(getSheet(sheetName), data); return jsonResponse({ ok: true, data }); }
  if (action === "update") { updateRowById(getSheet(sheetName), id, data); return jsonResponse({ ok: true }); }
  if (action === "delete") { deleteRowById(getSheet(sheetName), id); return jsonResponse({ ok: true }); }

  if (action === "demoRequest") return handleDemoRequest(body);
  if (action === "leadRequest") return handleLeadRequest(body);
  if (action === "createCheckoutSession") return handleCreateCheckoutSession(body);
  if (action === "createBillingPortalSession") return handleCreateBillingPortalSession(body);
  if (action === "supportTicket") return handleSupportTicket(body);
  if (action === "toggleLicense") return handleToggleLicense(body.id);
  if (action === "updateLeadStatus") return handleUpdateLeadStatus(body);

  return jsonResponse({ error: "Acción no soportada" });
}

// =====================================================================
// VERIFICACIÓN DE LICENCIA (la consultan las apps cliente al arrancar)
// =====================================================================
function handleVerify(key, productId) {
  const cfgGlobal = leerConfigGlobal();
  if (cfgGlobal.activo === false) {
    return jsonResponse({ status: "service_disabled", message: cfgGlobal.mensaje || "El servicio está temporalmente desactivado por Omnia Technology." });
  }

  const licenses = sheetToObjects(getSheet(SHEET_NAMES.licenses));
  const lic = licenses.find((l) => l.key === key && (!productId || l.productId === productId));
  if (!lic) return jsonResponse({ status: "not_found" });

  if (lic.expiresAt && new Date(lic.expiresAt) < new Date() && lic.status === "active") {
    updateRowById(getSheet(SHEET_NAMES.licenses), lic.id, { status: "expired" });
    return jsonResponse({ status: "expired", clientName: lic.clientName || "" });
  }
  if (lic.status !== "active") return jsonResponse({ status: lic.status, clientName: lic.clientName || "" });

  return jsonResponse({ status: "active", expiresAt: lic.expiresAt || null, clientName: lic.clientName || "", type: lic.type || "" });
}

// Interruptor global de todo el servicio (todas las apps, todos los clientes).
// Vive en la pestaña "Config" (fila con id="global") para que lo puedas
// prender/apagar desde la hoja o desde Configuración en el Control Maestro,
// sin tocar código — por ejemplo, si necesitas apagar todo temporalmente.
function leerConfigGlobal() {
  const rows = sheetToObjects(getSheet(SHEET_NAMES.config));
  const row = rows.find((r) => r.id === "global");
  if (!row) return { activo: true, mensaje: "" };
  return { activo: String(row.activo).toUpperCase() !== "FALSE", mensaje: row.mensaje || "" };
}

// =====================================================================
// LOGIN DEL ADMINISTRADOR (Control Maestro)
// =====================================================================
function handleVerificarAdminKey(key) {
  const adminKey = PropertiesService.getScriptProperties().getProperty("ADMIN_KEY");
  const ok = !!adminKey && key === adminKey;
  return jsonResponse({ ok });
}

// =====================================================================
// SOLICITUD DE DEMO (desde el sitio público)
// Acepta un solo producto (productId, compatibilidad con omnia-site.html)
// o varios a la vez (productIds: [...], usado por index.html / funeral360.html
// cuando el cliente pide demo de más de un módulo en la misma solicitud).
// =====================================================================
function handleDemoRequest(body) {
  const { name, email, company } = body;
  const productIds = Array.isArray(body.productIds) && body.productIds.length
    ? body.productIds
    : (body.productId ? [body.productId] : []);
  if (!productIds.length) return jsonResponse({ error: "No se especificó ningún producto" });

  const products = sheetToObjects(getSheet(SHEET_NAMES.products));
  const results = [];

  productIds.forEach((productId) => {
    const product = products.find((p) => p.id === productId);
    if (!product) { results.push({ productId, error: "Producto no encontrado" }); return; }

    const licenseId = "lic_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    const key = genKey();
    const dias = Number(product.demoDurationDays) || 7;
    const expiresAt = new Date(Date.now() + dias * 86400000).toISOString();

    appendRow(getSheet(SHEET_NAMES.licenses), {
      id: licenseId, productId, clientName: company || name, email, type: "demo",
      key, status: "active", createdAt: new Date().toISOString(), expiresAt,
      stripeCustomerId: "", stripeSubscriptionId: "", lastNotifiedAt: "",
    });
    appendRow(getSheet(SHEET_NAMES.demos), {
      id: "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      productId, name, email, company, licenseId, createdAt: new Date().toISOString(),
    });

    enviarCorreo(email,
      `Tu demo de ${product.name} ya está activa`,
      `Hola ${name},\n\nTu clave de acceso a la demo de ${product.name} es:\n\n${key}\n\nEstará activa hasta el ${formatFecha(expiresAt)}.` +
      (product.appUrl ? `\n\nEntra a tu app aquí:\n${product.appUrl}` : '') +
      `\n\n— Omnia Technology`);

    notificarWebhook({ licenseId, client: company || name, productId }, "demo_created");
    results.push({ productId, productName: product.name, key, expiresAt });
  });

  // Compatibilidad hacia atrás: si solo se pidió un producto, devuelve también
  // key/expiresAt "planos" como lo esperaba omnia-site.html.
  const response = { results };
  if (results.length === 1 && !results[0].error) {
    response.key = results[0].key;
    response.expiresAt = results[0].expiresAt;
  }
  return jsonResponse(response);
}

// =====================================================================
// LEAD DE VENTA — "Contratar" / "Pedir información" (desde el sitio público)
// No genera licencia automáticamente: queda registrado para que tú le des
// seguimiento y, cuando cierres el trato, crees la venta/licencia desde el
// Control Maestro (o mandes el link de pago de Stripe).
// =====================================================================
function handleLeadRequest(body) {
  const { businessName, contactName, whatsapp, email, city, notes } = body;
  const productIds = Array.isArray(body.productIds) ? body.productIds : [];
  if (!businessName || !whatsapp) return jsonResponse({ error: "Falta el nombre del negocio o el WhatsApp" });

  const id = "lead_" + Date.now();
  appendRow(getSheet(SHEET_NAMES.leads), {
    id, businessName, contactName: contactName || "", whatsapp, email: email || "",
    city: city || "", products: productIds.join(", "), notes: notes || "",
    createdAt: new Date().toISOString(), status: "nuevo",
  });

  const notifyEmail = PropertiesService.getScriptProperties().getProperty("NOTIFICATION_EMAIL");
  if (notifyEmail) {
    enviarCorreo(notifyEmail, `Nueva solicitud de contratación: ${businessName}`,
      `Negocio: ${businessName}\nContacto: ${contactName || "(no indicado)"}\nWhatsApp: ${whatsapp}\nCorreo: ${email || "(no indicado)"}\nCiudad: ${city || "(no indicada)"}\nMódulos de interés: ${productIds.join(", ") || "(no indicado)"}\n\n${notes || ""}`);
  }

  return jsonResponse({ id, status: "nuevo" });
}

// =====================================================================
// ACTUALIZAR ESTADO DE UN LEAD (botón del Control Maestro)
// =====================================================================
function handleUpdateLeadStatus(body) {
  const { id, status } = body;
  if (!id || !status) return jsonResponse({ error: "Falta id o status" });
  updateRowById(getSheet(SHEET_NAMES.leads), id, { status });
  return jsonResponse({ ok: true, status });
}

// =====================================================================
// STRIPE — portal de facturación (el cliente paga/gestiona su suscripción solo)
// =====================================================================
function handleCreateBillingPortalSession(body) {
  const { email } = body;
  const licenses = sheetToObjects(getSheet(SHEET_NAMES.licenses));
  const lic = licenses.filter((l) => l.email === email && l.type === "pro" && l.stripeCustomerId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!lic) return jsonResponse({ error: "No encontramos una cuenta Pro con ese correo." });

  const secretKey = PropertiesService.getScriptProperties().getProperty("STRIPE_SECRET_KEY");
  const res = UrlFetchApp.fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "post",
    headers: { Authorization: "Bearer " + secretKey },
    payload: { customer: lic.stripeCustomerId, return_url: "https://tu-sitio.com/portal" },
    muteHttpExceptions: true,
  });
  const json = JSON.parse(res.getContentText());
  if (json.error) return jsonResponse({ error: json.error.message });
  return jsonResponse({ url: json.url });
}

// =====================================================================
// STRIPE — crear sesión de pago
// =====================================================================
function handleCreateCheckoutSession(body) {
  const { productId, email, clientName } = body;
  const products = sheetToObjects(getSheet(SHEET_NAMES.products));
  const product = products.find((p) => p.id === productId);
  if (!product) return jsonResponse({ error: "Producto no encontrado" });
  if (!product.stripePriceId) return jsonResponse({ error: "Este producto no tiene stripePriceId configurado en el Sheet" });

  const secretKey = PropertiesService.getScriptProperties().getProperty("STRIPE_SECRET_KEY");
  const mode = product.billingCycle === "Único" ? "payment" : "subscription";

  const payload = {
    "mode": mode,
    "customer_email": email,
    "line_items[0][price]": product.stripePriceId,
    "line_items[0][quantity]": "1",
    "metadata[productId]": productId,
    "metadata[clientName]": clientName,
    "success_url": "https://tu-sitio.com/gracias?session_id={CHECKOUT_SESSION_ID}",
    "cancel_url": "https://tu-sitio.com/productos",
  };

  const res = UrlFetchApp.fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "post",
    headers: { Authorization: "Bearer " + secretKey },
    payload,
    muteHttpExceptions: true,
  });

  const json = JSON.parse(res.getContentText());
  if (json.error) return jsonResponse({ error: json.error.message });
  return jsonResponse({ url: json.url });
}

// =====================================================================
// STRIPE — webhook
// =====================================================================
function handleStripeWebhook(e, body) {
  const webhookSecret = PropertiesService.getScriptProperties().getProperty("STRIPE_WEBHOOK_SECRET");
  const signatureHeader = e.parameter["Stripe-Signature"] || (e.headers && e.headers["Stripe-Signature"]);
  // Nota: Apps Script no siempre expone headers personalizados en doPost; si Stripe no llega firmado
  // aquí, considera un proxy ligero (Cloudflare Worker) solo para reenviar el webhook con el header intacto.
  if (webhookSecret && signatureHeader && !verificarFirmaStripe(e.postData.contents, signatureHeader, webhookSecret)) {
    return jsonResponse({ error: "Firma inválida" });
  }

  const type = body.type;
  const obj = body.data.object;

  if (type === "checkout.session.completed") {
    const productId = obj.metadata.productId;
    const clientName = obj.metadata.clientName;
    const licenseId = "lic_" + Date.now();
    const key = genKey();

    appendRow(getSheet(SHEET_NAMES.licenses), {
      id: licenseId, productId, clientName, email: obj.customer_email, type: "pro", key,
      status: "active", createdAt: new Date().toISOString(), expiresAt: "",
      stripeCustomerId: obj.customer, stripeSubscriptionId: obj.subscription || "", lastNotifiedAt: "",
    });
    appendRow(getSheet(SHEET_NAMES.sales), {
      id: "sale_" + Date.now(), productId, clientName, email: obj.customer_email,
      amount: obj.amount_total, date: new Date().toISOString(), stripeSessionId: obj.id,
    });

    enviarCorreo(obj.customer_email, "Tu licencia Pro está activa",
      `Hola ${clientName},\n\nTu clave de licencia es:\n\n${key}\n\n— Omnia Technology`);
  }

  if (type === "invoice.paid") {
    const lic = sheetToObjects(getSheet(SHEET_NAMES.licenses)).find((l) => l.stripeSubscriptionId === obj.subscription);
    if (lic) {
      updateRowById(getSheet(SHEET_NAMES.licenses), lic.id, { status: "active" });
      appendRow(getSheet(SHEET_NAMES.payments), {
        id: "pay_" + Date.now(), licenseId: lic.id, clientName: lic.clientName,
        amount: obj.amount_paid, date: new Date().toISOString(), status: "completado",
      });
    }
  }

  if (type === "invoice.payment_failed") {
    const lic = sheetToObjects(getSheet(SHEET_NAMES.licenses)).find((l) => l.stripeSubscriptionId === obj.subscription);
    if (lic) {
      updateRowById(getSheet(SHEET_NAMES.licenses), lic.id, { status: "locked" });
      enviarCorreo(lic.email, "No pudimos procesar tu pago",
        `Hola ${lic.clientName},\n\nTu licencia quedó suspendida porque el cobro no pasó. Actualiza tu método de pago para reactivarla.\n\n— Omnia Technology`);
      notificarWebhook(lic, "locked");
    }
  }

  return jsonResponse({ received: true });
}

function verificarFirmaStripe(payload, signatureHeader, secret) {
  const parts = {};
  signatureHeader.split(",").forEach((p) => { const [k, v] = p.split("="); parts[k] = v; });
  const signedPayload = parts.t + "." + payload;
  const bytes = Utilities.computeHmacSha256Signature(signedPayload, secret);
  const hex = bytes.map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0")).join("");
  return hex === parts.v1;
}

// =====================================================================
// SOPORTE
// =====================================================================
function handleSupportTicket(body) {
  const { clientName, email, subject, message, priority } = body;
  const id = "tk_" + Date.now();
  appendRow(getSheet(SHEET_NAMES.tickets), {
    id, clientName, email, subject, message, status: "abierto", priority: priority || "media",
    createdAt: new Date().toISOString(),
  });
  const notifyEmail = PropertiesService.getScriptProperties().getProperty("NOTIFICATION_EMAIL");
  if (notifyEmail) enviarCorreo(notifyEmail, `Nuevo ticket: ${subject}`, `${clientName} (${email}) escribió:\n\n${message}`);
  return jsonResponse({ id, status: "abierto" });
}

// =====================================================================
// ACTIVAR / BLOQUEAR MANUAL (botón del Control Maestro)
// =====================================================================
function handleToggleLicense(id) {
  const lic = sheetToObjects(getSheet(SHEET_NAMES.licenses)).find((l) => l.id === id);
  if (!lic) return jsonResponse({ error: "Licencia no encontrada" });
  const nuevo = lic.status === "active" ? "locked" : "active";
  updateRowById(getSheet(SHEET_NAMES.licenses), id, { status: nuevo });
  notificarWebhook(lic, nuevo);
  return jsonResponse({ status: nuevo });
}

// =====================================================================
// AUTOMATIZACIÓN — correr cada hora (configurar el trigger manualmente)
// =====================================================================
function revisarLicencias() {
  const sheet = getSheet(SHEET_NAMES.licenses);
  const licencias = sheetToObjects(sheet);
  const ahora = Date.now();

  licencias.forEach((l) => {
    if (l.type !== "demo" || !l.expiresAt) return;
    const vence = new Date(l.expiresAt).getTime();

    if (l.status === "active" && vence < ahora) {
      updateRowById(sheet, l.id, { status: "expired", lastNotifiedAt: "expired" });
      enviarCorreo(l.email, "Tu demo ha vencido",
        `Hola,\n\nTu período de demo terminó. Si quieres seguir usando la app, responde este correo o visita omnia.tech para activar tu licencia Pro.\n\n— Omnia Technology`);
      notificarWebhook(l, "expired");
      return;
    }
    const diasRestantes = (vence - ahora) / 86400000;
    if (l.status === "active" && diasRestantes <= DIAS_AVISO_PREVIO && diasRestantes > 0 && l.lastNotifiedAt !== "soon") {
      updateRowById(sheet, l.id, { lastNotifiedAt: "soon" });
      enviarCorreo(l.email, "Tu demo está por vencer",
        `Hola,\n\nTu demo vence en ${Math.ceil(diasRestantes)} día(s). Si te interesa continuar, activa tu licencia Pro antes de que termine.\n\n— Omnia Technology`);
    }
  });
}

// =====================================================================
// UTILIDADES DE HOJA (genéricas, iguales al esquema del Control Maestro)
// =====================================================================
function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}
function sheetToObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter((row) => row.some((cell) => cell !== "" && cell !== null))
    .map((row) => { const obj = {}; headers.forEach((h, i) => { obj[h] = row[i] instanceof Date ? row[i].toISOString() : row[i]; }); return obj; });
}
function appendRow(sheet, data) {
  const headers = ensureHeaders(sheet, Object.keys(data));
  sheet.appendRow(headers.map((h) => (data[h] !== undefined ? data[h] : "")));
}
function updateRowById(sheet, id, patch) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf("id");
  if (idCol === -1) return;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === String(id)) {
      Object.keys(patch).forEach((key) => {
        let col = headers.indexOf(key);
        if (col === -1) { headers.push(key); sheet.getRange(1, headers.length).setValue(key); col = headers.length - 1; }
        sheet.getRange(r + 1, col + 1).setValue(patch[key]);
      });
      return;
    }
  }
}
function deleteRowById(sheet, id) {
  const values = sheet.getDataRange().getValues();
  const idCol = values[0].indexOf("id");
  if (idCol === -1) return;
  for (let r = 1; r < values.length; r++) { if (String(values[r][idCol]) === String(id)) { sheet.deleteRow(r + 1); return; } }
}
function ensureHeaders(sheet, keys) {
  const firstRow = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  const hasHeaders = firstRow.some((c) => c !== "");
  if (!hasHeaders) { sheet.getRange(1, 1, 1, keys.length).setValues([keys]); return keys; }
  return firstRow.filter((h) => h !== "");
}
function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function genKey() {
  const seg = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}
function formatFecha(iso) {
  return new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "long", year: "numeric" });
}
function enviarCorreo(destinatario, asunto, cuerpo) {
  try { MailApp.sendEmail(destinatario, asunto, cuerpo); } catch (e) { console.error("No se pudo enviar correo:", e.message); }
}
function notificarWebhook(license, evento) {
  const url = PropertiesService.getScriptProperties().getProperty("AUTOMATION_WEBHOOK_URL");
  if (!url) return;
  try {
    UrlFetchApp.fetch(url, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ licenseId: license.id, client: license.clientName, event: evento }),
      muteHttpExceptions: true,
    });
  } catch (e) { console.error("Webhook de automatización falló:", e.message); }
}

