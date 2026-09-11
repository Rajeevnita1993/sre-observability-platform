const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { Resource } = require('@opentelemetry/resources');           // ← v1 API
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
const { ParentBasedSampler, TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-base');


const sdk = new NodeSDK({
  resource: new Resource({                                          // ← v1 API
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'worker',
    'service.version': process.env.SERVICE_VERSION || '2.3.0',
    'deployment.environment': process.env.DEPLOY_ENV || 'local',
  }),
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PrometheusExporter({
    port: 9464,
    endpoint: '/metrics',
  }),
  // sampler: new ParentBasedSampler({
  //   root: new TraceIdRatioBasedSampler(0.2),
  // }),
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-aws-sdk': { enabled: false },
    '@opentelemetry/instrumentation-fs': { enabled: false },
  })],
});
sdk.start();