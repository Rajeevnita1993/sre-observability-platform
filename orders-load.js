// orders-load.js
import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 50 },  // ramp 0 → 50 VUs
    { duration: '5m', target: 50 },  // hold at 50 VUs
    { duration: '2m', target: 0 },   // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed:   ['rate<0.01'],
  },
  // Tag every sample so Mimir can separate k6's client-side view
  // from the api's server-side RED metrics
  tags: {
    source: 'k6',
    test:   'orders-load',
  },
};

export default function () {
  const payload = JSON.stringify({ item: 'ABC-1234', qty: 1 });

  const res = http.post('http://localhost:8080/orders', payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'status is 202': (r) => r.status === 202,
  });

  sleep(1);
}