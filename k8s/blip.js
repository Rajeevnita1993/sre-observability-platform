// blip.js — 90 seconds of ~100% slow requests against /orders?slow=true
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    brief_blip: {
      executor: 'constant-vus',
      vus: 15,
      duration: '90s',
    },
  },
};

export default function () {
  const payload = JSON.stringify({ item: 'ABC-9999', qty: 1 });
  const res = http.post(
    'http://localhost:8080/orders?slow=true',
    payload,
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(res, { 'status is 202': (r) => r.status === 202 });
}