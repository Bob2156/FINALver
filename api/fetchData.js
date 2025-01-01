// api/fetchData.js

const axios = require("axios");

// Function to fetch financial data for /check command
async function fetchCheckFinancialData() {
    try {
        // Fetch SPY (price and historical data for 220 days) and Treasury Rate (30 days) concurrently
        const [spyResponse, treasuryResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=30d"), // Fetch 30 days for Treasury rate
        ]);

        const spyData = spyResponse.data;
        const treasuryData = treasuryResponse.data;

        // Extract SPY price
        const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;

        // Extract 220-day SMA from Adjusted Close
        const spyAdjClosePrices = spyData.chart.result[0].indicators.adjclose[0].adjclose;
        if (!spyAdjClosePrices || spyAdjClosePrices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const sum220 = spyAdjClosePrices.slice(-220).reduce((acc, price) => acc + price, 0);
        const sma220 = (sum220 / 220).toFixed(2);

        // Determine if SPY is over or under the 220-day SMA
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";

        // Extract 3-Month Treasury Rate
        const treasuryRates = treasuryData.chart.result[0].indicators.quote[0].close;
        if (!treasuryRates || treasuryRates.length === 0) {
            throw new Error("Treasury rate data is unavailable.");
        }
        const currentTreasuryRate = parseFloat(treasuryRates[treasuryRates.length - 1]).toFixed(2);
        const oneMonthAgoTreasuryRate = treasuryRates.length >= 30
            ? parseFloat(treasuryRates[treasuryRates.length - 30]).toFixed(2)
            : parseFloat(treasuryRates[0]).toFixed(2); // Handle cases with less than 30 data points

        // Determine Treasury Rate Change
        const treasuryRateChange = (currentTreasuryRate - oneMonthAgoTreasuryRate).toFixed(2);

        // Determine if Treasury rate is falling
        const isTreasuryFalling = treasuryRateChange < 0;

        // Calculate Volatility from SPY Historical Data (21-Day Volatility)
        const dailyReturns = spyAdjClosePrices.slice(1).map((price, index) => {
            const previousPrice = spyAdjClosePrices[index];
            return (price / previousPrice - 1);
        });

        const recentReturns = dailyReturns.slice(-21); // Last 21 daily returns
        if (recentReturns.length < 21) {
            throw new Error("Not enough data to calculate 21-day volatility.");
        }

        const meanReturn = recentReturns.reduce((acc, r) => acc + r, 0) / recentReturns.length;
        const variance = recentReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / recentReturns.length;
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2); // Annualized volatility as percentage

        return {
            spy: parseFloat(spyPrice).toFixed(2),
            sma220: parseFloat(sma220).toFixed(2),
            spyStatus: spyStatus,
            volatility: parseFloat(annualizedVolatility).toFixed(2),
            treasuryRate: parseFloat(currentTreasuryRate).toFixed(2),
            isTreasuryFalling: isTreasuryFalling,
            treasuryRateChange: parseFloat(treasuryRateChange).toFixed(2),
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        throw new Error("Failed to fetch financial data");
    }
}

// Function to fetch financial data for /ticker command
async function fetchTickerFinancialData(ticker, range) {
    try {
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

        // Fetch the financial data for the specified ticker and range
        const tickerResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`);

        const tickerData = tickerResponse.data;

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

        return {
            ticker: ticker.toUpperCase(),
            currentPrice: `$${currentPrice}`,
            historicalData: aggregatedData,
            selectedRange: selectedRange,
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        throw new Error(error.response && error.response.data && error.response.data.chart && error.response.data.chart.error
            ? error.response.data.chart.error.description
            : "Failed to fetch financial data.");
    }
}

// Main handler for fetchData.js
async function handler(req, res) {
    const { ticker, range, type } = req.query;

    if (type === 'check') {
        try {
            const financialData = await fetchCheckFinancialData();
            res.status(200).json(financialData);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    } else if (ticker && range) {
        try {
            const tickerData = await fetchTickerFinancialData(ticker, range);
            res.status(200).json(tickerData);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    } else {
        res.status(400).json({ error: "Invalid parameters." });
    }
}

module.exports = handler;
