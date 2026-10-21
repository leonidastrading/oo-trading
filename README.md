# OO Trading — private, read-only trading dashboard

Next.js (App Router, TypeScript) + Tailwind + Recharts, deployed on Vercel, with Upstash Redis (Vercel KV) for tokens, cache and data.

- **Live** — open P/L, closed P/L (net of fees), SPX, fees today; positions grouped into spreads by expiration; **Best SPX close** panel (P/L at 4:00 PM settlement for today's expirations only) with expiry chart, breakevens, worst case and a ±50-pt table. Positions not expiring today are listed separately with mark P/L.
- **Today** — open P/L, closed (realized) P/L from Schwab fills (FIFO, net of fees, 10-day lookback for cost basis), total, account day P/L, closed orders and fills.
- **Stats** — from Option Omega trade-log CSVs: per-strategy stats, stop-loss vs. expiration breakdown, daily P/L table + CSV download, calendar heatmap, equity curve, drawdown, best/worst 10 days, and end-of-day Schwab snapshots.
- **Settings** — Schwab connection status/reconnect (refresh-token countdown), CSV upload, manual EOD snapshot, data reset.

## Security model

- **Everything requires login** (`src/proxy.ts`). Only `/login`, `/api/auth/*` (NextAuth) and `/api/cron/*` (checks `CRON_SECRET`) skip the session check. The Schwab OAuth callback also requires your session *and* a one-time `state` value.
- **Single allowed account**: `ALLOWED_EMAIL`, enforced at sign-in and on every request.
- **Read-only Schwab**: `src/lib/schwab/readonly.ts` allows only `GET` on account numbers, account/positions/balances, transactions and quotes. There is no order code; a unit test asserts order paths are blocked.
- Secrets live only in Vercel env vars; tokens live only in Redis. The full account number is never sent to the browser.
- `noindex`, `X-Frame-Options: DENY`, HSTS and other headers are set in `next.config.ts`.

## Setup

### 1. Schwab developer app
1. Sign in at <https://developer.schwab.com>, then go to **Dashboard → Apps → Create App**.
2. API products: **Accounts and Trading Production** and **Market Data Production**.
3. **Callback URL**: `https://<your-app>.vercel.app/api/schwab/callback`. It must match `SCHWAB_REDIRECT_URI` exactly (https, no trailing slash). Add `https://127.0.0.1:3000/api/schwab/callback` as well if you want to test locally (Schwab requires https).
4. Wait until the app status is **Ready For Use** (this can take a few days). Copy the **App Key** (`SCHWAB_CLIENT_ID`) and **Secret** (`SCHWAB_CLIENT_SECRET`).

> Schwab refresh tokens expire **7 days** after you log in. The dashboard warns you when fewer than 2 days are left (banner on every page). Click **Reconnect Schwab** in Settings to log in again. Access tokens (30 min) refresh automatically.

### 2. Login method (any combination)
- **Password** (simplest): set `DASHBOARD_PASSWORD` to a long random string and sign in with `ALLOWED_EMAIL` + that password. Failed attempts are rate-limited (5 per 15 min). Change it any time in **Settings → Change password**: the new password is stored as a scrypt hash in Redis (overriding `DASHBOARD_PASSWORD`) and every existing session is signed out.
- **GitHub**: Settings → Developer settings → OAuth Apps → New. Homepage `https://<your-app>.vercel.app`, callback `https://<your-app>.vercel.app/api/auth/callback/github`. Set `GITHUB_ID` and `GITHUB_SECRET`. Your GitHub primary email must equal `ALLOWED_EMAIL`.
- **Google**: Google Cloud Console → Credentials → OAuth client (Web). Redirect URI `https://<your-app>.vercel.app/api/auth/callback/google`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### 3. Vercel project + KV
1. Import this repo in Vercel (framework: Next.js).
2. **Storage → Create → Upstash for Redis** (the "KV" option in the Marketplace), then connect it to the project. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`. (`UPSTASH_REDIS_REST_URL`/`_TOKEN` also work.)
3. Add the env vars from `.env.example` (Production, plus Preview if you use it): `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `ALLOWED_EMAIL`, provider keys, `SCHWAB_*`, `CRON_SECRET`.
4. Redeploy.

### 4. First login
1. Open the site and sign in with the allowed account.
2. Go to **Settings → Connect Schwab**, log in at Schwab, and select the account ending **9061**. You're returned to Settings with "Schwab connected".
3. Upload your OO trade-log CSVs under **Settings → Upload**. Re-uploading is safe because duplicates are skipped.

### Local development
```bash
npm install
cp .env.example .env.local   # fill in values; without KV vars an in-memory store is used
npm run dev
npm test                     # vitest: CSV parser, spread grouping, payoff math, realized P/L, read-only guard
```
`SCHWAB_MOCK=1` in `.env.local` serves a fake book (today's example SPX positions) so the UI can be previewed without Schwab. It is ignored on Vercel.

## Data refresh rules

All Schwab calls go through server routes (`/api/live`, `/api/today`) backed by a **shared Redis cache with a cross-instance lock**. Any number of tabs or phones share one set of Schwab calls, and the browser never calls Schwab directly.

| Window (ET, trading days) | Positions + marks + balances + SPX | Transactions | Browser polling |
|---|---|---|---|
| 09:30–15:30 | 15 s | 60 s | every 15 s while the tab is visible |
| 15:30–16:15 | 10 s | 60 s | every 10 s |
| Closed / weekends / holidays | last snapshot | last snapshot | none; manual Refresh (≥30 s apart, enforced server-side) |

- Balances come back in the same Schwab account call as positions, so they refresh with positions at no extra API cost.
- At most about 13 Schwab requests per minute in the final window, well under the **global limiter of 60/min** (Redis counter).
- 5xx and network errors are retried with exponential backoff. 429 and repeated 5xx put the app in a shared backoff (2ˢ s, max 2 min, honors `Retry-After`) while the last good data is shown with an error banner.
- A **"data delayed"** banner appears when data is older than 2× the refresh interval during market hours.
- "Last updated HH:MM:SS ET" is shown on every page.
- NYSE holidays and 1 PM early closes are listed in `src/lib/time.ts` for 2025–2027. Extend the list when needed.

### End-of-day snapshot (Vercel Cron)
`vercel.json` schedules `/api/cron/eod` at 20:30 and 21:30 UTC on weekdays, which covers 16:30 ET in both EDT and EST. The handler runs once per trading day inside 16:15–18:00 ET and saves net liq, day P/L, realized/open P/L and per-position P/L to Redis. On the Hobby plan, cron timing is only accurate to the hour, so the window is deliberately wide. You can also save a snapshot from Settings.

## How the numbers are computed

- **Expiry P/L** (`src/lib/options.ts`): Σ qty × 100 × intrinsic(S) − net cost, where intrinsic is `max(S−K,0)` for calls and `max(K−S,0)` for puts, and net cost is Σ qty × Schwab average price × 100. It is evaluated from SPX −3% to +3% in 1-pt steps. A flat maximum (e.g. an iron condor) is shown as a range. Breakevens are linearly interpolated zero crossings, and the profit zone is the pair that brackets the best close.
- Schwab nets identical contracts, so two BWBs on the same strikes appear as one leg with a blended average price. The expiry curve is the same either way.
- **Fees**: `FEE_PER_CONTRACT` (default $0.88) × contracts per side for every option fill; expirations are free. The Live page shows today's total.
- **Realized P/L today**: FIFO match of closing fills against opening fills from the last 10 days, net of the fees above. Closes whose opening fill is older than the window are flagged and excluded.
- **OO stats**: win = P/L > 0, loser = P/L < 0. A day's P/L is assigned to its *Date Closed* (falling back to Date Opened). Avg P/L per lot = total P/L ÷ total contracts. Loser close reasons are classified as Stop Loss (contains "stop"), Expired (contains "expir") or Other. De-duplication key: strategy + date opened + time opened + legs.

## Project layout
```
src/
  proxy.ts                  auth gate for every route
  app/
    page.tsx                Live
    today/ stats/ settings/ login/
    api/
      auth/[...nextauth]/   NextAuth
      schwab/authorize|callback|status
      live/ today/          cached Schwab views
      oo/upload|trades      OO CSV storage
      snapshots/ cron/eod/  EOD snapshots
      reset/                data reset
  components/               UI (charts, panels, tables, polling hook)
  lib/
    options.ts              payoff math + best-close analysis
    spreads.ts              Schwab positions → spreads
    realized.ts             transactions → fills → FIFO realized P/L
    ooCsv.ts  stats.ts      OO CSV parsing + statistics
    time.ts                 ET, market hours, holidays, refresh policy
    kv.ts  cache.ts         Redis store, shared cache + locks
    schwab/                 tokens (OAuth), client (rate limit/backoff), read-only guard, data, mock
test/                       vitest unit tests
```
