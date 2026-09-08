const Pyroscope = require('@pyroscope/nodejs');

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports.serializeResult = function (order) {
  // 👇 Wrap the hot function with a label
  return Pyroscope.wrapWithLabels({ span_name: 'serializeResult' }, () => {
    let acc = { order, items: [] };
    for (let i = 0; i < 2000; i++) {
      acc = deepClone(acc);
      acc.items.push({ i, ts: Date.now() });
    }
    return Buffer.from(JSON.stringify(acc));
  });
};