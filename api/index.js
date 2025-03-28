// index.js - Using fixed 21 TRADING DAY lookback for Treasury change, includes MFEA vs Recommendation with Bands
"use strict";

const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

// Define your commands
const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Display MFEA analysis status with recommendation bands." };
const TICKER_COMMAND = {
    name: "ticker",
    description: "Fetch and display financial data for a specific ticker and timeframe.",
    options: [
        {
            name: "symbol",
            type: 3, // STRING type
            description: "The stock ticker symbol (e.g., AAPL, GOOGL)",
            required: true,
        },
        {
            name: "timeframe",
            type: 3, // STRING type
            description: "The timeframe for the chart (1d, 1mo, 1y, 3y, 10y)",
            required: true,
            choices: [
                { name: "1 Day", value: "1d" },
                { name: "1 Month", value: "1mo" },
                { name: "1 Year", value: "1y" },
                { name: "3 Years", value: "3y" },
                { name: "10 Years", value: "10y" },
            ],
        },
    ],
};

// Helper function to log debug messages
function logDebug(message) {
    console.log(`[DEBUG] ${message}`);
}

// --- NEW: Helper function for the core allocation logic ---
function calculateAllocation(isSpyAboveSma, isVolBelow14, isVolBelow24, isTreasuryFalling) {
    if (isSpyAboveSma) {
        if (isVolBelow14) { // Vol < 14% threshold
            return { category: "Risk On", allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)" };
        } else if (isVolBelow24) { // 14% <= Vol < 24% threshold
            return { category: "Risk Mid", allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)" };
        } else { // Vol >= 24% threshold
            if (isTreasuryFalling) {
                return { category: "Risk Alt", allocation: "25% UPRO + 75% ZROZ (long‑duration zero‑coupon bonds) or 1.5×(50% SPY + 50% ZROZ)" };
            } else {
                return { category: "Risk Off", allocation: "100% SPY or 1×(100% SPY)" };
            }
        }
    } else { // SPY <= SMA threshold
        if (isTreasuryFalling) {
            return { category: "Risk Alt", allocation: "25% UPRO + 75% ZROZ (long‑duration zero‑coupon bonds) or 1.5×(50% SPY + 50% ZROZ)" };
        } else {
            return { category: "Risk Off", allocation: "100% SPY or 1×(100% SPY)" };
        }
    }
}

