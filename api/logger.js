// api/logger.js
const { createServiceLogger } = require('./shared/logger');

// Create and export the API logger
const logger = createServiceLogger('api');

// Also export the withTrace helper for convenience
const { withTrace, getTraceContext } = require('./shared/logger');

module.exports = {
  logger,
  withTrace,
  getTraceContext,
};

// const pino = require('pino');

// const logger = pino({
//   level: process.env.LOG_LEVEL ?? 'info',
//   base: { service: 'api', env: process.env.APP_ENV ?? 'local' },
//   timestamp: pino.stdTimeFunctions.isoTime,
//   formatters: { level: (label) => ({ level: label }) }  // level as text, not 30
// });

// module.exports = logger;

