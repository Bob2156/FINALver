// api/fetchData.js

const { fetchTickerFinancialData } = require('./dataFetcher');

async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method Not Allowed. Use GET." });
    return;
  }

  const { ticker, range } = req.query;

  // Validate ticker parameter
  const validTickerRegex = /^[A-Z]{1,5}$/; // Ticker symbols typically 1-5 uppercase letters
  if (!ticker || !validTickerRegex.test(ticker)) {
    res.status(400).json({ error: "Invalid or missing ticker symbol. Please enter a valid uppercase ticker (e.g., AAPL)." });
    return;
  }

  try {
    // Fetch financial data
    const tickerData = await fetchTickerFinancialData(ticker, range);

    res.status(200).json({
      ticker: tickerData.ticker,
      currentPrice: tickerData.currentPrice,
      historicalData: tickerData.historicalData,
      selectedRange: tickerData.selectedRange,
    });
  } catch (error) {
    console.error("Error fetching data:", error.message);
    res.status(500).json({ error: error.message || "Failed to fetch financial data." });
  }
}

module.exports = handler;
