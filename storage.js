const { kv } = require('@vercel/kv');

const LAST_KEY = 'lastAllocation';
const HISTORY_KEY = 'allocationHistory';

async function readAllocation() {
  try {
    const value = await kv.get(LAST_KEY);
    return typeof value === 'string' ? value : null;
  } catch (err) {
    console.error('[storage] read kv', err);
    return null;
  }
}

async function updateAllocation(value) {
  try {
    await kv.set(LAST_KEY, value);
  } catch (err) {
    console.error('[storage] update kv', err);
  }
}

async function storeSnapshot(allocation) {
  try {
    const entry = JSON.stringify({ allocation, timestamp: new Date().toISOString() });
    await kv.lpush(HISTORY_KEY, entry);
  } catch (err) {
    console.error('[storage] kv snapshot', err);
  }
}

module.exports = {
  readAllocation,
  updateAllocation,
  storeSnapshot,
};
