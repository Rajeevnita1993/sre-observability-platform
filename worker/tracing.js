const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'worker',
  }),
  traceExporter: new OTLPTraceExporter(),   // traces to collector
  metricReader: new PrometheusExporter({
    port: 9464,          // default – matches your prometheus.yml target
    endpoint: '/metrics',
  }),
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-aws-sdk': { 
      sqsExtractContextPropagationFromPayload: true 
    },
  })],
});
sdk.start();