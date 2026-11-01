process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'analytics-service';
const { createApp, EventBus, logger } = require('@airbnb/common');
const { buildRouter } = require('./routes');

const bus = new EventBus('analytics-service');
const app = createApp({ name: 'analytics-service', logger });
app.use(buildRouter({ bus }));
app.finalize();

if (require.main === module) {
  const port = Number(process.env.ANALYTICS_SERVICE_PORT || 8006);
  app.listen(port, () => logger.info(`analytics-service listening on ${port}`));
}

module.exports = app;
