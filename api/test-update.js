const { checkAllocation, isTestSent, markTestSent } = require('../allocationCron');

module.exports = async (req, res) => {
  if (isTestSent()) {
    res.status(200).json({ skipped: true });
    return;
  }
  try {
    await checkAllocation(true, 'Test Update');
    markTestSent();
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('test update error', err);
    res.status(500).json({ error: 'Internal error' });
  }
};
