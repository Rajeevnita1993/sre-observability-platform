const { register, httpRequestsTotal, httpRequestDuration, httpInFlight }
  = require('./metrics');
const { trace } = require('@opentelemetry/api');

module.exports = function addMetrics(app) {
  app.use((req, res, next) => {
    const route = req.path;
    const end = httpRequestDuration.startTimer({ route, method: req.method });
    httpInFlight.inc({ route });

    // Capture the current span context at the start of the request
    const span = trace.getActiveSpan();
    const spanContext = span?.spanContext();

    res.on('finish', () => {
      const labels = { route, method: req.method, status: res.statusCode };
      httpRequestsTotal.inc(labels);

      // Use the captured spanContext from the start
      const traceId = spanContext?.traceId;

      // End the timer and attach exemplar
      end(
        { status: res.statusCode },
        traceId ? { trace_id: traceId } : undefined
      );

      httpInFlight.dec({ route });
    });
    next();
  });

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });
};