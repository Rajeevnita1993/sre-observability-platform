// worker/debug-server.js
'use strict';
const http = require('http');
const { validateBatch } = require('./validate-batch');

const PORT = Number(process.env.DEBUG_PORT) || 9465;

function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({ item: `SKU-${i}`, qty: 1 }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') { res.writeHead(200).end('ok'); return; }

  if (url.pathname === '/debug/validate-batch') {
    const workers = Number(url.searchParams.get('workers')) || 4;
    const items   = Number(url.searchParams.get('items'))   || 2000;
    const t0 = process.hrtime.bigint();
    try {
      const result = await validateBatch(makeItems(items), workers);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...result, ms: Math.round(ms) }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, () => console.log(`[debug] listening on ${PORT}`));
module.exports = { server };