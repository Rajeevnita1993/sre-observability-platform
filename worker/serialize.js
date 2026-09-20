const Pyroscope = require('@pyroscope/nodejs');

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// synthetic dedupe on a fixed-size batch so the profiler
// sees a stable per-message cost. Wrapped under a named label so it
// shows as its own frame in the flame graph.
function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!seen.has(it.sku)) {
      seen.add(it.sku);
      out.push(it);
    }
  }
  return out;
}

function buildBatch(size) {
  const batch = [];
  for (let i = 0; i < size; i++) {
    batch.push({ sku: 'SKU-' + ((i * 7) % (size - 200)), i });
  }
  return batch;
}

module.exports.serializeResult = function (order) {
  let body;
  Pyroscope.wrapWithLabels({ span_name: 'serializeResult' }, () => {
    let acc = { order, items: [] };
    // Simulate a CPU-intensive operation by creating a large array of items
    // If you want to test the performance impact, you can increase the number of iterations
    // otherwise, we should keep it reasonable to avoid excessive CPU usage during testing
    for (let i = 0; i < 20; i++) {
      acc = deepClone(acc);
      acc.items.push({ i, ts: Date.now() });
    }

    const batch = buildBatch(3000);
    let unique;
    Pyroscope.wrapWithLabels({ span_name: 'dedupeItems' }, () => {
      unique = dedupeItems(batch);
    });
    acc.dedupe_size = unique.length;

    body = Buffer.from(JSON.stringify(acc));
  });
  return body;
};