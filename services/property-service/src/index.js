process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'property-service';
const { createApp, EventBus, logger } = require('@airbnb/common');
const { buildRouter } = require('./routes');

const bus = new EventBus('property-service');
const app = createApp({ name: 'property-service', logger });
app.use(buildRouter({ bus }));
app.finalize();

if (require.main === module) {
  const port = Number(process.env.PROPERTY_SERVICE_PORT || 8002);
  app.listen(port, () => logger.info(`property-service listening on ${port}`));
}

module.exports = app;
