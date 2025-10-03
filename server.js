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

const PORT = process.env.PORT || 8080;
const APP_BASE_URL = process.env.APP_BASE_URL || ('http://localhost:' + PORT);
const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;
let KITE_ACCESS_TOKEN = process.env.KITE_ACCESS_TOKEN || '';

if (!KITE_API_KEY || !KITE_API_SECRET) {
  console.error('❌ Missing KITE_API_KEY or KITE_API_SECRET env vars');
}

const NIFTY100 = (process.env.NIFTY100 || 'HAL,INFY,TCS,RELIANCE,ITC,HDFCBANK,ICICIBANK,SBIN,LT,BAJFINANCE')
  .split(',').map(s => s.trim()).filter(Boolean);

let instrumentBySymbol = new Map(); // tradingsymbol -> instrument_token
let ltpMap = new Map(); // tradingsymbol -> { price, ts }

const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ws_connected: !!ticker?._ws?.connected,
    tracked: NIFTY100.length,
    quotes: ltpMap.size,
    app: 'nifty100-live-app'
  });
});

app.get('/auth/zerodha/callback', async (req, res) => {
  try {
    const { request_token } = req.query;
    if (!request_token) return res.status(400).send('Missing request_token');

    // IMPORTANT: pass api_secret; SDK computes checksum internally
    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    const session = await kite.generateSession(request_token, KITE_API_SECRET);

    KITE_ACCESS_TOKEN = session.access_token;
    process.env.KITE_ACCESS_TOKEN = KITE_ACCESS_TOKEN;

    await startTicker();
    res.send('✅ Zerodha token captured. You can close this window.');
  } catch (err) {
    console.error('Callback error', err);
    res.status(500).send('Callback failed — check Render logs for details.');
  }
});

app.get('/api/quotes', (req, res) => {
  const tickers = String(req.query.tickers || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = {};
  for (const t of tickers) {
    const q = ltpMap.get(t);
    if (q) out[t] = q.price;
  }
  res.json(out);
});

let ticker = null;

async function hydrateInstrumentMap() {
  try {
    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    if (KITE_ACCESS_TOKEN) kite.setAccessToken(KITE_ACCESS_TOKEN);
    const all = await kite.getInstruments('NSE');
    instrumentBySymbol = new Map();
    for (const r of all) {
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
  if (ticker && ticker._ws) { try { ticker.disconnect(); } catch {} }

  ticker = new KiteTicker({ api_key: KITE_API_KEY, access_token: KITE_ACCESS_TOKEN });

  ticker.on('connect', () => {
    console.log('✅ Ticker connected');
    const chunkSize = 20;
    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);
      ticker.subscribe(chunk);
      ticker.setMode(ticker.modeLTP, chunk);
    }
  });

  ticker.on('ticks', (ticks) => {
    for (const t of ticks) {
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

app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  if (KITE_ACCESS_TOKEN) {
    await startTicker();
  } else {
    console.log('Visit the login URL to generate access token:');
    console.log(`https://kite.trade/connect/login?api_key=${KITE_API_KEY}&v=3`);
  }
});
