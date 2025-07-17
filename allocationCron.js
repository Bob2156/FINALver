const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const fetchData = require('./api/fetchData');

const STATE_FILE = path.join(__dirname, 'last_allocation.json');

async function checkAllocation() {
  const data = await fetchData.fetchCheckFinancialData();
  const { recommendedAllocation } = fetchData.determineRecommendationWithBands(data);
  const current = recommendedAllocation;

  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).allocation;
  } catch (e) {
    // No previous file
  }

  if (previous !== current) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ allocation: current }));
    if (process.env.DISCORD_WEBHOOK_URL) {
      await axios.post(process.env.DISCORD_WEBHOOK_URL, {
        content: `Allocation change detected: ${current}`
      });
    } else {
      console.log('Allocation changed to:', current);
    }
  }
  return { previous, current };
}

function startSchedule() {
  cron.schedule('0 20 * * 1-5', () => {
    checkAllocation().catch(err => console.error('Cron error', err));
  });
}

module.exports = { checkAllocation, startSchedule };