// --- REVISED: Function to determine both MFEA and Recommended Allocations ---
function determineAllocations(data) {
    const spy = parseFloat(data.spy);
    const sma220 = parseFloat(data.sma220);
    const volatility = parseFloat(data.volatility);
    const treasuryChange = parseFloat(data.treasuryRateChange);

    // --- MFEA Strict Threshold Checks ---
    const isSpyAboveSmaMFEA = spy > sma220;
    const isVolBelow14MFEA = volatility < 14;
    const isVolBelow24MFEA = volatility < 24;
    const isTreasuryFallingMFEA = treasuryChange < -0.0001; // Original strict threshold

    // --- Recommendation Band Thresholds & Checks ---
    const smaBandPercent = 0.01; // 1%
    const volBandAbsolute = 1.0; // 1% absolute for volatility bands
    const treasuryRecThreshold = -0.005; // Recommendation requires a larger drop (-0.5%)

    const smaLowerBand = sma220 * (1 - smaBandPercent);
    const smaUpperBand = sma220 * (1 + smaBandPercent);
    const vol14LowerBand = 14 - volBandAbsolute; // 13%
    const vol14UpperBand = 14 + volBandAbsolute; // 15%
    const vol24LowerBand = 24 - volBandAbsolute; // 23%
    const vol24UpperBand = 24 + volBandAbsolute; // 25%

    // Determine effective states for Recommendation logic
    // If value is WITHIN the band, the recommendation logic uses the MFEA state for that factor.
    let isSpyEffectivelyAboveSmaRec;
    if (spy > smaUpperBand) isSpyEffectivelyAboveSmaRec = true;          // Clearly above band
    else if (spy < smaLowerBand) isSpyEffectivelyAboveSmaRec = false;     // Clearly below band
    else isSpyEffectivelyAboveSmaRec = isSpyAboveSmaMFEA;                 // Within band, use MFEA state

    let isVolEffectivelyBelow14Rec;
    if (volatility < vol14LowerBand) isVolEffectivelyBelow14Rec = true;   // Clearly below 13%
    else if (volatility > vol14UpperBand) isVolEffectivelyBelow14Rec = false; // Clearly above 15%
    else isVolEffectivelyBelow14Rec = isVolBelow14MFEA;                   // Within 13-15% band, use MFEA state

    let isVolEffectivelyBelow24Rec;
    if (volatility < vol24LowerBand) isVolEffectivelyBelow24Rec = true;   // Clearly below 23%
    else if (volatility > vol24UpperBand) isVolEffectivelyBelow24Rec = false; // Clearly above 25%
    else isVolEffectivelyBelow24Rec = isVolBelow24MFEA;                   // Within 23-25% band, use MFEA state

    // Treasury Recommendation uses a stricter threshold
    const isTreasuryFallingRec = treasuryChange < treasuryRecThreshold;

    logDebug(`MFEA Checks: SPY>${sma220.toFixed(2)}? ${isSpyAboveSmaMFEA}, Vol<14? ${isVolBelow14MFEA}, Vol<24? ${isVolBelow24MFEA}, TrsFall? ${isTreasuryFallingMFEA}`);
    logDebug(`REC Checks (Effective): SPY>SMA? ${isSpyEffectivelyAboveSmaRec} (Band ${smaLowerBand.toFixed(2)}-${smaUpperBand.toFixed(2)}), Vol<14? ${isVolEffectivelyBelow14Rec} (Band ${vol14LowerBand}-${vol14UpperBand}), Vol<24? ${isVolEffectivelyBelow24Rec} (Band ${vol24LowerBand}-${vol24UpperBand}), TrsFall? ${isTreasuryFallingRec} (Thresh ${treasuryRecThreshold})`);

    // Calculate MFEA Allocation (using strict checks)
    let mfeaResult = calculateAllocation(isSpyAboveSmaMFEA, isVolBelow14MFEA, isVolBelow24MFEA, isTreasuryFallingMFEA);

    // Calculate Recommended Allocation (using effective band-aware checks)
    let recommendedResult = calculateAllocation(isSpyEffectivelyAboveSmaRec, isVolEffectivelyBelow14Rec, isVolEffectivelyBelow24Rec, isTreasuryFallingRec);

    // Store Band Info for Display
     const bandInfo = {
         spyValue: spy.toFixed(2),
         smaValue: sma220.toFixed(2),
         smaLower: smaLowerBand.toFixed(2),
         smaUpper: smaUpperBand.toFixed(2),
         isSpyInSmaBand: spy >= smaLowerBand && spy <= smaUpperBand,

         volValue: volatility.toFixed(2),
         vol14Lower: vol14LowerBand.toFixed(2),
         vol14Upper: vol14UpperBand.toFixed(2),
         isVolIn14Band: volatility >= vol14LowerBand && volatility <= vol14UpperBand,
         vol24Lower: vol24LowerBand.toFixed(2),
         vol24Upper: vol24UpperBand.toFixed(2),
         isVolIn24Band: volatility >= vol24LowerBand && volatility <= vol24UpperBand,

         trsChange: treasuryChange.toFixed(4), // Show more precision
         trsMFEAThreshold: -0.0001,
         trsRecThreshold: treasuryRecThreshold,
         isTreasuryInBand: treasuryChange >= treasuryRecThreshold && treasuryChange < -0.0001 // Between Rec and MFEA thresholds
     };


    return {
        mfeaCategory: mfeaResult.category,
        mfeaAllocation: mfeaResult.allocation,
        recommendedCategory: recommendedResult.category,
        recommendedAllocation: recommendedResult.allocation,
        bandInfo: bandInfo
    };
}

