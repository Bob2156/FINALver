"use strict";

const axios = require("axios");

// --- Helper Functions (Duplicated from index.js for standalone use) ---

function logDebug(message) {
    console.log(`[fetchdata DEBUG] ${new Date().toISOString()} - ${message}`);
}

// --- Data Fetching Functions (Mirrors index.js logic) ---

async function fetchCheckFinancialData() {
    logDebug("Initiating fetchCheckFinancialData (standalone)...");
    const SPY_URL = "https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d";
    const IRX_URL = "https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"; // Increased range

    try {
        const [spyResponse, treasuryResponse] = await Promise.all([
            axios.get(SPY_URL, { timeout: 10000 }),
            axios.get(IRX_URL, { timeout: 10000 })
        ]);

        // SPY Data Processing
        const spyResult = spyResponse.data?.chart?.result?.[0];
        if (!spyResult?.meta?.regularMarketPrice || !spyResult?.indicators?.adjclose?.[0]?.adjclose) {
            throw new Error("Invalid or incomplete SPY data structure from Yahoo Finance.");
        }
        const spyPrice = parseFloat(spyResult.meta.regularMarketPrice);
        const spyAdjClosePrices = spyResult.indicators.adjclose[0].adjclose.filter(p => typeof p === 'number');

        // Calculate 220-day SMA
        if (spyAdjClosePrices.length < 220) {
            throw new Error(`Insufficient SPY data for 220-day SMA (need 220, got ${spyAdjClosePrices.length}).`);
        }
        const sum220 = spyAdjClosePrices.slice(-220).reduce((acc, price) => acc + price, 0);
        const sma220 = sum220 / 220;
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";

        // Calculate 21-day Volatility
        if (spyAdjClosePrices.length < 22) {
            throw new Error(`Insufficient SPY data for 21-day volatility (need 22, got ${spyAdjClosePrices.length}).`);
        }
        const relevantPricesForVol = spyAdjClosePrices.slice(-22);
        const spyDailyReturns = [];
        for (let i = 1; i < relevantPricesForVol.length; i++) {
             if (relevantPricesForVol[i-1] !== 0) {
                 spyDailyReturns.push(relevantPricesForVol[i] / relevantPricesForVol[i - 1] - 1);
             } else {
                 spyDailyReturns.push(0);
             }
        }
         if (spyDailyReturns.length !== 21) {
              logDebug(`Warning (standalone): Calculated ${spyDailyReturns.length} daily returns instead of 21.`);
              if(spyDailyReturns.length === 0) throw new Error("Could not calculate any daily returns for volatility (standalone).");
         }
        const meanReturn = spyDailyReturns.reduce((acc, r) => acc + r, 0) / spyDailyReturns.length;
        const variance = spyDailyReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / spyDailyReturns.length;
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = dailyVolatility * Math.sqrt(252) * 100;

        // Treasury (^IRX) Data Processing
        const treasuryResult = treasuryResponse.data?.chart?.result?.[0];
        if (!treasuryResult?.indicators?.quote?.[0]?.close || !treasuryResult?.timestamp) {
            throw new Error("Invalid or incomplete Treasury (^IRX) data structure from Yahoo Finance.");
        }
        const treasuryRates = treasuryResult.indicators.quote[0].close;
        const treasuryTimestamps = treasuryResult.timestamp;
        const validTreasuryData = treasuryTimestamps
            .map((ts, i) => ({ timestamp: ts, rate: treasuryRates[i] }))
            .filter(item => item.timestamp != null && typeof item.rate === 'number')
            .sort((a, b) => a.timestamp - b.timestamp);

        if (validTreasuryData.length === 0) {
            throw new Error("No valid Treasury rate data points found after filtering.");
        }
        const latestTreasuryEntry = validTreasuryData[validTreasuryData.length - 1];
        const currentTreasuryRate = latestTreasuryEntry.rate;
        const lastTimestamp = latestTreasuryEntry.timestamp;

        // Find rate ~30 days ago
        const thirtyDaysInMillis = 30 * 24 * 60 * 60 * 1000;
        const targetTimestampRough = (lastTimestamp * 1000) - thirtyDaysInMillis;
        let oneMonthAgoEntry = null;
        for (let i = validTreasuryData.length - 2; i >= 0; i--) {
             const entryTimestampMillis = validTreasuryData[i].timestamp * 1000;
             if (entryTimestampMillis <= targetTimestampRough) {
                 oneMonthAgoEntry = validTreasuryData[i];
                 break;
             }
         }
         if (!oneMonthAgoEntry && validTreasuryData.length > 0) {
              oneMonthAgoEntry = validTreasuryData[0];
              logDebug("Could not find Treasury rate ~30 days ago (standalone), using oldest available point.");
         } else if (!oneMonthAgoEntry) {
              throw new Error("Cannot determine Treasury rate from one month ago (no valid historical data found - standalone).")
         }
        const oneMonthAgoTreasuryRate = oneMonthAgoEntry.rate;
        const treasuryRateChange = currentTreasuryRate - oneMonthAgoTreasuryRate;
        const isTreasuryFalling = treasuryRateChange < -0.0001;

        // Return data suitable for API response (can be formatted or raw numbers)
        // Here, returning mostly raw numbers and calculated values
        return {
            spy: spyPrice,
            sma220: sma220,
            spyStatus: spyStatus, // String
            volatility: annualizedVolatility,
            treasuryRate: currentTreasuryRate,
            isTreasuryFalling: isTreasuryFalling, // Boolean
            treasuryRateChange: treasuryRateChange,
            // Add timestamps for context if needed by the API consumer
            lastSpyTimestamp: spyResult.timestamp?.slice(-1)[0],
            lastTreasuryTimestamp: lastTimestamp,
            monthAgoTreasuryTimestamp: oneMonthAgoEntry?.timestamp
        };

    } catch (error) {
        console.error("[ERROR] fetchCheckFinancialData (standalone) failed:", error.response?.data || error.message);
        const errorMessage = error.response?.data?.chart?.error?.description || error.message || "An unknown error occurred";
        throw new Error(`Failed to fetch or process MFEA data (standalone): ${errorMessage}`);
    }
}

