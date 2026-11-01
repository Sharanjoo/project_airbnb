process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'booking-service';
const { createApp, EventBus, logger } = require('@airbnb/common');
const { buildRouter } = require('./routes');

const bus = new EventBus('booking-service');
const app = createApp({ name: 'booking-service', logger });
app.use(buildRouter({ bus }));
app.finalize();

if (require.main === module) {
  const port = Number(process.env.BOOKING_SERVICE_PORT || 8003);
  app.listen(port, () => logger.info(`booking-service listening on ${port}`));
}

module.exports = app;
