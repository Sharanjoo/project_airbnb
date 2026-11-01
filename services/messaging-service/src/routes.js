// Messaging Service (API doc §6). Owner: Slice 1. Data in MongoDB threads/messages.
const express = require('express');
const Joi = require('joi');
const { asyncHandler, validateBody, requireRole, Errors } = require('@airbnb/common');

const sendSchema = Joi.object({
  thread_id: Joi.string().required(),
  message_text: Joi.string().trim().min(1).max(2000).required(),
  client_message_id: Joi.string().max(64),
});

function buildRouter({ bus }) { // eslint-disable-line no-unused-vars
  const r = express.Router();
  const participant = requireRole('guest', 'host');

  r.post('/threads/open', participant, asyncHandler(async () => { throw Errors.notImplemented('POST /threads/open'); }));
  r.post('/threads/get', participant, asyncHandler(async () => { throw Errors.notImplemented('POST /threads/get'); }));
  r.post('/threads/byUser', participant, asyncHandler(async () => { throw Errors.notImplemented('POST /threads/byUser'); }));
  r.post('/messages/list', participant, asyncHandler(async () => { throw Errors.notImplemented('POST /messages/list'); }));
  r.post('/messages/send', participant, validateBody(sendSchema), asyncHandler(async () => {
    // TODO: dedupe on client_message_id, insert, publish message.sent (key = thread_id)
    throw Errors.notImplemented('POST /messages/send');
  }));
  r.post('/messages/markRead', participant, asyncHandler(async () => { throw Errors.notImplemented('POST /messages/markRead'); }));

  return r;
}

module.exports = { buildRouter };
