process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'review-service';
const { createApp, EventBus, logger } = require('@airbnb/common');
const { buildRouter } = require('./routes');

const bus = new EventBus('review-service');
const app = createApp({ name: 'review-service', logger });
app.use(buildRouter({ bus }));
app.finalize();

if (require.main === module) {
  const port = Number(process.env.REVIEW_SERVICE_PORT || 8005);
  app.listen(port, () => logger.info(`review-service listening on ${port}`));
}

module.exports = app;
