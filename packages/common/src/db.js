// Lazy database clients. Nothing connects until first use, so unit tests and
// /health work without the databases running.
const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');

let pool;
function getMysql() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'localhost',
      port: Number(process.env.MYSQL_PORT || 3307),
      user: process.env.MYSQL_USER || 'airbnb',
      password: process.env.MYSQL_PASSWORD || 'airbnb',
      database: process.env.MYSQL_DATABASE || 'airbnb',
      connectionLimit: Number(process.env.MYSQL_POOL || 10),
      dateStrings: true,
    });
  }
  return pool;
}

const RETRYABLE_TX = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * Run fn(conn) inside a transaction; commits on success, rolls back on throw.
 * Deadlocks are normal under contention (e.g. many guests booking the same
 * nights): MySQL aborts one transaction, and we rerun it from the start.
 */
async function withTransaction(fn, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await getMysql().getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      if (!RETRYABLE_TX.has(err.code) || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 20));
    } finally {
      conn.release();
    }
  }
}

let mongoClient;
async function getMongo() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27018');
    await mongoClient.connect();
  }
  return mongoClient.db(process.env.MONGO_DB || 'airbnb');
}

let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    redis.on('error', () => {}); // callers fall back to MySQL when Redis is down (13.9)
  }
  return redis;
}

module.exports = { getMysql, withTransaction, getMongo, getRedis };
