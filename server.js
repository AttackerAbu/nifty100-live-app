# =============================
# File: package.json
# =============================
{
  "name": "nifty100-live-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "NODE_ENV=development node server.js"
  },
  "dependencies": {
    "cookie-parser": "^1.4.6",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "helmet": "^7.0.0",
    "kiteconnect": "^4.0.0",
    "morgan": "^1.10.0"
  }
}

# =============================
# File: .env.example  (copy to .env on Hostinger hPanel)
# =============================
# Base
PORT=8080
APP_BASE_URL=https://bot.cabcompare.in

# Zerodha
KITE_API_KEY=replace_me
KITE_API_SECRET=replace_me
# This is rotated daily after login. The callback will overwrite it.
KITE_ACCESS_TOKEN=

# Universe (comma separated symbols as used by Zerodha for NSE)
NIFTY100=HAL,INFY,TCS,RELIANCE,ITC,HDFCBANK,ICICIBANK,SBIN,LT,BAJFINANCE,AXISBANK,ASIANPAINT,KOTAKBANK,HCLTECH,WIPRO,ULTRACEMCO,ADANIENT,ADANIGREEN,ADANIPORTS,ADANIPOWER,POWERGRID,NTPC,ONGC,COALINDIA,JSWSTEEL,TATASTEEL,HINDALCO,CIPLA,DRREDDY,SUNPHARMA,BAJAJFINSV,LTIM,TITAN,HEROMOTOCO,EICHERMOT,BAJAJ-AUTO,TVSMOTOR,BRITANNIA,DMART,SBILIFE,ICICIPRULI,HDFCLIFE,PIDILITIND,GRASIM,INDUSINDBK,TATACONSUM,HAL,BHARATIARTL,MARUTI,M&M,SHREECEM,NESTLEIND,TECHM,DIVISLAB,DLF,COFORGE,ABB,ABBOTINDIA,BPCL,IOC,PEL,SRF,BERGEPAINT,BEL,SIEMENS,INDIGO,PNB,IDFCFIRSTB,BANDHANBNK,UBL,DABUR,GLAND,AUROPHARMA,ALKEM,APOLLOHOSP,ICICIGI,BAJAJHLDNG,LODHA,CONCOR,IDEA,HALDYNGLAS,TORNTPOWER,TORNTPHARM,MPHASIS,NAUKRI,LAURUSLABS,LTTS,TATAMOTORS,DLF,AMBUJACEM,ACC,GUJGAS,INDHOTEL,IRCTC,IRFC,IOB,IDBI,SAIL,COALINDIA

# NOTE: You can adjust the list above to the exact NIFTY 100 you want.

# =============================
# File: server.js
# =============================
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { KiteConnect, KiteTicker } from 'kiteconnect';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config
const PORT = process.env.PORT || 8080;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:' + PORT;
const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;
let KITE_ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN || '';

if (!KITE_API_KEY || !KITE_API_SECRET) {
  console.error('❌ Missing KITE_API_KEY or KITE_API_SECRET env vars');
}

// Universe
const NIFTY100 = (process.env.NIFTY100 || '').split(',').map(s => s.trim()).filter(Boolean);

// Maps
let instrumentBySymbol = new Map(); // tradingSymbol -> instrument_token
let ltpMap = new Map(); // tradingSymbol -> { price, ts }

// Express
const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static React build if you place it under /public
app.use(express.static(path.join(__dirname, 'public')));

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ws_connected: !!ticker?._ws?.connected,
    tracked: NIFTY100.length,
    quotes: ltpMap.size,
    app: 'nifty100-live-app'
  });
});

// Zerodha OAuth callback
app.get('/auth/zerodha/callback', async (req, res) => {
  try {
    const { request_token, status } = req.query;
    if (!request_token) return res.status(400).send('Missing request_token');

    const checksum = crypto
      .createHash('sha256')
      .update(`${KITE_API_KEY}${request_token}${KITE_API_SECRET}`)
      .digest('hex');

    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    // NOTE: Kite SDK v4 expects (request_token, api_secret) and computes checksum internally
      const session = await kite.generateSession(request_token, KITE_API_SECRET);

    KITE_ACCESS_TOKEN = session.access_token;
    process.env.KITE_ACCESS_TOKEN = KITE_ACCESS_TOKEN; // keep in-memory

    // Start ticker with the new token
    await startTicker();

    res.send('✅ Zerodha token captured. You can close this window.');
  } catch (err) {
    console.error('Callback error', err);
    res.status(500).send('Callback failed — check Render logs for details.');
  }
});