// Helper function to fetch financial data for /check command
async function fetchCheckFinancialData() {
    try {
        logDebug("Fetching data for /check command...");
        const [spySMAResponse, treasuryResponse, spyVolResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"), // Use 50d to ensure enough history for 21d lookback
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"), // Use 40d for 21-day volatility calc
        ]);

        // --- SPY Price and SMA ---
        const spyData = spySMAResponse.data;
        if (!spyData.chart?.result?.[0]?.meta?.regularMarketPrice || !spyData.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose) {
             throw new Error("Invalid or incomplete SPY data structure for SMA calculation.");
        }
        const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;
        const spyAdjClosePrices = spyData.chart.result[0].indicators.adjclose[0].adjclose;

        const validSpyPrices = spyAdjClosePrices.filter(p => typeof p === 'number' && p !== null).slice(-220); // Filter nulls/non-numbers and take latest 220
        if (validSpyPrices.length < 220) {
             logDebug(`Warning: Only found ${validSpyPrices.length} valid SPY prices in the last 220 days for SMA. Calculation will use available points.`);
            if (validSpyPrices.length === 0) throw new Error("No valid SPY prices found in the last 220 days for SMA.");
        }
        const sum220 = validSpyPrices.reduce((acc, price) => acc + price, 0);
        const sma220 = (sum220 / validSpyPrices.length); // Divide by actual number of valid points used
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";
        logDebug(`SPY Price: ${spyPrice}, SMA220: ${sma220.toFixed(2)} (from ${validSpyPrices.length} points), Status: ${spyStatus}`);


        // --- Treasury Data Processing (21 Trading Day Lookback) ---
        const treasuryData = treasuryResponse.data.chart.result[0];
         if (!treasuryData || !treasuryData.indicators?.quote?.[0]?.close || !treasuryData.timestamp) {
             throw new Error("Invalid or incomplete Treasury (^IRX) data structure from Yahoo Finance.");
         }
        const treasuryRatesRaw = treasuryData.indicators.quote[0].close;
        const treasuryTimestampsRaw = treasuryData.timestamp;

        // Combine, filter nulls/non-numbers, sort chronologically
        const validTreasuryData = treasuryTimestampsRaw
            .map((ts, i) => ({ timestamp: ts, rate: treasuryRatesRaw[i] }))
            .filter(item => item.timestamp != null && typeof item.rate === 'number' && item.rate !== null)
            .sort((a, b) => a.timestamp - b.timestamp);

        // We need at least 22 data points (latest + 21 days prior)
        if (validTreasuryData.length < 22) {
            throw new Error(`Not enough valid Treasury data points for 21 trading day lookback (need at least 22, got ${validTreasuryData.length}).`);
        }

        const lastIndex = validTreasuryData.length - 1;
        const latestTreasuryEntry = validTreasuryData[lastIndex];
        const currentTreasuryRateValue = latestTreasuryEntry.rate;
        const targetIndex = lastIndex - 21; // Index for 21 trading days ago
        const oneMonthAgoEntry = validTreasuryData[targetIndex];
        const oneMonthAgoTreasuryRateValue = oneMonthAgoEntry.rate;

        // Calculate change
        const treasuryRateChangeValue = currentTreasuryRateValue - oneMonthAgoTreasuryRateValue;
        logDebug(`Treasury Rate: Current=${currentTreasuryRateValue.toFixed(3)}, 21d Ago=${oneMonthAgoTreasuryRateValue.toFixed(3)}, Change=${treasuryRateChangeValue.toFixed(4)}`);


        // --- Volatility Calculation (21 Trading Days / 20 Returns) ---
        const spyVolData = spyVolResponse.data;
         if (!spyVolData.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose) {
             throw new Error("Invalid or incomplete SPY data structure for volatility calculation.");
         }
        const spyVolAdjClose = spyVolData.chart.result[0].indicators.adjclose[0].adjclose;

         // Need at least 21 valid prices to calculate 20 returns
        const validVolPrices = spyVolAdjClose.filter(p => typeof p === 'number' && p !== null);
        if (validVolPrices.length < 21) {
             throw new Error(`Not enough valid SPY data points for 21-day volatility calculation (need >= 21, got ${validVolPrices.length}).`);
        }

        // Calculate returns based on the *most recent* valid prices
        const relevantVolPrices = validVolPrices.slice(-(21)); // Get the last 21 valid prices
        const spyVolDailyReturns = relevantVolPrices.slice(1).map((price, idx) => {
            const prevPrice = relevantVolPrices[idx]; // Use prices from the filtered & sliced array
            // Basic check for division by zero
            return prevPrice === 0 ? 0 : (price / prevPrice - 1);
        });

        // We should now have exactly 20 returns
        if (spyVolDailyReturns.length !== 20) {
             // This indicates an issue with the slicing or filtering logic if it occurs
             throw new Error(`Incorrect number of daily returns for 21-day vol calc (expected 20, got ${spyVolDailyReturns.length}).`);
        }

        const returnsForVol = spyVolDailyReturns; // Use all 20 returns

        const meanReturn = returnsForVol.reduce((acc, r) => acc + r, 0) / returnsForVol.length;
        // Use N for population standard deviation (common for financial vol)
        const variance = returnsForVol.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / returnsForVol.length;
        const dailyVolatility = Math.sqrt(variance);
        // Annualize using 252 trading days
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100);
        logDebug(`Calculated Annualized Volatility (${returnsForVol.length} returns used): ${annualizedVolatility.toFixed(2)}%`);

        // --- Return results formatted as strings ---
        return {
            spy: parseFloat(spyPrice).toFixed(2),
            sma220: sma220.toFixed(2),
            spyStatus: spyStatus, // Basic status relative to exact SMA
            volatility: annualizedVolatility.toFixed(2),
            treasuryRate: currentTreasuryRateValue.toFixed(3),
            treasuryRateChange: treasuryRateChangeValue.toFixed(4), // Return change with more precision
        };
    } catch (error) {
        console.error("Error fetching financial data for /check:", error);
        if (error.response) {
            console.error("Axios Error Data:", error.response.data);
            console.error("Axios Error Status:", error.response.status);
        }
        console.error("Caught Error Message:", error.message);
        // Re-throw with specific message if possible
        throw new Error(`Failed to fetch or process financial data: ${error.message}`);
    }
}


