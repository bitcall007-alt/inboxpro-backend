# InboxPro Backend v2.3

InboxPro is a small email campaign interface with a Node.js API, PostgreSQL persistence, and a single-user login.

## Free deployment

- Frontend: GitHub Pages from this repository.
- Backend: Render Free web service. Free instances sleep after 15 minutes without traffic and can take about a minute to wake.
- Database: Neon Free PostgreSQL. The free plan has a monthly compute allowance and storage cap; the database can scale to zero.
- Email: Brevo Free API, up to 300 sends per day. Render Free blocks SMTP ports, so configure `BREVO_API_KEY` to send mail from Render.

These free plans have usage limits and do not provide production uptime guarantees. Do not add a payment method if you need to prevent accidental charges; services may pause at their free limits.

## Deploy the backend

1. Create a free Render Web Service from `bitcall007-alt/inboxpro-backend`, using the `main` branch. Build command: `npm install`. Start command: `npm start`. Select the Free instance type.
2. Create a free PostgreSQL project on Neon and copy its connection string into Render as `DATABASE_URL`.
3. Add these variables in the Render service settings. Never commit their values to GitHub:

   - `APP_USERNAME=malik`
   - `APP_PASSWORD`: set a private password in Render's environment settings.
   - `SESSION_SECRET`: set a long random secret.
   - `DATABASE_URL`: Neon connection string.
   - `BREVO_API_KEY`: Brevo API key.
   - `ALLOWED_ORIGINS=https://bitcall007-alt.github.io`
   - `MAX_DAILY_EMAILS=300`
   - `API_SECRET`: only needed if using the complaint webhook.

4. Deploy. The backend only starts when PostgreSQL is connected and initializes its tables automatically.
5. Open the GitHub Pages frontend, enter the Render service URL and sign in. The app keeps the backend URL in local storage; the session token stays in memory and expires after 12 hours.

## Security and persistence

The login endpoint is rate limited. Protected API routes require a signed, expiring session token. The app password, session signing key, Brevo key, and database connection string belong only in the hosting provider's environment settings. The complaint webhook uses `API_SECRET` when enabled.

Anti-strike counters are persisted in PostgreSQL. Lifetime bounces are tracked separately from the daily count so the bounce-rate calculation does not reset each day. If PostgreSQL is missing or unavailable during startup, the backend exits rather than accepting sends without persistence.
