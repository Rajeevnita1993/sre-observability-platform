// worker/logger.js
const { createServiceLogger } = require('./shared/logger');

// Create and export the worker logger
const logger = createServiceLogger('worker');

// Also export the withTrace helper for convenience
const { withTrace, getTraceContext } = require('./shared/logger');

module.exports = {
  logger,
  withTrace,
  getTraceContext,
};