// api/fetchData.js

// Import necessary modules (if using Node.js environment)
// For Vercel serverless functions, ensure you have the appropriate setup.
// If you're using Next.js, adjust accordingly.

export default async function handler(req, res) {
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

  // Define valid ranges and corresponding intervals
  const rangeOptions = {
    '1d': { range: '1d', interval: '1m' },
    '1mo': { range: '1mo', interval: '5m' },
    '1y': { range: '1y', interval: '1d' },
    '3y': { range: '3y', interval: '1wk' },
    '10y': { range: '10y', interval: '1mo' },
  };

  // Set default range if not provided or invalid
  const selectedRange = rangeOptions[range] ? range : '1d';
  const { range: yahooRange, interval } = rangeOptions[selectedRange];

  try {
    // Fetch the financial data for the specified ticker and range
    const tickerResponse = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`);

    if (!tickerResponse.ok) {
      throw new Error("Failed to fetch data from Yahoo Finance. Please check the ticker symbol and try again.");
    }

    const tickerData = await tickerResponse.json();

    // Check if the response contains valid data
    if (
      !tickerData.chart.result ||
      tickerData.chart.result.length === 0 ||
      !tickerData.chart.result[0].meta.regularMarketPrice
    ) {
      throw new Error("Invalid ticker symbol or data unavailable.");
    }

    // Extract current price
    const currentPrice = parseFloat(tickerData.chart.result[0].meta.regularMarketPrice).toFixed(2);

    // Extract historical prices and timestamps
    const timestamps = tickerData.chart.result[0].timestamp;
    let prices = [];

    // Determine if adjclose is available
    if (
      tickerData.chart.result[0].indicators.adjclose &&
      tickerData.chart.result[0].indicators.adjclose[0].adjclose
    ) {
      prices = tickerData.chart.result[0].indicators.adjclose[0].adjclose;
    } else if (
      tickerData.chart.result[0].indicators.quote &&
      tickerData.chart.result[0].indicators.quote[0].close
    ) {
      prices = tickerData.chart.result[0].indicators.quote[0].close;
    } else {
      throw new Error("Price data is unavailable.");
    }

    // Handle missing data
    if (!timestamps || !prices || timestamps.length !== prices.length) {
      throw new Error("Incomplete historical data.");
    }

    // Prepare historical data for Chart.js
    const historicalData = timestamps.map((timestamp, index) => {
      const dateObj = new Date(timestamp * 1000);
      let dateLabel = '';

      if (selectedRange === '1d' || selectedRange === '1mo') {
        // Include time for intraday data
        dateLabel = dateObj.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } else {
        // Only date for daily and longer intervals
        dateLabel = dateObj.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
      }

      return {
        date: dateLabel,
        price: prices[index],
      };
    });

    // Optional: Aggregate data for longer ranges to reduce data points
    let aggregatedData = historicalData;
    if (selectedRange === '10y') {
      // Aggregate monthly averages for 10-year data
      const monthlyMap = {};
      historicalData.forEach(entry => {
        const month = entry.date.slice(0, 7); // 'Sep 2020'
        if (!monthlyMap[month]) {
          monthlyMap[month] = [];
        }
        monthlyMap[month].push(entry.price);
      });

      aggregatedData = Object.keys(monthlyMap).map(month => {
        const avgPrice = monthlyMap[month].reduce((sum, p) => sum + p, 0) / monthlyMap[month].length;
        return {
          date: month,
          price: parseFloat(avgPrice).toFixed(2),
        };
      });
    }

    // Return the current price and historical data
    res.status(200).json({
      ticker: ticker.toUpperCase(),
      currentPrice: `$${currentPrice}`,
      historicalData: aggregatedData,
      selectedRange: selectedRange,
    });
  } catch (error) {
    console.error("Error fetching data:", error.message);
    res.status(500).json({ error: error.message || "Failed to fetch financial data." });
  }
}
