process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'messaging-service';
const { createApp, EventBus, logger } = require('@airbnb/common');
const { buildRouter } = require('./routes');

const bus = new EventBus('messaging-service');
const app = createApp({ name: 'messaging-service', logger });
app.use(buildRouter({ bus }));
app.finalize();

if (require.main === module) {
  const port = Number(process.env.MESSAGING_SERVICE_PORT || 8004);
  app.listen(port, () => logger.info(`messaging-service listening on ${port}`));
}

module.exports = app;
