const Pyroscope = require('@pyroscope/nodejs');

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
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
    body = Buffer.from(JSON.stringify(acc));
  });
  return body;
};