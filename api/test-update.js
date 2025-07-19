const { checkAllocation } = require('../allocationCron');

module.exports = async (req, res) => {
  try {
    await checkAllocation(true, 'Test Update');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('test update error', err);
    res.status(500).json({ error: 'cron failure' });
  }
};
