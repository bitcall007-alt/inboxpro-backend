// ============================================================
// InboxPro Backend v2.1 — server.js
// Express + Nodemailer + Anti-Strike PERSISTENTE (PostgreSQL)
// FIX CRÍTICO: el estado anti-strike ya NO vive en RAM.
// Sobrevive a reinicios, deploys y crashes de Railway.
// ============================================================

require('dotenv').config();
const express    = require('express');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const dns        = require('dns').promises;
const rateLimit  = require('express-rate-limit');
const crypto     = require('crypto');
const db         = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '10mb' }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error(`CORS bloqueado: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-secret'],
}));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 10,
  message:  { ok: false, error: 'Demasiadas solicitudes. Espera un momento.' },
});
app.use('/send', limiter);
app.use('/send-bulk', limiter);

function requireAuth(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next();
  if (req.headers['x-api-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }
  next();
}

// ============================================================
// SMTP — CONFIGURACIÓN Y ROTACIÓN (sin cambios — esto sí puede vivir en RAM,
// es configuración estática, no contadores que se acumulan)
// ============================================================
const smtpConfigs = [
  {
    name: 'Brevo Principal',
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  process.env.SMTP2_USER && {
    name: 'Mailgun Backup',
    host: process.env.SMTP2_HOST,
    port: parseInt(process.env.SMTP2_PORT) || 587,
    user: process.env.SMTP2_USER,
    pass: process.env.SMTP2_PASS,
  },
  process.env.SMTP3_USER && {
    name: 'SES Backup',
    host: process.env.SMTP3_HOST,
    port: parseInt(process.env.SMTP3_PORT) || 587,
    user: process.env.SMTP3_USER,
    pass: process.env.SMTP3_PASS,
  },
].filter(Boolean);

const transporters = smtpConfigs.map(cfg => ({
  name: cfg.name,
  blocked: false,
  blockUntil: 0,
  transporter: nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true, maxConnections: 5, maxMessages: 100,
    rateDelta: 1000, rateLimit: 5,
  }),
}));

let currentTransporterIdx = 0;

function getActiveTransporter() {
  const now = Date.now();
  for (let i = 0; i < transporters.length; i++) {
    const idx = (currentTransporterIdx + i) % transporters.length;
    const t = transporters[idx];
    if (t.blocked && now > t.blockUntil) t.blocked = false;
    if (!t.blocked) { currentTransporterIdx = idx; return t; }
  }
  return null;
}

function blockTransporter(idx, minutes = 30) {
  console.warn(`[SMTP] Bloqueando ${transporters[idx].name} por ${minutes} min`);
  transporters[idx].blocked = true;
  transporters[idx].blockUntil = Date.now() + minutes * 60_000;
  currentTransporterIdx = (idx + 1) % transporters.length;
}

// ============================================================
// ANTI-STRIKE — AHORA RESPALDADO EN POSTGRESQL (db.js)
// Esta es la sección que arregla el bug que detectaste.
// Cada chequeo lee de la base de datos, no de una variable en RAM.
// ============================================================
async function checkAntiStrike() {
  const state = await db.getState();

  if (state.paused) return { ok: false, reason: state.pauseReason, state };

  const maxDaily = parseInt(process.env.MAX_DAILY_EMAILS) || 300;
  if (state.sentToday >= maxDaily) {
    const reason = `Límite diario alcanzado (${maxDaily} emails). Se reanuda mañana.`;
    await db.setPaused(true, reason);
    return { ok: false, reason, state };
  }

  const maxBounce = parseFloat(process.env.MAX_BOUNCE_RATE) || 2;
  if (state.totalSent > 20) {
    const bounceRate = (state.bounceCount / state.totalSent) * 100;
    if (bounceRate >= maxBounce) {
      const reason = `Bounce rate ${bounceRate.toFixed(1)}% supera límite ${maxBounce}%. Revisa tu lista.`;
      await db.setPaused(true, reason);
      return { ok: false, reason, state };
    }
  }

  if (state.spamComplaints > 0 && state.totalSent > 0) {
    const spamRate = (state.spamComplaints / state.totalSent) * 100;
    if (spamRate >= 0.1) {
      const reason = `Spam complaint rate ${spamRate.toFixed(2)}% supera 0.1%. CRÍTICO.`;
      await db.setPaused(true, reason);
      return { ok: false, reason, state };
    }
  }

  return { ok: true, state };
}

// ============================================================
// MX VALIDATION
// ============================================================
const mxCache = new Map();

async function hasMxRecord(email) {
  const domain = email.split('@')[1];
  if (!domain) return false;
  if (mxCache.has(domain)) return mxCache.get(domain);
  try {
    const records = await dns.resolveMx(domain);
    const valid = records && records.length > 0;
    mxCache.set(domain, valid);
    return valid;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

// ============================================================
// EMAIL BUILDER
// ============================================================
function buildEmail({ to, subject, html, text, fromName, fromEmail, replyTo, priority, preheader, contact }) {
  let finalSubject = subject;
  let finalHtml    = html;
  let finalText    = text || '';

  if (contact) {
    Object.entries(contact).forEach(([k, v]) => {
      const re = new RegExp(`{{${k}}}`, 'g');
      finalSubject = finalSubject.replace(re, v || '');
      finalHtml    = finalHtml.replace(re, v || '');
      finalText    = finalText.replace(re, v || '');
    });
  }

  if (preheader && finalHtml) {
    const preheaderHtml = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;</div>`;
    finalHtml = /<body[^>]*>/i.test(finalHtml)
      ? finalHtml.replace(/<body[^>]*>/i, m => m + preheaderHtml)
      : preheaderHtml + finalHtml;
  }

  const msgId = `<${Date.now()}.${crypto.randomBytes(8).toString('hex')}@${fromEmail.split('@')[1]}>`;

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to, subject: finalSubject, html: finalHtml,
    text: finalText || stripHtml(finalHtml),
    headers: {
      'Message-ID': msgId,
      'X-Mailer': 'InboxPro/2.1',
      'X-Priority': priority || '3',
      'Precedence': 'bulk',
      'List-Unsubscribe': `<mailto:${fromEmail}?subject=unsubscribe>`,
    },
  };

  if (replyTo) mailOptions.replyTo = replyTo;
  return mailOptions;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ============================================================