async function fetchTickerFinancialData(ticker, range) {
    logDebug(`Initiating fetchTickerFinancialData (standalone) for ${ticker}, range ${range}...`);
    const rangeOptions = {
        '1d': { range: '1d', interval: '5m' },
        '1mo': { range: '1mo', interval: '90m' },
        '1y': { range: '1y', interval: '1d' },
        '3y': { range: '3y', interval: '1wk' },
        '10y': { range: '10y', interval: '1mo' },
    };

    const selectedRange = rangeOptions[range] ? range : '1d';
    const { range: yahooRange, interval } = rangeOptions[selectedRange];
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`;
    logDebug(`Fetching URL (standalone): ${url}`);

    try {
        const response = await axios.get(url, { timeout: 10000 });
        const result = response.data?.chart?.result?.[0];
        if (!result?.meta?.regularMarketPrice || !result?.timestamp || !result?.indicators) {
             if (response.data?.chart?.error?.description) {
                 throw new Error(`Yahoo Finance Error: ${response.data.chart.error.description}`);
             }
            throw new Error("Invalid or incomplete data structure received from Yahoo Finance.");
        }

        const currentPrice = parseFloat(result.meta.regularMarketPrice);
        const timestamps = result.timestamp;
        let prices = [];
        if (result.indicators.adjclose?.[0]?.adjclose?.length > 0) {
            prices = result.indicators.adjclose[0].adjclose;
        } else if (result.indicators.quote?.[0]?.close?.length > 0) {
            prices = result.indicators.quote[0].close;
        } else {
            throw new Error("Could not find valid price data (adjclose or close) in the response.");
        }

        const validDataPoints = timestamps
            .map((ts, i) => ({ timestamp: ts, price: prices[i] }))
            .filter(dp => dp.timestamp != null && typeof dp.price === 'number')
            .sort((a, b) => a.timestamp - b.timestamp);

        if (validDataPoints.length === 0) {
            throw new Error("No valid historical data points found after filtering.");
        }

        // Prepare data: Can return raw points or formatted labels depending on API needs
        const historicalData = validDataPoints.map(dp => {
             // Simple structure for API: timestamp and price
             return {
                 timestamp: dp.timestamp, // Keep original timestamp
                 price: dp.price
             };
         });
        /* // Alternative: Format dates like in index.js if consumer needs labels
        const historicalDataFormatted = validDataPoints.map(dp => {
             // ... (date formatting logic from index.js) ...
             return { date: dateLabel, price: dp.price };
        });
        */

        return {
            ticker: ticker.toUpperCase(),
            currentPrice: currentPrice,
            historicalData: historicalData, // Using raw timestamp/price pairs here
            selectedRange: selectedRange.toUpperCase(),
            yahooInterval: interval, // Provide interval used
            lastTimestamp: validDataPoints.slice(-1)[0]?.timestamp
        };

    } catch (error) {
        console.error(`[ERROR] fetchTickerFinancialData (standalone) for ${ticker} failed:`, error.response?.data || error.message);
        const errorMessage = error.response?.data?.chart?.error?.description || error.message || "An unknown error occurred";
        throw new Error(`Failed to fetch data for ${ticker.toUpperCase()} (standalone): ${errorMessage}`);
    }
}


// --- Standalone Handler (Example for API endpoint) ---
// This assumes fetchdata.js is deployed as its own Vercel function
// or similar API endpoint.

module.exports = async (req, res) => {
    // Use query parameters for API endpoint
    const { type, ticker, range } = req.query;
    logDebug(`fetchdata.js handler invoked: type=${type}, ticker=${ticker}, range=${range}`);

    res.setHeader('Content-Type', 'application/json');

    if (type === 'check') {
        try {
            const financialData = await fetchCheckFinancialData();
             // Format numbers for JSON response consistency if desired
             const formattedData = {
                 ...financialData,
                 spy: financialData.spy.toFixed(2),
                 sma220: financialData.sma220.toFixed(2),
                 volatility: financialData.volatility.toFixed(2),
                 treasuryRate: financialData.treasuryRate.toFixed(3),
                 treasuryRateChange: financialData.treasuryRateChange.toFixed(3)
             };
             res.status(200).json(formattedData);
        } catch (error) {
            console.error("[API ERROR /check]", error);
            res.status(500).json({ error: error.message || "Failed to fetch check data." });
        }
    } else if (type === 'ticker' && ticker && range) {
        try {
            const tickerData = await fetchTickerFinancialData(ticker, range);
             // Format numbers for JSON response
              const formattedData = {
                  ...tickerData,
                  currentPrice: tickerData.currentPrice.toFixed(2),
                  historicalData: tickerData.historicalData.map(dp => ({
                      timestamp: dp.timestamp,
                      price: dp.price.toFixed(2) // Format price within historical data
                  }))
              };
              res.status(200).json(formattedData);
        } catch (error) {
            console.error("[API ERROR /ticker]", error);
            res.status(500).json({ error: error.message || `Failed to fetch ticker data for ${ticker}.` });
        }
    } else {
        res.status(400).json({ error: "Invalid request. Use ?type=check or ?type=ticker&ticker=SYMBOL&range=RANGE" });
    }
};
