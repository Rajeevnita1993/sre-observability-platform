// baseline.js
import http from 'k6/http';
export const options = { vus: 10, duration: '15m' };
export default function () {
  http.post(
    'http://localhost:8080/orders',
    JSON.stringify({ item: 'ABC-1111', qty: 1 }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}