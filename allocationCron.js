const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  readAllocation,
  updateAllocation,
  storeSnapshot,
} = require('./storage');
const {
  fetchCheckFinancialData,
  determineRecommendationWithBands,
} = require('./lib/financial');

// Use /tmp on Vercel because the function directory is read-only. Allow
// overriding via STATE_FILE env for tests/local use.
const DEFAULT_STATE_FILE = path.join(
  process.env.VERCEL ? '/tmp' : __dirname,
  'last_allocation.json'
);
const STATE_FILE = process.env.STATE_FILE || DEFAULT_STATE_FILE;

async function sendWebhook(title, message) {
  if (process.env.DISCORD_WEBHOOK_URL) {
    await axios.post(process.env.DISCORD_WEBHOOK_URL, {
      content: `**${title}**\n${message}`,
    });
  } else {
    console.log(`${title}: ${message}`);
  }
}

async function checkAllocation(alwaysNotify = false, title = 'Allocation Update') {
  const data = await fetchCheckFinancialData();
  const { recommendedAllocation } =
    determineRecommendationWithBands(data);
  const current = recommendedAllocation;

  let previous = await readAllocation();
  if (!previous) {
    try {
      previous = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).allocation;
    } catch (e) {
      // No previous file
    }
  }

  const changed = previous !== current;
  if (changed) {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ allocation: current }));
    } catch (e) {
      console.error('[storage] file write', e);
    }
    await updateAllocation(current);
    await storeSnapshot(current);
  }

  const status = changed
    ? `Allocation changed to: ${current}`
    : `No change in allocation: ${current}`;

  if (alwaysNotify || changed) {
    await sendWebhook(title, status);
  }

  return { previous, current, changed };
}

module.exports = { checkAllocation };
