const { checkAllocation } = require('../allocationCron');

module.exports = async (req, res) => {
  try {
    await checkAllocation(true, 'Daily Allocation Update');
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('daily allocation error', err);
    res.status(500).json({ error: 'Internal error' });
  }
};