// SEND — función principal (ahora persiste cada resultado en DB)
// ============================================================
async function sendSingle(mailOptions) {
  const transporterObj = getActiveTransporter();
  if (!transporterObj) throw new Error('Todos los servidores SMTP están bloqueados temporalmente.');

  try {
    const info = await transporterObj.transporter.sendMail(mailOptions);
    await db.incrementSent();
    await db.logEvent({ type: 'sent', email: mailOptions.to, messageId: info.messageId });
    return { ok: true, messageId: info.messageId, smtp: transporterObj.name };
  } catch (err) {
    const code = err.responseCode || 0;

    if (code === 421 || code === 450) {
      blockTransporter(currentTransporterIdx, 15);
      return sendSingle(mailOptions);
    }

    if (code >= 550 && code <= 554) {
      await db.incrementBounce();
      await db.logEvent({ type: 'bounce', email: mailOptions.to, errorCode: code, errorMsg: err.message });
      return { ok: false, bounce: true, error: err.message, code };
    }

    throw err;
  }
}

// ============================================================
// RUTAS
// ============================================================
app.get('/', async (req, res) => {
  const dbOk = await db.checkDbConnection();
  const state = dbOk ? await db.getState() : null;
  res.json({
    status: 'InboxPro Backend v2.1 funcionando',
    database: dbOk ? 'conectada ✓ (estado persistente)' : 'DESCONECTADA ⚠️ (configura DATABASE_URL)',
    smtp: smtpConfigs.map(c => ({ name: c.name, host: c.host })),
    antiStrike: state || { warning: 'Sin DB, no se puede leer el estado real.' },
  });
});

app.get('/status', requireAuth, async (req, res) => {
  const state = await db.getState();
  const bounceRate = state.totalSent > 0 ? ((state.bounceCount / state.totalSent) * 100).toFixed(2) : '0.00';
  res.json({
    ok: true,
    antiStrike: {
      ...state,
      bounceRate: bounceRate + '%',
      maxDaily: process.env.MAX_DAILY_EMAILS || 300,
      maxBounceRate: process.env.MAX_BOUNCE_RATE || 2,
    },
    transporters: transporters.map(t => ({
      name: t.name, blocked: t.blocked,
      blockUntil: t.blocked ? new Date(t.blockUntil).toISOString() : null,
    })),
  });
});

app.get('/history', requireAuth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const history = await db.getRecentHistory(limit);
  res.json({ ok: true, history });
});

app.post('/resume', requireAuth, async (req, res) => {
  await db.setPaused(false, '');
  res.json({ ok: true, message: 'Envío reanudado.' });
});

