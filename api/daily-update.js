const { checkAllocation } = require('../allocationCron');

module.exports = async (req, res) => {
  try {
    await checkAllocation(false, 'Daily Allocation Update');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('daily update error', err);
    res.status(500).json({ error: 'cron failure' });
  }
};
