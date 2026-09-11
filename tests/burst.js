// tests/burst.js
const http = require('http');

const API_HOST = 'localhost';
const API_PORT = 8080;
const TOTAL = 300;
const LARGE_SIZE = 150000;   // 150 KB — under SNS's 256 KB cap, over the 100 KB fault threshold
const SMALL_SIZE = 2000;

function post(body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: API_HOST,
        port: API_PORT,
        path: '/orders',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', () => resolve(0));
    req.write(payload);
    req.end();
  });
}

async function main() {
  let okSmall = 0, okLarge = 0, fail = 0;

  for (let i = 0; i < TOTAL; i++) {
    const isLarge = i % 2 === 0;
    const size = isLarge ? LARGE_SIZE : SMALL_SIZE;
    const item = 'x'.repeat(size);

    const status = await post({ item, qty: 1 });
    if (status === 202) {
      isLarge ? okLarge++ : okSmall++;
    } else {
      fail++;
      if (fail <= 5) console.log(`  request ${i} -> HTTP ${status}`);
    }
  }

  console.log(`Done. Small OK: ${okSmall}, Large OK: ${okLarge}, Failures: ${fail}`);
}

main();