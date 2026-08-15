// ============================================================
// db.js — Persistencia del estado Anti-Strike en PostgreSQL
// Soluciona el bug crítico: el contador en RAM se borraba
// cada vez que Railway reiniciaba el contenedor.
// ============================================================

const { Pool } = require('pg');

// Railway inyecta DATABASE_URL automáticamente al añadir el plugin Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

// ============================================================
// INIT — crea las tablas si no existen (corre una vez al boot)
// ============================================================
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anti_strike_state (
      id            INT PRIMARY KEY DEFAULT 1,
      sent_today    INT NOT NULL DEFAULT 0,
      bounce_count  INT NOT NULL DEFAULT 0,
      total_sent    INT NOT NULL DEFAULT 0,
      spam_complaints INT NOT NULL DEFAULT 0,
      last_reset    DATE NOT NULL DEFAULT CURRENT_DATE,
      paused        BOOLEAN NOT NULL DEFAULT FALSE,
      pause_reason  TEXT DEFAULT '',
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS send_history (
      id          BIGSERIAL PRIMARY KEY,
      type        TEXT NOT NULL,         -- 'sent' | 'bounce' | 'complaint'
      email       TEXT,
      message_id  TEXT,
      error_code  INT,
      error_msg   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_history_created ON send_history (created_at DESC);`);

  // Garantiza que exista la fila única de estado (upsert idempotente)
  await pool.query(`
    INSERT INTO anti_strike_state (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log('[DB] Tablas verificadas/creadas. Estado persistente listo.');
}

// ============================================================
// GET STATE — lee el estado actual, reseteando contadores diarios
// si la fecha guardada es anterior a hoy
// ============================================================
async function getState() {
  const { rows } = await pool.query(`SELECT * FROM anti_strike_state WHERE id = 1;`);
  let state = rows[0];

  const today = new Date().toISOString().slice(0, 10);
  const lastReset = state.last_reset.toISOString().slice(0, 10);

  if (lastReset !== today) {
    // Nuevo día → reinicia sentToday y bounceCount, pero NO total_sent (histórico permanece)
    await pool.query(`
      UPDATE anti_strike_state
      SET sent_today = 0, bounce_count = 0, last_reset = CURRENT_DATE,
          paused = FALSE, pause_reason = '', updated_at = NOW()
      WHERE id = 1;
    `);
    const { rows: rows2 } = await pool.query(`SELECT * FROM anti_strike_state WHERE id = 1;`);
    state = rows2[0];
    console.log('[DB] Nuevo día detectado. Contadores diarios reiniciados.');
  }

  return {
    sentToday: state.sent_today,
    bounceCount: state.bounce_count,
    totalSent: state.total_sent,
    spamComplaints: state.spam_complaints,
    paused: state.paused,
    pauseReason: state.pause_reason || '',
  };
}

// ============================================================
// INCREMENT — operaciones atómicas (evitan race conditions
// durante envíos masivos concurrentes)
// ============================================================
async function incrementSent() {
  await pool.query(`
    UPDATE anti_strike_state
    SET sent_today = sent_today + 1, total_sent = total_sent + 1, updated_at = NOW()
    WHERE id = 1;
  `);
}

async function incrementBounce() {
  await pool.query(`
    UPDATE anti_strike_state
    SET bounce_count = bounce_count + 1, total_sent = total_sent + 1, updated_at = NOW()
    WHERE id = 1;
  `);
}

async function incrementComplaint() {
  await pool.query(`
    UPDATE anti_strike_state
    SET spam_complaints = spam_complaints + 1, updated_at = NOW()
    WHERE id = 1;
  `);
}

async function setPaused(paused, reason = '') {
  await pool.query(`
    UPDATE anti_strike_state
    SET paused = $1, pause_reason = $2, updated_at = NOW()
    WHERE id = 1;
  `, [paused, reason]);
}

// ============================================================
// HISTORY LOG — auditoría persistente de cada evento
// ============================================================
async function logEvent({ type, email, messageId, errorCode, errorMsg }) {
  await pool.query(`
    INSERT INTO send_history (type, email, message_id, error_code, error_msg)
    VALUES ($1, $2, $3, $4, $5);
  `, [type, email || null, messageId || null, errorCode || null, errorMsg || null]);
}

async function getRecentHistory(limit = 100) {
  const { rows } = await pool.query(`
    SELECT type, email, message_id, error_code, error_msg, created_at
    FROM send_history ORDER BY created_at DESC LIMIT $1;
  `, [limit]);
  return rows;
}

// ============================================================
// HEALTH CHECK
// ============================================================
async function checkDbConnection() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('[DB] Conexión fallida:', err.message);
    return false;
  }
}

module.exports = {
  pool,
  initDb,
  getState,
  incrementSent,
  incrementBounce,
  incrementComplaint,
  setPaused,
  logEvent,
  getRecentHistory,
  checkDbConnection,
};
