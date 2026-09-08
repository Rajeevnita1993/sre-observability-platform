const Pyroscope = require('@pyroscope/nodejs');
console.log('[pyroscope] Initializing...');
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'worker';

Pyroscope.init({
  serverAddress: process.env.PYROSCOPE_SERVER_ADDRESS || 'http://pyroscope:4040',
  appName: SERVICE_NAME,
  tags: {
    service_name: SERVICE_NAME,
    version: process.env.APP_VERSION || '0.9.0',
    env: 'local',
  },
   wall: { collectCpuTime: true },
   heap: { samplingIntervalBytes: 512 * 1024,
    },
});

Pyroscope.start();
console.log('[pyroscope] Started.');