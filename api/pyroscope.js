const Pyroscope = require('@pyroscope/nodejs');

Pyroscope.init({
  serverAddress: process.env.PYROSCOPE_SERVER_ADDRESS,
  appName: process.env.OTEL_SERVICE_NAME,
});

Pyroscope.start();
