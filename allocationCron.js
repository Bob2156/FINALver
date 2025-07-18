const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const fetchData = require('./api/fetchData');

const STATE_FILE = path.join(__dirname, 'last_allocation.json');

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
  const data = await fetchData.fetchCheckFinancialData();
  const { recommendedAllocation } =
    fetchData.determineRecommendationWithBands(data);
  const current = recommendedAllocation;

  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).allocation;
  } catch (e) {
    // No previous file
  }

  const changed = previous !== current;
  if (changed) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ allocation: current }));
  }

  const status = changed
    ? `Allocation changed to: ${current}`
    : `No change in allocation: ${current}`;

  if (alwaysNotify || changed) {
    await sendWebhook(title, status);
  }

  return { previous, current, changed };
}

function scheduleTomorrowTest() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(now.getUTCDate() + 1);
  tomorrow.setUTCHours(18, 0, 0, 0); // 10am PST == 18:00 UTC
  const delay = tomorrow.getTime() - now.getTime();
  if (delay > 0) {
    setTimeout(() => {
      checkAllocation(true, 'Test Update').catch((err) =>
        console.error('Test update error', err)
      );
    }, delay);
  }
}

function startSchedule() {
  cron.schedule('0 20 * * 1-5', () => {
    checkAllocation(true, 'Daily Allocation Update').catch((err) =>
      console.error('Cron error', err)
    );
  });
  scheduleTomorrowTest();
}

module.exports = { checkAllocation, startSchedule };
