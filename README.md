# InboxPro Backend v2.1 — FIX: Anti-Strike Persistente

## ⚠️ Qué se arregló respecto a v2.0

**Bug crítico anterior:** el contador de bounces, spam complaints y envíos
diarios vivía en una variable de JavaScript en memoria (`antiStrike = {...}`).
Cada vez que Railway reiniciaba el contenedor (deploy, sleep por inactividad,
crash, mantenimiento), ese contador volvía a cero — el sistema "olvidaba"
que estaba cerca del límite de bounce rate y seguía enviando, arriesgando
un bloqueo permanente en Brevo.

**Solución:** todo el estado anti-strike ahora vive en **PostgreSQL**
(plugin gratuito de Railway). Sobrevive a cualquier reinicio.

## Qué cambia para ti al desplegar

1. En Railway, antes de configurar las variables de entorno, agrega
   el plugin de base de datos:
   - En tu proyecto Railway → clic en **"New"** → **"Database"** → **"Add PostgreSQL"**
   - Railway crea la base de datos e inyecta automáticamente la variable
     `DATABASE_URL` en tu servicio backend. **No la escribas a mano.**

2. El resto del proceso es idéntico al manual que ya tienes (Parte 3).

3. Al iniciar, el backend crea automáticamente las tablas necesarias
   (`anti_strike_state` y `send_history`) — no hay pasos manuales de SQL.

## Verificar que la persistencia funciona

Abre la URL de tu backend en el navegador. Si ves:

```json
"database": "conectada ✓ (estado persistente)"
```

la persistencia está activa. Si ves `"DESCONECTADA ⚠️"`, falta el plugin
PostgreSQL en Railway.

## Nuevas rutas

- `GET /history` — últimos 100 eventos (envíos, bounces, complaints) con timestamp,
  útil para auditar qué pasó incluso después de reinicios.