// Quotes endpoint — accepts comma separated tickers
app.get('/api/quotes', (req, res) => {
  const tickers = String(req.query.tickers || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = {};
  for (const t of tickers) {
    const q = ltpMap.get(t);
    if (q) out[t] = q.price;
  }
  res.json(out);
});

// ---- Zerodha wiring
let ticker = null; // KiteTicker instance

async function hydrateInstrumentMap() {
  try {
    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    if (KITE_ACCESS_TOKEN) kite.setAccessToken(KITE_ACCESS_TOKEN);
    const all = await kite.getInstruments('NSE');
    instrumentBySymbol = new Map();
    for (const r of all) {
      // r.tradingsymbol like "INFY"; use only those in our universe
      if (NIFTY100.includes(r.tradingsymbol)) {
        instrumentBySymbol.set(r.tradingsymbol, r.instrument_token);
      }
    }
    console.log(`✅ Instruments loaded for ${instrumentBySymbol.size} symbols`);
  } catch (e) {
    console.error('Failed to load instruments', e.message);
  }
}

async function startTicker() {
  if (!KITE_ACCESS_TOKEN) {
    console.log('🟡 No access token yet; ticker not started');
    return;
  }
  await hydrateInstrumentMap();
  const tokens = Array.from(instrumentBySymbol.values());
  if (!tokens.length) {
    console.warn('⚠️ No instrument tokens to subscribe');
    return;
  }
  // Close existing
  if (ticker && ticker._ws) try { ticker.disconnect(); } catch {}

  ticker = new KiteTicker({ api_key: KITE_API_KEY, access_token: KITE_ACCESS_TOKEN });

  ticker.on('connect', () => {
    console.log('✅ Ticker connected');
    // Subscribe to all tokens in small chunks to avoid limits
    const chunkSize = 20;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);
      ticker.subscribe(chunk);
      ticker.setMode(ticker.modeLTP, chunk);
    }
  });

  ticker.on('ticks', (ticks) => {
    for (const t of ticks) {
      // map back: instrument_token -> symbol
      const sym = [...instrumentBySymbol.entries()].find(([, tok]) => tok === t.instrument_token)?.[0];
      if (!sym) continue;
      const price = t.last_price || t.ltp || t.close || 0;
      if (price) ltpMap.set(sym, { price, ts: Date.now() });
    }
  });

  ticker.on('error', (e) => console.error('Ticker error', e));
  ticker.on('close', () => console.warn('Ticker closed'));
  ticker.on('noreconnect', () => console.warn('Ticker gave up reconnecting'));

  ticker.connect();
}

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  if (KITE_ACCESS_TOKEN) {
    await startTicker();
  } else {
    console.log('Visit the login URL to generate access token:');
    console.log(`https://kite.trade/connect/login?api_key=${KITE_API_KEY}&v=3`);
  }
});

# =============================
# File: public/index.html  (optional: quick front page)
# =============================
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NIFTY100 Live</title>
    <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;max-width:900px;margin:40px auto;padding:0 16px}</style>
  </head>
  <body>
    <h1>NIFTY100 Live</h1>
    <p>Backend is running. Try the health & quotes endpoints:</p>
    <ul>
      <li><a href="/api/health">/api/health</a></li>
      <li><a href="/api/quotes?tickers=HAL,INFY,TCS">/api/quotes?tickers=HAL,INFY,TCS</a></li>
    </ul>
    <p>To generate an access token, open:<br>
      <code id="login"></code>
    </p>
    <script>
      fetch('/api/health').then(()=>{
        document.getElementById('login').textContent = 'https://kite.trade/connect/login?api_key=' + (new URLSearchParams(location.search).get('k')||'YOUR_API_KEY') + '&v=3'
      });
    </script>
  </body>
</html>
