// server.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { KiteConnect, KiteTicker } from 'kiteconnect';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const KITE_API_KEY = process.env.KITE_API_KEY || '';
const KITE_API_SECRET = process.env.KITE_API_SECRET || '';
let   KITE_ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

if (!KITE_API_KEY || !KITE_API_SECRET) {
  console.warn('⚠️  Missing KITE_API_KEY or KITE_API_SECRET in environment.');
}

const NIFTY100 = (process.env.NIFTY100 || 'HAL,INFY,TCS')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// in-memory state
let instrumentBySymbol = new Map(); // tradingsymbol -> instrument_token
let tokenToSymbol = new Map();      // instrument_token -> tradingsymbol
let priceBySymbol = new Map();      // tradingsymbol -> { price, ts }
let ticker = null;

// express app
const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---- routes
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ws_connected: !!ticker?._ws?.connected,
    tracked: NIFTY100.length,
    quotes: priceBySymbol.size,
    app: 'nifty100-live-app',
    api_key_loaded: !!KITE_API_KEY,
    token_loaded: !!KITE_ACCESS_TOKEN
  });
});

app.get('/api/quotes', (req, res) => {
  const tickers = String(req.query.tickers || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const out = {};
  for (const t of tickers) {
    const q = priceBySymbol.get(t);
    if (q) out[t] = q.price;
  }
  res.json(out);
});

// Admin: set access token without redeploy (protect with ADMIN_PASS)
app.post('/admin/set-access-token', async (req, res) => {
  try {
    const pass = req.query.pass || req.headers['x-admin-pass'];
    if (!ADMIN_PASS || pass !== ADMIN_PASS) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }
    const { access_token } = req.body || {};
    if (!access_token) return res.status(400).json({ ok:false, error:'missing access_token' });

    KITE_ACCESS_TOKEN = access_token;
    process.env.KITE_ACCESS_TOKEN = access_token;
    await startTicker();
    res.json({ ok:true, message:'Access token set; ticker (re)started' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Zerodha OAuth callback: exchange request_token -> access_token (optional; when Redirect URL points here)
app.get('/auth/zerodha/callback', async (req, res) => {
  try {
    const { request_token } = req.query;
    if (!request_token) return res.status(400).send('Missing request_token');
    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    // v4 SDK computes checksum internally when you pass api_secret
    const session = await kite.generateSession(request_token, KITE_API_SECRET);
    KITE_ACCESS_TOKEN = session.access_token;
    process.env.KITE_ACCESS_TOKEN = session.access_token;
    console.log('✅ Access token acquired:', session.access_token.slice(0,6) + '…');
    await startTicker();
    res.send('✅ Zerodha token captured. You can close this window.');
  } catch (err) {
    console.error('Callback error', err);
    res.status(500).send('Callback failed — check server logs for details.');
  }
});

// ---- helpers
async function loadInstruments() {
  const kite = new KiteConnect({ api_key: KITE_API_KEY });
  if (KITE_ACCESS_TOKEN) kite.setAccessToken(KITE_ACCESS_TOKEN);
  const all = await kite.getInstruments('NSE');
  const wanted = new Set(NIFTY100);
  instrumentBySymbol = new Map();
  tokenToSymbol = new Map();
  for (const row of all) {
    if (wanted.has(row.tradingsymbol)) {
      instrumentBySymbol.set(row.tradingsymbol, row.instrument_token);
      tokenToSymbol.set(row.instrument_token, row.tradingsymbol);
    }
  }
  console.log(`✅ Instruments loaded for ${instrumentBySymbol.size} symbols`);
}

async function startTicker() {
  if (!KITE_ACCESS_TOKEN) {
    console.log('🟡 No access token yet; ticker not started.');
    return;
  }
  await loadInstruments();
  const tokens = Array.from(instrumentBySymbol.values());
  if (!tokens.length) {
    console.warn('⚠️  No instrument tokens to subscribe.');
    return;
  }
  if (ticker && ticker._ws) {
    try { ticker.disconnect(); } catch {}
  }
  ticker = new KiteTicker({ api_key: KITE_API_KEY, access_token: KITE_ACCESS_TOKEN });
  ticker.on('connect', () => {
    console.log('✅ Ticker connected');
    // subscribe in small chunks
    const chunk = 20;
    for (let i = 0; i < tokens.length; i += chunk) {
      const part = tokens.slice(i, i + chunk);
      ticker.subscribe(part);
      ticker.setMode(ticker.modeLTP, part);
    }
  });
  ticker.on('ticks', (ticks) => {
    for (const t of ticks) {
      const sym = tokenToSymbol.get(t.instrument_token);
      if (!sym) continue;
      const price = t.last_price ?? t.ltp ?? t.close ?? 0;
      if (price) priceBySymbol.set(sym, { price, ts: Date.now() });
    }
  });
  ticker.on('error', e => console.error('Ticker error', e));
  ticker.on('close', () => console.warn('Ticker closed'));
  ticker.on('noreconnect', () => console.warn('Ticker gave up reconnecting'));
  ticker.connect();
}

// ---- boot
app.listen(PORT, async () => {
  console.log('🚀 Server listening on', PORT);
  console.log('Visit the login URL to generate access token:');
  console.log(`https://kite.zerodha.com/connect/login?api_key=${KITE_API_KEY}&v=3`);
  if (KITE_ACCESS_TOKEN) {
    try { await startTicker(); } catch (e) { console.error('Failed to start ticker at boot:', e); }
  }
});
