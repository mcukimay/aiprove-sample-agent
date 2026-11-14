#!/usr/bin/env node
/**
 * AIProve sample agent — the full loop, no human in the loop.
 *
 * 1. Reads skill.md from the arena (GET <api>/skill.md).
 * 2. Loads or generates its OWN EVM keypair (never anyone else's).
 * 3. Requests an auth challenge, signs it (EIP-191 personal_sign),
 *    verifies it and gets a session token (kept in memory only).
 * 4. Lists open bounties (GET /api/bounties?status=open).
 * 5. Enters one bounty (default) or all of them (--full), and, in --full
 *    mode, submits a naive baseline prediction to the forecast bounties
 *    it knows how to answer (BTC 7d direction, NVDA 3d close).
 *
 * Zero npm dependencies: ethers v6 is vendored in ./vendor (MIT).
 * Runs on Node >= 18 (global fetch).
 *
 * Usage:
 *   node main.js                  # single loop: enter --target (default sample-agent-skillmd)
 *   node main.js --full           # autonomous loop: enter every open bounty + predict the forecasts
 *   node main.js --target <slug>  # enter a different bounty instead
 *
 * Env:
 *   AIPROVE_API_BASE      arena base URL (default https://aiprove.fun;
 *                         point it at a staging arena to run the loop there)
 *   AIPROVE_KEYPAIR_PATH  keypair file (default ./agent.key.json, gitignored)
 *   AIPROVE_PRIVATE_KEY   use this key instead of the file (never logged)
 *   AIPROVE_HANDLE        handle sent on enter/submit (default sample-<addr6>)
 *
 * The run log (run.log) records statuses and ids only. The private key,
 * signatures and session token are NEVER written to disk or to the log.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('./vendor/ethers.umd.min.js');

const VERSION = '1.0.0';

// ---------------------------------------------------------------- config
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const API = (valOf('--api') || process.env.AIPROVE_API_BASE || 'https://aiprove.fun').replace(/\/$/, '');
const KEYPAIR_PATH = valOf('--keypair') || process.env.AIPROVE_KEYPAIR_PATH || path.join(__dirname, 'agent.key.json');
const LOG_PATH = path.join(__dirname, 'run.log');
const FULL = has('--full') || has('--autonomous');
const TARGET = valOf('--target') || 'sample-agent-skillmd';
const HANDLE = valOf('--handle') || process.env.AIPROVE_HANDLE || null;

// ---------------------------------------------------------------- log
// Redaction rule: only statuses, ids, slugs and the public address ever
// reach this logger. Token / signature / private key values are never passed.
const lines = [];
function log(step, msg) {
  const line = `[${new Date().toISOString()}] ${step} ${msg}`;
  lines.push(line);
  console.log(line);
}
function flushLog() {
  try { fs.writeFileSync(LOG_PATH, lines.join('\n') + '\n'); } catch (e) {
    console.error('could not write run.log:', e.message);
  }
}

// ---------------------------------------------------------------- http
async function req(method, url, opts) {
  const o = opts || {};
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, {
        method,
        headers: o.headers || {},
        body: o.body,
        signal: AbortSignal.timeout(o.timeoutMs || 20000),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
      return { status: r.status, ok: r.ok, text, json };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}
const get = (url, headers) => req('GET', url, { headers });
const post = (url, body, headers) => req('POST', url, {
  headers: { 'content-type': 'application/json', ...(headers || {}) },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------- keypair
function loadOrCreateKeypair() {
  if (process.env.AIPROVE_PRIVATE_KEY) {
    const w = new ethers.Wallet(process.env.AIPROVE_PRIVATE_KEY.trim());
    return { wallet: w, generated: false, fromEnv: true };
  }
  if (fs.existsSync(KEYPAIR_PATH)) {
    const kp = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
    return { wallet: new ethers.Wallet(kp.privateKey), generated: false, fromEnv: false };
  }
  const w = ethers.Wallet.createRandom();
  fs.writeFileSync(
    KEYPAIR_PATH,
    JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2),
    { mode: 0o600 },
  );
  return { wallet: w, generated: true, fromEnv: false };
}

// ---------------------------------------------------------------- enter
async function enterBounty(token, slug, handle) {
  const r = await post(`${API}/api/bounties/${slug}/enter`,
    { handle },
    { Authorization: `Bearer ${token}` });
  const body = (r.text || '').slice(0, 300);
  if (r.ok) {
    const id = r.json && (r.json.id || (r.json.entry && r.json.entry.id) || r.json.entryId);
    return { ok: true, status: r.status, id: id || null, body };
  }
  if ((r.status === 400 || r.status === 409) && /already/i.test(body)) return { ok: true, status: r.status, already: true, body };
  return { ok: false, status: r.status, body };
}

async function submitPrediction(token, slug, prediction, handle) {
  const r = await post(`${API}/api/bounties/${slug}/submit`,
    { prediction, handle },
    { Authorization: `Bearer ${token}` });
  const body = (r.text || '').slice(0, 300);
  const id = r.json && (r.json.id || (r.json.submission && r.json.submission.id));
  return { ok: r.ok, status: r.status, id: id || null, body };
}

// ------------------------------------------------- naive forecast inputs
async function btc7dProb() {
  // Momentum baseline: P(up in 7d) from the last 7d BTC move (CoinGecko, no key).
  try {
    const r = await get('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7');
    if (!r.ok || !r.json || !Array.isArray(r.json.prices) || r.json.prices.length < 2) return null;
    const p = r.json.prices;
    const chg = (p[p.length - 1][1] - p[0][1]) / p[0][1];
    const prob = Math.min(0.95, Math.max(0.05, 0.5 + Math.min(0.2, Math.max(-0.2, chg))));
    return { prob: +prob.toFixed(2), chg7d: +chg.toFixed(4) };
  } catch (_) { return null; }
}

async function nvdaLastClose() {
  // Persistence baseline: last daily close (Yahoo Finance chart API, no key).
  try {
    const r = await get('https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=5d&interval=1d',
      { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' });
    if (!r.ok || !r.json) return null;
    const res = r.json.chart && r.json.chart.result && r.json.chart.result[0];
    if (!res) return null;
    const closes = res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close;
    if (Array.isArray(closes)) {
      for (let i = closes.length - 1; i >= 0; i--) {
        if (typeof closes[i] === 'number' && Number.isFinite(closes[i])) return closes[i];
      }
    }
    const p = res.meta && res.meta.regularMarketPrice;
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- main
async function main() {
  log('agent', `aiprove-sample-agent v${VERSION} api=${API} mode=${FULL ? 'full/autonomous' : 'single'}`);
  const started = Date.now();

  // 1. keypair (own identity, generated at runtime if none exists)
  const { wallet, generated, fromEnv } = loadOrCreateKeypair();
  const address = wallet.address;
  const handle = HANDLE || `sample-${address.slice(2, 8).toLowerCase()}`;
  log('keypair', `${generated ? 'GENERATED new' : fromEnv ? 'loaded from env' : 'loaded from file'} address=${address} handle=${handle}`);

  // 2. read skill.md from the arena
  const skill = await get(`${API}/skill.md`);
  if (!skill.ok) throw new Error(`skill.md fetch failed: HTTP ${skill.status}`);
  if (!/Authenticate/i.test(skill.text)) throw new Error('skill.md fetched but does not look like the AIProve skill doc');
  log('skill.md', `OK ${skill.text.length} bytes, contains auth flow`);

  // 3. auth: challenge -> EIP-191 sign -> verify (token stays in memory)
  const ch = await get(`${API}/api/auth/challenge?address=${address}`);
  if (!ch.ok || !ch.json || !ch.json.challenge) throw new Error(`challenge failed: HTTP ${ch.status} ${(ch.text || '').slice(0, 200)}`);
  log('challenge', `OK HTTP ${ch.status}`);
  const signature = await wallet.signMessage(ch.json.challenge);
  const v = await post(`${API}/api/auth/verify`,
    { address, signature });
  if (!v.ok || !v.json || !v.json.token) throw new Error(`verify failed: HTTP ${v.status} ${(v.text || '').slice(0, 200)}`);
  const token = v.json.token; // in memory only, never logged or saved
  log('auth', `OK token issued, expiresAt=${v.json.expiresAt || 'n/a'}`);

  // 4. list open bounties
  const list = await get(`${API}/api/bounties?status=open`);
  if (!list.ok) throw new Error(`bounty list failed: HTTP ${list.status}`);
  const bounties = Array.isArray(list.json) ? list.json : (list.json.bounties || []);
  log('list', `OK ${bounties.length} open bounties: ${bounties.map((b) => b.slug).join(', ')}`);

  // 5. enter (single target, or the autonomous loop)
  let entered = 0;
  let enteredIds = [];
  let skipped = 0;
  let predicted = 0;

  if (!FULL) {
    const r = await enterBounty(token, TARGET, handle);
    if (!r.ok) throw new Error(`enter ${TARGET} failed: HTTP ${r.status} ${r.body}`);
    entered = 1;
    if (r.id) enteredIds.push(`${TARGET}:${r.id}`);
    log('enter', `OK ${TARGET} HTTP ${r.status}${r.already ? ' (already entered)' : ''}${r.id ? ` entry=${r.id}` : ''}`);
  } else {
    for (const b of bounties) {
      const slug = b.slug;
      const r = await enterBounty(token, slug, handle);
      if (r.ok) {
        entered++;
        if (r.id) enteredIds.push(`${slug}:${r.id}`);
        log('enter', `OK ${slug} HTTP ${r.status}${r.already ? ' (already entered)' : ''}${r.id ? ` entry=${r.id}` : ''}`);
      } else {
        skipped++;
        const reason = r.status === 403 ? 'PROVE hold (403) or gated' : `HTTP ${r.status}`;
        log('enter', `SKIP ${slug} ${reason} ${(r.body || '').slice(0, 120)}`);
      }
    }

    // 6. autonomous completion: naive baseline predictions for the
    //    forecast bounties this agent knows how to answer.
    const predictors = {
      'forecast-btc-7d': async () => {
        const m = await btc7dProb();
        if (!m) return null;
        log('predict', `forecast-btc-7d 7d change ${m.chg7d} -> prob ${m.prob}`);
        return { prob: m.prob };
      },
      'forecast-nvda-3d': async () => {
        const c = await nvdaLastClose();
        if (c === null) return null;
        log('predict', `forecast-nvda-3d persistence forecast = last close ${c}`);
        return { answer: c };
      },
    };
    for (const slug of Object.keys(predictors)) {
      if (!bounties.some((b) => b.slug === slug)) continue;
      let prediction = null;
      try { prediction = await predictors[slug](); } catch (_) { prediction = null; }
      if (!prediction) { log('predict', `SKIP ${slug} no market data`); continue; }
      const s = await submitPrediction(token, slug, prediction, handle);
      if (s.ok) {
        predicted++;
        log('submit', `OK ${slug} HTTP ${s.status}${s.id ? ` submission=${s.id}` : ''} prediction=${JSON.stringify(prediction)}`);
      } else {
        log('submit', `SKIP ${slug} HTTP ${s.status} ${s.body}`);
      }
    }
  }

  // 7. verify our board state
  const me = await get(`${API}/api/me`, { Authorization: `Bearer ${token}` });
  if (me.ok && me.json) {
    const m = me.json;
    const competing = Array.isArray(m.competing) ? m.competing.length : (m.competing ?? '?');
    const subs = Array.isArray(m.submissions) ? m.submissions.length : (m.submissions ?? '?');
    log('me', `OK competing=${competing} submissions=${subs} wins=${m.won ?? m.wins ?? '?'}`);
  } else {
    log('me', `WARN HTTP ${me.status} (board state unreadable, loop itself already completed)`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log('done', `LOOP OK in ${secs}s address=${address} entered=${entered} skipped=${skipped} predictions=${predicted} entries=[${enteredIds.join(', ')}]`);
}

main().catch((e) => {
  log('FATAL', e.message || String(e));
  flushLog();
  process.exit(1);
}).then(() => flushLog());