app.post('/send', requireAuth, async (req, res) => {
  const { to, subject, html, text, fromName, fromEmail, replyTo, priority, preheader, contact, validateMx } = req.body;

  if (!to || !subject || !fromEmail) {
    return res.status(400).json({ ok: false, error: 'Faltan campos: to, subject, fromEmail.' });
  }

  const asCheck = await checkAntiStrike();
  if (!asCheck.ok) return res.status(429).json({ ok: false, paused: true, reason: asCheck.reason });

  if (validateMx) {
    const mxOk = await hasMxRecord(to);
    if (!mxOk) {
      await db.incrementBounce();
      await db.logEvent({ type: 'bounce', email: to, errorMsg: 'Sin registro MX' });
      return res.status(400).json({ ok: false, error: 'Sin registro MX — dominio inválido.', bounce: true });
    }
  }

  try {
    const mailOptions = buildEmail({ to, subject, html, text, fromName, fromEmail, replyTo, priority, preheader, contact });
    const result = await sendSingle(mailOptions);
    res.json(result);
  } catch (err) {
    console.error('[Send Error]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-bulk', requireAuth, async (req, res) => {
  const {
    contacts, subject, html, text, fromName, fromEmail, replyTo,
    priority, preheader, delayMs = 1500, humanize = true,
    validateMx = true, batchSize = 50, batchPauseMs = 60000,
  } = req.body;

  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ ok: false, error: 'contacts debe ser un array no vacío.' });
  }

  const maxPerReq = parseInt(process.env.MAX_EMAILS_PER_REQUEST) || 500;
  if (contacts.length > maxPerReq) {
    return res.status(400).json({ ok: false, error: `Máximo ${maxPerReq} contactos por request.` });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  res.json({ ok: true, jobId, message: `Job ${jobId} iniciado. ${contacts.length} emails en cola.` });

  (async () => {
    let sent = 0, bounced = 0, skipped = 0;
    console.log(`[Job ${jobId}] Iniciando envío a ${contacts.length} contactos`);

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      const to = contact.email;
      if (!to) { skipped++; continue; }

      // Lee el estado REAL desde la DB en cada iteración — sobrevive a reinicios
      const asCheck = await checkAntiStrike();
      if (!asCheck.ok) {
        console.warn(`[Job ${jobId}] Anti-strike PAUSA: ${asCheck.reason}`);
        break;
      }

      if (validateMx) {
        const mxOk = await hasMxRecord(to);
        if (!mxOk) {
          bounced++;
          await db.incrementBounce();
          await db.logEvent({ type: 'bounce', email: to, errorMsg: 'Sin registro MX' });
          continue;
        }
      }

      try {
        const mailOptions = buildEmail({ to, subject, html, text, fromName, fromEmail, replyTo, priority, preheader, contact });
        const result = await sendSingle(mailOptions);
        if (result.ok) sent++; else bounced++;
      } catch (err) {
        bounced++;
        console.error(`[Job ${jobId}] Error ${to}: ${err.message}`);
      }

      const actualDelay = humanize ? delayMs * (0.7 + Math.random() * 0.6) : delayMs;
      await sleep(actualDelay);

      if (batchSize && (i + 1) % batchSize === 0 && i < contacts.length - 1) {
        console.log(`[Job ${jobId}] Lote completo. Pausa ${batchPauseMs / 1000}s...`);
        await sleep(batchPauseMs);
      }
    }

    console.log(`[Job ${jobId}] Finalizado: ${sent} enviados, ${bounced} bounces, ${skipped} saltados.`);
  })();
});

app.post('/webhook/complaint', async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const e of events) {
    if (e.event === 'spam' || e.event === 'complaint') {
      await db.incrementComplaint();
      await db.logEvent({ type: 'complaint', email: e.email });
      console.warn(`[Anti-Strike] Spam complaint de ${e.email}`);
    }
    if (e.event === 'hard_bounce') {
      await db.incrementBounce();
      await db.logEvent({ type: 'bounce', email: e.email, errorMsg: 'Webhook hard_bounce' });
    }
  }
  res.json({ ok: true });
});

// ============================================================
// UTILS
// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// START — inicializa la DB ANTES de aceptar tráfico
// ============================================================
(async () => {
  try {
    const dbOk = await db.checkDbConnection();
    if (!dbOk) {
      console.error(`
⚠️  ADVERTENCIA: No se pudo conectar a PostgreSQL.
    Verifica que agregaste el plugin "PostgreSQL" en Railway
    y que DATABASE_URL está disponible como variable de entorno.
    El backend funcionará pero el Anti-Strike NO será persistente.
      `);
    } else {
      await db.initDb();
    }
  } catch (err) {
    console.error('[DB Init Error]', err.message);
  }

  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║   InboxPro Backend v2.1 — ONLINE       ║
║   Puerto: ${PORT}                          ║
║   SMTP: ${smtpConfigs.length} cuenta(s) configurada(s)      ║
║   Anti-Strike: PERSISTENTE (PostgreSQL) ║
╚════════════════════════════════════════╝
    `);
  });
})();
