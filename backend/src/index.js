import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { router } from './routes/index.js';
import { getDb } from './db/index.js';
import { startPoller } from './poller/poll.js';
import { limiterConfig } from './adapters/jupiter/client.js';
import { refreshAssets } from './services/assets.js';

const app = express();
const PORT = Number(process.env.PORT || 8787);

function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const CORS_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:5174',
  'https://noisy-sky-fa9c.rj838486.workers.dev',
  ...parseOrigins(process.env.CORS_ORIGIN),
]);

app.use(cors({
  origin(origin, callback) {
    const normalized = origin ? origin.replace(/\/$/, '') : '';
    // Reflect ONE origin. A comma-separated Access-Control-Allow-Origin
    // header is invalid and browsers treat it as a CORS failure.
    if (!origin || CORS_ORIGINS.has(normalized)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
}));
app.use(express.json({ limit: '2mb' }));

app.use((req, _res, next) => {
  if (process.env.LOG_REQUESTS !== 'false') console.log(`${req.method} ${req.originalUrl}`);
  next();
});

app.use('/api', router);

app.get('/', (_req, res) => {
  res.json({
    name: 'Overflow API',
    tagline: 'Keep the source. Program the earnings.',
    endpoints: ['/api/health', '/api/assets/destinations', '/api/rules', '/api/replay/:symbol/events'],
  });
});

app.use((req, res) => res.status(404).json({ error: `no route for ${req.method} ${req.path}` }));

getDb();
startPoller();

// Warm the xStocks catalogue in the background so the first request does not
// pay for it. Failure is non-fatal: it is re-fetched on demand.
refreshAssets({ force: true })
  .then((c) => console.log(`  Assets:  ${c.bySymbol.size} xStocks cached`))
  .catch((e) => console.warn(`  Assets:  warm-up failed (${e.message}); will fetch on demand`));

app.listen(PORT, () => {
  console.log(`Overflow API on http://localhost:${PORT}`);
  console.log(`  RPC:     ${process.env.SOLANA_RPC_URL ? 'configured' : 'PUBLIC (rate-limited; set SOLANA_RPC_URL)'}`);
  const lim = limiterConfig();
  console.log(`  Jupiter: ${lim.keyed ? 'API key set' : 'keyless'} · throttled to ${lim.mainRps} req/s (execute ${lim.executeRps}/s)`);
});
