const axios = require('axios');
const fs = require('fs');
const path = require('path');
const {
  readAllocation,
  updateAllocation,
  storeSnapshot,
  getSubscribers,
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

async function sendWebhook(title, message, mentionIds = []) {
  if (process.env.DISCORD_WEBHOOK_URL) {
    const mentions = mentionIds.map((id) => `<@${id}>`).join(' ');
    const url = `${process.env.DISCORD_WEBHOOK_URL}?wait=true`;
    const res = await axios.post(url, {
      content: `**${title}**\n${message}${mentions ? ' ' + mentions : ''}`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: 'Notify Me',
              custom_id: 'subscribe_alloc',
            },
            {
              type: 2,
              style: 4,
              label: 'Stop Pings',
              custom_id: 'unsubscribe_alloc',
            },
          ],
        },
      ],
    });

    // After 5 seconds, edit the message to remove pings and indicate how many users were notified
    if (mentionIds.length > 0 && res.data && res.data.id) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await axios.patch(
        `${process.env.DISCORD_WEBHOOK_URL}/messages/${res.data.id}`,
        {
          content: `**${title}**\n${message} (${mentionIds.length} users pinged)`,
        }
      );
    }
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
    const mentions = await getSubscribers();
    await sendWebhook(title, status, mentions);
  }

  return { previous, current, changed };
}

module.exports = { checkAllocation };
