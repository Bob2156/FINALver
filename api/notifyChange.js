const fs = require('fs');
const path = require('path');
const axios = require('axios');

const fetchModule = require('./fetchData.js');

const STATE_PATH = path.join('/tmp', 'lastAllocation.json');

module.exports = async (req, res) => {
  try {
    // Pull fresh financial data and determine recommendation
    const data = await fetchModule.fetchCheckFinancialData();
    const rec = fetchModule.determineRecommendationWithBands(data);

    const current = {
      category: rec.recommendedCategory,
      allocation: rec.recommendedAllocation,
    };

    // Read last recorded allocation if available
    let last = null;
    if (fs.existsSync(STATE_PATH)) {
      try {
        last = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      } catch (e) {
        console.error('Failed to read state file:', e);
      }
    }

    const changed = !last || last.allocation !== current.allocation;

    if (changed) {
      if (!process.env.DISCORD_WEBHOOK_URL) {
        console.error('DISCORD_WEBHOOK_URL not set');
      } else {
        await axios.post(process.env.DISCORD_WEBHOOK_URL, {
          content: `\uD83D\uDCCA Allocation update: **${current.category}** - ${current.allocation}`,
        });
      }
      try {
        fs.writeFileSync(STATE_PATH, JSON.stringify(current));
      } catch (e) {
        console.error('Failed to write state file:', e);
      }
    }

    res.json({ changed, current });
  } catch (e) {
    console.error('Notify error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
};