// Helper function to fetch financial data for /ticker command
async function fetchTickerFinancialData(ticker, range) {
    try {
        logDebug(`Fetching data for /ticker ${ticker}, range ${range}`);
        const rangeOptions = {
            '1d': { range: '1d', interval: '1m' },
            '1mo': { range: '1mo', interval: '5m' }, // Adjusted interval for 1mo
            '1y': { range: '1y', interval: '1d' },
            '3y': { range: '3y', interval: '1wk' },
            '10y': { range: '10y', interval: '1mo' },
        };

        const selectedRange = rangeOptions[range] ? range : '1d'; // Default to '1d' if invalid range provided
        const { range: yahooRange, interval } = rangeOptions[selectedRange];

        logDebug(`Requesting Yahoo: ticker=${ticker}, interval=${interval}, range=${yahooRange}`);
        const tickerResponse = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`
        );
        const tickerData = tickerResponse.data;

        // Validate response structure
        if (
            !tickerData.chart?.result?.[0] ||
            tickerData.chart.result[0].meta?.regularMarketPrice === undefined || // Check specifically for undefined, as 0 is valid
            !tickerData.chart.result[0].timestamp
        ) {
            // Check for common error messages from Yahoo
             if (tickerData.chart?.error?.description) {
                 throw new Error(`Yahoo Finance error: ${tickerData.chart.error.description}`);
             }
            throw new Error("Invalid ticker symbol or data unavailable from Yahoo Finance.");
        }

        const meta = tickerData.chart.result[0].meta;
        const currentPrice = parseFloat(meta.regularMarketPrice).toFixed(2);
        const timestamps = tickerData.chart.result[0].timestamp;
        let prices = [];

        // Find the appropriate price array (adjclose is preferred, fallback to close)
        const indicators = tickerData.chart.result[0].indicators;
        if (indicators?.adjclose?.[0]?.adjclose) {
            prices = indicators.adjclose[0].adjclose;
             logDebug("Using adjclose prices.");
        } else if (indicators?.quote?.[0]?.close) {
            prices = indicators.quote[0].close;
             logDebug("Using close prices (adjclose not available).");
        } else {
            throw new Error("Price data (adjclose or close) is unavailable in the response.");
        }

        if (!timestamps || !prices || timestamps.length !== prices.length) {
            throw new Error(`Inconsistent historical data: ${timestamps?.length || 0} timestamps vs ${prices?.length || 0} prices.`);
        }

        // Combine timestamps and prices, filter out entries with null prices
        const validHistoricalEntries = timestamps
            .map((timestamp, index) => ({ timestamp, price: prices[index] }))
            .filter(entry => typeof entry.price === 'number' && entry.price !== null && !isNaN(entry.price));

         logDebug(`Fetched ${timestamps.length} raw points, ${validHistoricalEntries.length} valid points used.`);

        // Format dates based on range
        const historicalData = validHistoricalEntries.map(entry => {
            const dateObj = new Date(entry.timestamp * 1000);
            let dateLabel = '';
            const options = { timeZone: 'America/New_York' }; // Display in market time (ET)

            if (selectedRange === '1d') {
                options.hour = '2-digit'; options.minute = '2-digit'; options.hour12 = true;
                dateLabel = dateObj.toLocaleString('en-US', options); // Just time for 1d
            } else if (selectedRange === '1mo') {
                 options.month = 'short'; options.day = 'numeric'; options.hour = '2-digit'; options.minute = '2-digit'; options.hour12 = true;
                 dateLabel = dateObj.toLocaleString('en-US', options); // Date and time for 1mo
            } else {
                options.month = 'short'; options.day = 'numeric'; options.year = 'numeric';
                dateLabel = dateObj.toLocaleDateString('en-US', options); // Just date for longer ranges
            }

            return {
                date: dateLabel,
                price: entry.price, // Keep as number for potential aggregation
            };
        });


        // Aggregate for 10y (monthly average) - Apply aggregation *before* final formatting
        let finalData = historicalData;
        if (selectedRange === '10y') {
             logDebug("Aggregating 10y data by month...");
             if (historicalData.length > 0) {
                 const monthlyMap = {};
                 historicalData.forEach(entry => {
                     // Need the timestamp to reliably get month/year
                     const entryTimestamp = validHistoricalEntries.find(vh => vh.price === entry.price)?.timestamp; // Find original timestamp (inefficient but works for moderate data)
                     // A better way would be to pass timestamp through the mapping above
                     if (entryTimestamp) {
                        const dateObj = new Date(entryTimestamp * 1000);
                         if (dateObj && !isNaN(dateObj.getTime())) {
                             const monthKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
                             if (!monthlyMap[monthKey]) {
                                  const monthLabel = dateObj.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'America/New_York' });
                                 monthlyMap[monthKey] = { sum: 0, count: 0, label: monthLabel };
                             }
                             monthlyMap[monthKey].sum += entry.price; // price is number here
                             monthlyMap[monthKey].count += 1;
                         }
                     } else {
                         logDebug(`Could not find original timestamp for entry with price ${entry.price} during 10y aggregation.`);
                     }
                 });

                 // Calculate average and create new aggregated array
                 finalData = Object.keys(monthlyMap).sort().map(monthKey => {
                     const avgPrice = monthlyMap[monthKey].sum / monthlyMap[monthKey].count;
                     return {
                         date: monthlyMap[monthKey].label,
                         price: avgPrice, // Keep as number for chart
                     };
                 });
                 logDebug(`Aggregated into ${finalData.length} monthly points.`);
             } else {
                 finalData = []; // No data to aggregate
             }
        }

        // Return final structure with prices formatted for display where needed, but numbers for chart data
        return {
            ticker: ticker.toUpperCase(),
            currentPrice: `$${currentPrice}`,
            // Chart data needs numbers
            historicalData: finalData.map(entry => ({ ...entry, price: entry.price })), // Ensure price is number
            selectedRange: selectedRange.toUpperCase(), // Display the actual range used
            dataSource: meta.exchangeName || 'Yahoo Finance', // Get source if available
            currency: meta.currency || 'USD',
        };
    } catch (error) {
        console.error(`Error fetching financial data for ${ticker} (${range}):`, error);
         // Log more details if available
         if (error.response) {
             console.error("Axios Error Data:", error.response.data);
             console.error("Axios Error Status:", error.response.status);
         }
         console.error("Caught Error Message:", error.message);
        // Re-throw the specific error message
        throw new Error(error.message || `Failed to fetch financial data for ${ticker}.`);
    }
}

// Main handler
module.exports = async (req, res) => {
    logDebug("Received a new request");

    // --- Request Validation (Signature, Timestamp, Method) ---
    if (req.method !== "POST") {
        logDebug("Invalid method, returning 405");
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    const publicKey = process.env.PUBLIC_KEY;

    if (!signature || !timestamp || !publicKey) {
        console.error("[ERROR] Missing signature, timestamp, or PUBLIC_KEY env var.");
        return res.status(401).json({ error: "Bad request signature or missing config" });
    }

    let rawBody;
    try {
        rawBody = await getRawBody(req, { encoding: "utf-8" });
    } catch (error) {
        console.error("[ERROR] Failed to get raw body:", error);
        return res.status(400).json({ error: "Invalid request body" });
    }

    const isValidRequest = verifyKey(rawBody, signature, timestamp, publicKey);
    if (!isValidRequest) {
        console.error("[ERROR] Invalid request signature");
        return res.status(401).json({ error: "Bad request signature" });
    }
    logDebug("Request signature verified");

    // --- Parse Request Body ---
    let message;
    try {
        message = JSON.parse(rawBody);
    } catch (error) {
        console.error("[ERROR] Failed to parse JSON:", error);
        return res.status(400).json({ error: "Invalid JSON format" });
    }

    logDebug(`Interaction Type: ${message.type}`);

    // --- Interaction Handling ---
    // 1. PING Interaction
    if (message.type === InteractionType.PING) {
        try {
            logDebug("Handling PING");
            return res.status(200).json({ type: InteractionResponseType.PONG });
        } catch (error) {
            console.error("[ERROR] Failed to handle PING:", error);
            // PONG response is crucial, avoid sending error JSON if possible
            return res.status(500).send("Internal Server Error");
        }
    }

    // 2. APPLICATION_COMMAND Interaction
    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name.toLowerCase();
        const { application_id, token } = message; // Needed for follow-up messages
        const followupUrl = `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`;

        logDebug(`Handling command: ${commandName}`);

        switch (commandName) {
            case HI_COMMAND.name.toLowerCase():
                try {
                    logDebug("Executing /hi command");
                    return res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "hii <3" },
                    });
                } catch (error) {
                    console.error("[ERROR] Failed to execute /hi command:", error);
                    return res.status(500).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "⚠️ An error occurred while processing your request." }
                    });
                }

            case CHECK_COMMAND.name.toLowerCase():
                // Defer response for potentially longer fetch/calc time
                 try {
                     logDebug("Deferring response for /check");
                     res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
                 } catch(deferError) {
                      console.error("[ERROR] Failed initial deferral for /check:", deferError);
                      // Cannot easily recover if initial response fails
                      return; // Exit cleanly if possible
                 }

                try {
                    logDebug("Fetching data for /check");
                    const financialData = await fetchCheckFinancialData();

                    logDebug("Determining allocations for /check");
                    const {
                        mfeaCategory,
                        mfeaAllocation,
                        recommendedCategory,
                        recommendedAllocation,
                        bandInfo
                    } = determineAllocations(financialData);

                    // Treasury Rate Trend Display Logic (Based on strict MFEA check for display consistency)
                    let treasuryRateTrendValue = "";
                    const treasuryRateTimeframe = "last 21 trading days";
                    const changeNumMFEA = parseFloat(financialData.treasuryRateChange);
                    const changePercent = (changeNumMFEA * 100).toFixed(2); // Represent change as % points

                    if (changeNumMFEA < -0.0001) {
                        treasuryRateTrendValue = `⬇️ Falling (${changePercent}%)`;
                    } else if (changeNumMFEA > 0.0001) {
                         treasuryRateTrendValue = `⬆️ Rising (+${changePercent}%)`;
                    } else {
                        treasuryRateTrendValue = `↔️ Stable (${changePercent}%)`;
                    }
                     treasuryRateTrendValue += `\nover ${treasuryRateTimeframe}`;


                    // Band Influence Description
                    let bandInfluenceDescription = "";
                    const influences = [];
                     let recommendationDiffers = mfeaAllocation !== recommendedAllocation;

                    if (bandInfo.isSpyInSmaBand) {
                        influences.push(`SPY ($${bandInfo.spyValue}) is within ±1% SMA band ($${bandInfo.smaLower} - $${bandInfo.smaUpper}).`);
                    }
                    if (bandInfo.isVolIn14Band) {
                        influences.push(`Volatility (${bandInfo.volValue}%) is within ${bandInfo.vol14Lower}% - ${bandInfo.vol14Upper}% band.`);
                    } else if (bandInfo.isVolIn24Band) { // Only show one vol band influence if applicable
                        influences.push(`Volatility (${bandInfo.volValue}%) is within ${bandInfo.vol24Lower}% - ${bandInfo.vol24Upper}% band.`);
                    }
                    if (bandInfo.isTreasuryInBand) {
                         influences.push(`Treasury change (${(bandInfo.trsChange*100).toFixed(2)}%) is between Rec. threshold (${(bandInfo.trsRecThreshold*100).toFixed(2)}%) and MFEA threshold (${(bandInfo.trsMFEAThreshold*100).toFixed(2)}%).`);
                    }
                     // Check if Treasury crossed the recommendation threshold *without* being in the MFEA band - this would cause a difference if other factors are stable
                     else if (recommendationDiffers && !bandInfo.isSpyInSmaBand && !bandInfo.isVolIn14Band && !bandInfo.isVolIn24Band) {
                        if (bandInfo.trsChange < bandInfo.trsRecThreshold) {
                           influences.push(`Treasury change (${(bandInfo.trsChange*100).toFixed(2)}%) crossed the Recommendation threshold (${(bandInfo.trsRecThreshold*100).toFixed(2)}%).`);
                        }
                        // Add logic here if needed for treasury rising crossing a band threshold if one existed
                     }


                    if (!recommendationDiffers) {
                        if (influences.length > 0) {
                            bandInfluenceDescription = "Factors near thresholds (within bands):\n• " + influences.join("\n• ") + "\n*Recommendation aligns with MFEA as no factors decisively crossed band boundaries.*";
                        } else {
                            bandInfluenceDescription = "All factors are clear of rebalancing bands. Recommendation aligns with MFEA.";
                        }
                    } else {
                         bandInfluenceDescription = "Factors influencing difference from MFEA:\n• " + influences.join("\n• ") + "\n*Recommendation differs due to factor(s) crossing band boundaries.*";
                    }

                    // --- Construct Embed ---
                    const checkEmbed = {
                        title: "MFEA Analysis & Recommendation",
                        color: 3447003, // Discord Blue
                        fields: [
                            // Market Data
                            { name: "SPY Price", value: `$${financialData.spy}`, inline: true },
                            { name: "220d SMA", value: `$${financialData.sma220}`, inline: true },
                            { name: "SPY vs SMA", value: `${financialData.spyStatus}`, inline: true },
                            { name: "Volatility (Ann.)", value: `${financialData.volatility}%`, inline: true },
                            { name: "3M Treas Rate", value: `${financialData.treasuryRate}%`, inline: true },
                            { name: "Treas Rate Trend", value: treasuryRateTrendValue, inline: true },

                            // MFEA Strict Calculation
                            { name: "📊 MFEA Category", value: mfeaCategory, inline: false }, // Start new row
                            { name: "📈 MFEA Allocation", value: `**${mfeaAllocation}**`, inline: false },

                            // Recommendation with Bands
                            { name: "💡 Recommended Allocation", value: `**${recommendedAllocation}**`, inline: false },

                            // Band Explanation
                            { name: "⚙️ Band Influence Analysis", value: bandInfluenceDescription, inline: false },
                        ],
                        footer: {
                            text: "MFEA = Strict Model | Recommendation includes ±1% SMA/Vol bands & stricter Treasury threshold",
                        },
                        timestamp: new Date().toISOString(),
                    };

                    // --- Send Follow-up ---
                     logDebug("Sending followup message for /check");
                     await axios.patch(followupUrl, { embeds: [checkEmbed] });
                     logDebug("/check command successfully processed and sent.");

                } catch (error) {
                    console.error("[ERROR] Failed to process /check command after deferral:", error);
                    // Try to send error via followup
                    try {
                        await axios.patch(followupUrl, {
                            content: `⚠️ Error processing MFEA analysis: ${error.message || 'An internal error occurred.'}`
                        });
                    } catch (followupError) {
                        console.error("[ERROR] Failed to send error followup message for /check:", followupError);
                    }
                }
                return; // Exit after handling /check

            case TICKER_COMMAND.name.toLowerCase():
                // Defer response
                 try {
                     logDebug("Deferring response for /ticker");
                     res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
                 } catch (deferError) {
                     console.error("[ERROR] Failed initial deferral for /ticker:", deferError);
                     return;
                 }

                try {
                    const options = message.data.options;
                    const tickerOption = options.find(option => option.name === "symbol");
                    const timeframeOption = options.find(option => option.name === "timeframe");
                    const ticker = tickerOption ? tickerOption.value.toUpperCase() : null;
                    const timeframe = timeframeOption ? timeframeOption.value : '1d';

                    if (!ticker) {
                         await axios.patch(followupUrl, { content: "❌ Ticker symbol is required." });
                         return;
                    }
                     logDebug(`Processing /ticker for ${ticker}, timeframe ${timeframe}`);

                    // Fetch data
                    const tickerData = await fetchTickerFinancialData(ticker, timeframe);

                    // Generate Chart URL
                    const chartConfig = {
                        type: 'line',
                        data: {
                            labels: tickerData.historicalData.map(entry => entry.date),
                            datasets: [{
                                label: `${tickerData.ticker} Price (${tickerData.currency})`,
                                data: tickerData.historicalData.map(entry => entry.price), // Use numbers for chart
                                borderColor: '#0070f3',
                                backgroundColor: 'rgba(0, 112, 243, 0.1)',
                                borderWidth: 2,
                                pointRadius: 0, // No dots on line
                                fill: true, // Fill area under line
                                tension: 0.1 // Slight smoothing
                            }]
                        },
                        options: {
                            scales: {
                                x: {
                                    title: { display: true, text: 'Time / Date (ET)', color: '#CCCCCC', font: { size: 12 } },
                                    ticks: { maxTicksLimit: 10, color: '#CCCCCC', maxRotation: 0, minRotation: 0, autoSkip: true }, // Auto skip labels if too crowded
                                    grid: { display: false }
                                },
                                y: {
                                    title: { display: true, text: `Price (${tickerData.currency})`, color: '#CCCCCC', font: { size: 12 } },
                                    ticks: { color: '#CCCCCC', callback: function(value) { return '$' + value.toFixed(2); } }, // Format Y-axis as currency
                                    grid: { color: 'rgba(204, 204, 204, 0.2)', borderDash: [5, 5] }
                                }
                            },
                            plugins: {
                                legend: { display: true, labels: { color: '#CCCCCC', font: { size: 12 } } },
                                tooltip: {
                                    enabled: true, mode: 'index', intersect: false,
                                    callbacks: {
                                        label: function(context) {
                                             const value = parseFloat(context.parsed?.y);
                                             return !isNaN(value) ? ` ${context.dataset.label || ''}: $${value.toFixed(2)}` : 'N/A';
                                        }
                                    }
                                },
                                // Optional: Add QuickChart watermark or branding
                                // quickchart: { // Requires QuickChart Enterprise or custom handling
                                //     watermark: { text: 'Generated by MyBot' }
                                // }
                            },
                            layout: { padding: 10 }, // Add padding
                            backgroundColor: '#36393f', // Discord dark theme background
                            color: '#CCCCCC' // Default text color for chart elements
                        }
                    };
                    const chartConfigEncoded = encodeURIComponent(JSON.stringify(chartConfig));
                    const chartUrl = `https://quickchart.io/chart?c=${chartConfigEncoded}&w=600&h=400&bkg=%2336393f`; // Specify size & background

                    // Construct Embed
                    const tickerEmbed = {
                        title: `${tickerData.ticker} Chart (${tickerData.selectedRange})`,
                        color: 3447003, // Blue
                        fields: [
                            { name: "Current Price", value: `${tickerData.currentPrice} ${tickerData.currency}`, inline: true },
                            { name: "Data Source", value: tickerData.dataSource, inline: true },
                        ],
                        image: { url: chartUrl },
                        footer: { text: `Data from Yahoo Finance via QuickChart.io` },
                        timestamp: new Date().toISOString(),
                    };

                    // Send Follow-up
                    logDebug("Sending followup message for /ticker");
                    await axios.patch(followupUrl, { embeds: [tickerEmbed] });
                    logDebug(`/ticker ${ticker} command successfully processed.`);

                } catch (error) {
                    console.error(`[ERROR] Failed to process /ticker command for ${message.data?.options?.find(o => o.name === 'symbol')?.value}:`, error);
                     try {
                         await axios.patch(followupUrl, {
                             content: `⚠️ Error fetching data for ticker: ${error.message || 'Please check the symbol and try again.'}`
                         });
                     } catch (followupError) {
                         console.error("[ERROR] Failed to send error followup message for /ticker:", followupError);
                     }
                }
                return; // Exit after handling /ticker

            default:
                logDebug(`Unknown command received: ${commandName}`);
                try {
                    return res.status(400).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "⚠️ Unknown command." }
                    });
                } catch (error) {
                     console.error("[ERROR] Failed to send unknown command response:", error);
                     return res.status(500).send("Internal Server Error");
                }
        }
    }

    // Fallback for unknown interaction types
    logDebug(`Unknown interaction type received: ${message.type}`);
    try {
        return res.status(400).json({ error: "Unknown Interaction Type" });
    } catch (error) {
        console.error("[ERROR] Failed to send unknown type response:", error);
        return res.status(500).send("Internal Server Error");
    }
};
