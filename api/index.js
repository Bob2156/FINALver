// index.js - Based on the user's original working code, adding MFEA vs Recommendation bands.
"use strict";

const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

// Define your commands (Unchanged from original)
const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Display MFEA analysis status (strict & recommended)." }; // Updated description
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

// Preset image URL for /ticker command (Test Mode) - Unchanged from original
const PRESET_IMAGE_URL = "https://th.bing.com/th/id/R.aeccf9d26746b036234619be80502098?rik=JZrA%2f9rIOJ3Fxg&riu=http%3a%2f%2fwww.clipartbest.com%2fcliparts%2fbiy%2fE8E%2fbiyE8Er5T.jpeg&ehk=FOPbyrcgKCZzZorMhY69pKoHELUk3FiBPDkgwkqNvis%3d&risl=&pid=ImgRaw&r=0";

// Helper function to log debug messages (Unchanged from original)
function logDebug(message) {
    console.log(`[DEBUG] ${message}`);
}

// --- Original determineRiskCategory function: Used for STRICT MFEA CALCULATION ---
// Renamed slightly for clarity, but logic is IDENTICAL to the original.
function determineStrictMFEACategory(data) {
    const spyValue = parseFloat(data.spy);
    const sma220Value = parseFloat(data.sma220);
    const volatilityValue = parseFloat(data.volatility);
    // Uses the isTreasuryFalling boolean directly from fetched data (based on < -0.0001 threshold)
    const isTreasuryFallingStrict = data.isTreasuryFalling;

    logDebug(`Determining STRICT MFEA category with SPY: ${spyValue}, SMA220: ${sma220Value}, Volatility: ${volatilityValue}%, Is Treasury Falling (Strict): ${isTreasuryFallingStrict}`);

    if (spyValue > sma220Value) {
        if (volatilityValue < 14) {
            return {
                category: "Risk On",
                allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
            };
        } else if (volatilityValue < 24) {
            return {
                category: "Risk Mid",
                allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
            };
        } else { // Volatility >= 24
            if (isTreasuryFallingStrict) {
                return {
                    category: "Risk Alt",
                    allocation: "25% UPRO + 75% ZROZ (long‑duration zero‑coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
                };
            } else {
                return {
                    category: "Risk Off",
                    allocation: "100% SPY or 1×(100% SPY)",
                };
            }
        }
    } else { // SPY <= SMA220
        if (isTreasuryFallingStrict) {
            return {
                category: "Risk Alt",
                allocation: "25% UPRO + 75% ZROZ (long‑duration zero‑coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
            };
        } else {
            return {
                category: "Risk Off",
                allocation: "100% SPY or 1×(100% SPY)",
            };
        }
    }
}


// --- NEW: Helper function containing the core allocation decision tree ---
// This allows reusing the logic with different input states (strict vs. banded)
function calculateAllocationLogic(isSpyAboveSma, isVolBelow14, isVolBelow24, isTreasuryFalling) {
    if (isSpyAboveSma) {
        if (isVolBelow14) { // Effective Vol < 14% band
            return { category: "Risk On", allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)" };
        } else if (isVolBelow24) { // Effective 14% <= Vol < 24% band
            return { category: "Risk Mid", allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)" };
        } else { // Effective Vol >= 24% band
            if (isTreasuryFalling) { // Effective Treasury Falling?
                return { category: "Risk Alt", allocation: "25% UPRO + 75% ZROZ (long‑duration zero‑coupon bonds) or 1.5×(50% SPY + 50% ZROZ)" };
            } else {
                return { category: "Risk Off", allocation: "100% SPY or 1×(100% SPY)" };
            }
        }
    } else { // Effective SPY <= SMA band
        if (isTreasuryFalling) { // Effective Treasury Falling?
            return { category: "Risk Alt", allocation: "25% UPRO + 75% ZROZ (long‑duration zero‑coupon bonds) or 1.5×(50% SPY + 50% ZROZ)" };
        } else {
            return { category: "Risk Off", allocation: "100% SPY or 1×(100% SPY)" };
        }
    }
}

// --- NEW: Function to determine the RECOMMENDED Allocation using Bands ---
function determineRecommendationWithBands(data) {
    const spy = parseFloat(data.spy);
    const sma220 = parseFloat(data.sma220);
    const volatility = parseFloat(data.volatility);
    const treasuryChange = parseFloat(data.treasuryRateChange); // Use the raw change value

    // Strict MFEA states (needed for comparison when inside bands)
    const isSpyAboveSmaMFEA = spy > sma220;
    const isVolBelow14MFEA = volatility < 14;
    const isVolBelow24MFEA = volatility < 24;
    const isTreasuryFallingMFEA = treasuryChange < -0.0001;

    // Recommendation Band Thresholds & Checks
    const smaBandPercent = 0.01; // 1%
    const volBandAbsolute = 1.0; // 1% absolute for volatility bands (e.g., 13-15, 23-25)
    const treasuryRecThreshold = -0.005; // Recommendation requires a more significant drop (-0.5% points)

    const smaLowerBand = sma220 * (1 - smaBandPercent);
    const smaUpperBand = sma220 * (1 + smaBandPercent);
    const vol14LowerBand = 14 - volBandAbsolute; // 13%
    const vol14UpperBand = 14 + volBandAbsolute; // 15%
    const vol24LowerBand = 24 - volBandAbsolute; // 23%
    const vol24UpperBand = 24 + volBandAbsolute; // 25%

    // Determine effective states for Recommendation logic
    let isSpyEffectivelyAboveSmaRec;
    if (spy > smaUpperBand) isSpyEffectivelyAboveSmaRec = true;
    else if (spy < smaLowerBand) isSpyEffectivelyAboveSmaRec = false;
    else isSpyEffectivelyAboveSmaRec = isSpyAboveSmaMFEA; // Within band, use MFEA state

    let isVolEffectivelyBelow14Rec;
    if (volatility < vol14LowerBand) isVolEffectivelyBelow14Rec = true;
    else if (volatility > vol14UpperBand) isVolEffectivelyBelow14Rec = false;
    else isVolEffectivelyBelow14Rec = isVolBelow14MFEA; // Within 13-15% band, use MFEA state (<14)

    let isVolEffectivelyBelow24Rec;
    if (volatility < vol24LowerBand) isVolEffectivelyBelow24Rec = true;
    else if (volatility > vol24UpperBand) isVolEffectivelyBelow24Rec = false;
    else isVolEffectivelyBelow24Rec = isVolBelow24MFEA; // Within 23-25% band, use MFEA state (<24)

    // Treasury Recommendation uses the stricter threshold
    const isTreasuryFallingRec = treasuryChange < treasuryRecThreshold;

    logDebug(`REC Checks: EffectiveSPY>SMA? ${isSpyEffectivelyAboveSmaRec} (Band ${smaLowerBand.toFixed(2)}-${smaUpperBand.toFixed(2)}), EffVol<14? ${isVolEffectivelyBelow14Rec} (Band ${vol14LowerBand}-${vol14UpperBand}), EffVol<24? ${isVolEffectivelyBelow24Rec} (Band ${vol24LowerBand}-${vol24UpperBand}), EffTrsFall? ${isTreasuryFallingRec} (Thresh ${treasuryRecThreshold})`);

    // Calculate Recommended Allocation using the effective band-aware states
    let recommendedResult = calculateAllocationLogic(
        isSpyEffectivelyAboveSmaRec,
        isVolEffectivelyBelow14Rec,
        isVolEffectivelyBelow24Rec,
        isTreasuryFallingRec
    );

    // Store Band Info for display/explanation
     const bandInfo = {
         spyValue: spy.toFixed(2), smaValue: sma220.toFixed(2), smaLower: smaLowerBand.toFixed(2), smaUpper: smaUpperBand.toFixed(2),
         isSpyInSmaBand: spy >= smaLowerBand && spy <= smaUpperBand,

         volValue: volatility.toFixed(2), vol14Lower: vol14LowerBand.toFixed(2), vol14Upper: vol14UpperBand.toFixed(2), vol24Lower: vol24LowerBand.toFixed(2), vol24Upper: vol24UpperBand.toFixed(2),
         isVolIn14Band: volatility >= vol14LowerBand && volatility <= vol14UpperBand,
         isVolIn24Band: volatility >= vol24LowerBand && volatility <= vol24UpperBand,

         trsChange: treasuryChange.toFixed(4), trsMFEAThreshold: -0.0001, trsRecThreshold: treasuryRecThreshold,
         isTreasuryInBand: treasuryChange >= treasuryRecThreshold && treasuryChange < -0.0001 // Is it between the two thresholds?
     };

    return {
        recommendedCategory: recommendedResult.category,
        recommendedAllocation: recommendedResult.allocation,
        bandInfo: bandInfo
    };
}


// Helper function to fetch financial data for /check command (Unchanged from original, except added treasuryRateChange return)
async function fetchCheckFinancialData() {
    try {
        logDebug("Fetching data for /check command...");
        const [spySMAResponse, treasuryResponse, spyVolResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"), // Keep 50d range to ensure enough history
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"),
        ]);

        // --- SPY Price and SMA (Identical to original) ---
        const spyData = spySMAResponse.data;
        const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;
        const spyAdjClosePrices = spyData.chart.result[0].indicators.adjclose[0].adjclose;
        if (!spyAdjClosePrices || spyAdjClosePrices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const validSpyPrices = spyAdjClosePrices.filter(p => typeof p === 'number' && p !== null).slice(-220);
         if (validSpyPrices.length < 220) {
             logDebug(`Warning: Only ${validSpyPrices.length} valid SPY prices found for SMA.`);
             if(validSpyPrices.length === 0) throw new Error("No valid SPY prices for SMA.");
         }
        const sum220 = validSpyPrices.reduce((acc, price) => acc + price, 0);
        const sma220 = (sum220 / validSpyPrices.length);
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";
        logDebug(`SPY Price: ${spyPrice}, SMA220: ${sma220.toFixed(2)}, Status: ${spyStatus}`);


        // --- Treasury Data Processing (Identical to original, ensure change is calculated) ---
        const treasuryData = treasuryResponse.data.chart.result[0];
         if (!treasuryData || !treasuryData.indicators?.quote?.[0]?.close || !treasuryData.timestamp) {
             throw new Error("Invalid or incomplete Treasury (^IRX) data structure from Yahoo Finance.");
         }
        const treasuryRatesRaw = treasuryData.indicators.quote[0].close;
        const treasuryTimestampsRaw = treasuryData.timestamp;

        const validTreasuryData = treasuryTimestampsRaw
            .map((ts, i) => ({ timestamp: ts, rate: treasuryRatesRaw[i] }))
            .filter(item => item.timestamp != null && typeof item.rate === 'number' && item.rate !== null)
            .sort((a, b) => a.timestamp - b.timestamp);

        if (validTreasuryData.length < 22) {
            throw new Error(`Not enough valid Treasury data points for 21 trading day lookback (need 22, got ${validTreasuryData.length}).`);
        }
        const lastIndex = validTreasuryData.length - 1;
        const latestTreasuryEntry = validTreasuryData[lastIndex];
        const currentTreasuryRateValue = latestTreasuryEntry.rate;
        const targetIndex = lastIndex - 21;
        const oneMonthAgoEntry = validTreasuryData[targetIndex];
        const oneMonthAgoTreasuryRateValue = oneMonthAgoEntry.rate;

        // Calculate change and strict boolean flag
        const treasuryRateChangeValue = currentTreasuryRateValue - oneMonthAgoTreasuryRateValue;
        const isTreasuryFallingStrict = treasuryRateChangeValue < -0.0001; // Use original strict tolerance
        logDebug(`Treasury Rate Change (value): ${currentTreasuryRateValue} - ${oneMonthAgoTreasuryRateValue} = ${treasuryRateChangeValue.toFixed(4)}`);
        logDebug(`Is Treasury Rate Falling (Strict MFEA): ${isTreasuryFallingStrict}`);


        // --- Volatility Calculation (Identical to original) ---
        const spyVolData = spyVolResponse.data;
        const spyVolAdjClose = spyVolData.chart.result[0].indicators.adjclose[0].adjclose;
        const validVolPrices = spyVolAdjClose.filter(p => typeof p === 'number' && p !== null);
         if (validVolPrices.length < 21) {
             throw new Error(`Not enough valid data points for 21-day volatility calculation (need >= 21, got ${validVolPrices.length}).`);
         }
         const relevantVolPrices = validVolPrices.slice(-21); // Last 21 valid prices
         const spyVolDailyReturns = relevantVolPrices.slice(1).map((price, idx) => {
            const prevPrice = relevantVolPrices[idx];
            return prevPrice === 0 ? 0 : (price / prevPrice - 1);
        });
         if (spyVolDailyReturns.length !== 20) {
             throw new Error(`Incorrect number of returns for vol calc (expected 20, got ${spyVolDailyReturns.length})`);
         }
        const returnsForVol = spyVolDailyReturns; // Use the 20 returns
        const meanReturn = returnsForVol.reduce((acc, r) => acc + r, 0) / returnsForVol.length;
        const variance = returnsForVol.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / returnsForVol.length;
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100);
        logDebug(`Calculated Annualized Volatility (${returnsForVol.length} returns): ${annualizedVolatility.toFixed(2)}%`);

        // --- Return results (Include BOTH the boolean AND the raw change for treasury) ---
        return {
            spy: parseFloat(spyPrice).toFixed(2),
            sma220: sma220.toFixed(2),
            spyStatus: spyStatus,
            volatility: annualizedVolatility.toFixed(2),
            treasuryRate: currentTreasuryRateValue.toFixed(3),
            isTreasuryFalling: isTreasuryFallingStrict, // The strict boolean for original compatibility/display
            treasuryRateChange: treasuryRateChangeValue.toFixed(4), // The raw change value needed for band calc
        };
    } catch (error) {
        console.error("Error fetching financial data:", error);
        if (error.response) {
            console.error("Axios Error Data:", error.response.data);
            console.error("Axios Error Status:", error.response.status);
        }
        console.error("Caught Error Message:", error.message);
        throw new Error(`Failed to fetch financial data: ${error.message}`);
    }
}


// Helper function to fetch financial data for /ticker command (Unchanged from original)
async function fetchTickerFinancialData(ticker, range) {
    try {
        const rangeOptions = {
            '1d': { range: '1d', interval: '1m' },
            '1mo': { range: '1mo', interval: '5m' },
            '1y': { range: '1y', interval: '1d' },
            '3y': { range: '3y', interval: '1wk' },
            '10y': { range: '10y', interval: '1mo' },
        };

        const selectedRange = rangeOptions[range] ? range : '1d';
        const { range: yahooRange, interval } = rangeOptions[selectedRange];

        const tickerResponse = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${yahooRange}`
        );
        const tickerData = tickerResponse.data;

        if (
            !tickerData.chart.result ||
            tickerData.chart.result.length === 0 ||
            tickerData.chart.result[0].meta?.regularMarketPrice === undefined // Check specific prop
        ) {
             if (tickerData.chart?.error?.description) {
                 throw new Error(`Yahoo Finance error: ${tickerData.chart.error.description}`);
             }
            throw new Error("Invalid ticker symbol or data unavailable.");
        }

        const currentPrice = parseFloat(tickerData.chart.result[0].meta.regularMarketPrice).toFixed(2);
        const timestamps = tickerData.chart.result[0].timestamp;
        let prices = [];

        const indicators = tickerData.chart.result[0].indicators;
        if (indicators?.adjclose?.[0]?.adjclose) {
            prices = indicators.adjclose[0].adjclose;
        } else if (indicators?.quote?.[0]?.close) {
            prices = indicators.quote[0].close;
        } else {
            throw new Error("Price data is unavailable.");
        }

        if (!timestamps || !prices || timestamps.length !== prices.length) {
            throw new Error("Incomplete historical data.");
        }

        // Combine, filter nulls, format date (Original logic maintained)
         const validHistoricalEntries = timestamps
            .map((timestamp, index) => ({ timestamp, price: prices[index] }))
            .filter(entry => typeof entry.price === 'number' && entry.price !== null);

        const historicalData = validHistoricalEntries.map(entry => {
             const dateObj = new Date(entry.timestamp * 1000);
             let dateLabel = '';
             // Original Date Formatting Logic
             if (selectedRange === '1d' || selectedRange === '1mo') {
                 dateLabel = dateObj.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
             } else {
                 dateLabel = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
             }
             return { date: dateLabel, price: entry.price }; // Keep price as number for potential aggregation
        });


        // Original 10y aggregation logic
        let aggregatedData = historicalData; // Use the formatted data from above
        if (selectedRange === '10y' && historicalData.length > 0) {
             logDebug("Aggregating 10y data...");
              const monthlyMap = {};
              // We need the original timestamps for reliable month/year grouping
              validHistoricalEntries.forEach(entry => {
                   const dateObj = new Date(entry.timestamp * 1000);
                   if (dateObj && !isNaN(dateObj.getTime())) {
                       const monthKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`;
                       if (!monthlyMap[monthKey]) {
                           const monthLabel = dateObj.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'America/New_York' });
                           monthlyMap[monthKey] = { sum: 0, count: 0, label: monthLabel };
                       }
                       monthlyMap[monthKey].sum += entry.price; // entry.price is number here
                       monthlyMap[monthKey].count += 1;
                  }
              });

              aggregatedData = Object.keys(monthlyMap).sort().map(monthKey => {
                  const avgPrice = monthlyMap[monthKey].sum / monthlyMap[monthKey].count;
                  return {
                      date: monthlyMap[monthKey].label,
                      price: parseFloat(avgPrice).toFixed(2), // Format final average price as string for chart
                  };
              });
             logDebug(`Aggregated into ${aggregatedData.length} points.`);
        }

        // Final return structure - ensure price is string for QuickChart if needed by original chart config
        return {
            ticker: ticker.toUpperCase(),
            currentPrice: `$${currentPrice}`,
            historicalData: aggregatedData.map(entry => ({...entry, price: String(entry.price) })), // Convert price to string for chart data
            selectedRange: selectedRange.toUpperCase(), // Use actual range used
        };
    } catch (error) {
        console.error(`Error fetching financial data for ${ticker}:`, error);
        throw new Error(
            error.message || `Failed to fetch financial data for ${ticker}.`
        );
    }
}


// Main handler
module.exports = async (req, res) => {
    logDebug("Received a new request");

    // --- Request Validation (Signature, Timestamp, Method, Body Parsing) ---
    // (Identical to original - assuming it was working correctly)
    if (req.method !== "POST") { /* ... */ return res.status(405).json({ error: "Method Not Allowed" }); }
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    if (!signature || !timestamp) { /* ... */ return res.status(401).json({ error: "Bad request signature" }); }
    let rawBody; try { rawBody = await getRawBody(req, { encoding: "utf-8" }); } catch (error) { /* ... */ return res.status(400).json({ error: "Invalid request body" }); }
    let message; try { message = JSON.parse(rawBody); } catch (error) { /* ... */ return res.status(400).json({ error: "Invalid JSON format" }); }
    if (!process.env.PUBLIC_KEY) { /* ... */ return res.status(500).json({ error: "Internal server configuration error."}); }
    const isValidRequest = verifyKey(rawBody, signature, timestamp, process.env.PUBLIC_KEY);
    if (!isValidRequest) { /* ... */ return res.status(401).json({ error: "Bad request signature" }); }
    // --- End Validation ---


    logDebug(`Message type: ${message.type}`);

    // --- PING Handler (Identical to original) ---
    if (message.type === InteractionType.PING) {
        try { logDebug("Handling PING"); res.status(200).json({ type: InteractionResponseType.PONG }); logDebug("PONG sent"); return; }
        catch (error) { console.error("[ERROR] Failed to handle PING:", error); return res.status(500).json({ error: "Internal Server Error" }); }
    }

    // --- APPLICATION_COMMAND Handler ---
    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name.toLowerCase();
        const { application_id, token } = message; // For potential followups if needed later
        const followupUrl = `https://discord.com/api/v10/webhooks/${application_id}/${token}/messages/@original`;


        switch (commandName) {
            case HI_COMMAND.name.toLowerCase():
                // (Identical to original)
                try { logDebug("Handling /hi command"); res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "hii <3" } }); logDebug("/hi command successfully executed"); return; }
                catch (error) { console.error("[ERROR] Failed to execute /hi command:", error); return res.status(500).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "⚠️ An error occurred." } }); }

            case CHECK_COMMAND.name.toLowerCase():
                // Optional: Defer if fetching/calculation takes time
                // try {
                //     logDebug("Deferring response for /check");
                //     res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
                // } catch(deferError) { /* ... error handling ... */ return; }

                try {
                    logDebug("Handling /check command");
                    const financialData = await fetchCheckFinancialData(); // Fetches data including strict isTreasuryFalling and raw change

                    // 1. Get Strict MFEA Result
                    const { category: mfeaCategory, allocation: mfeaAllocation } = determineStrictMFEACategory(financialData);

                    // 2. Get Recommendation Result (with Bands)
                    const { recommendedCategory, recommendedAllocation, bandInfo } = determineRecommendationWithBands(financialData);


                    // --- Treasury Rate Trend Display Logic (Using original logic based on strict check) ---
                    let treasuryRateTrendValue = "";
                    const treasuryRateTimeframe = "last 21 trading days"; // Adjusted timeframe text
                    const changeNum = parseFloat(financialData.treasuryRateChange); // Use the raw change for display formatting
                    const changePercent = (changeNum * 100).toFixed(2); // Format as percentage points

                    // Use the strict boolean from financialData for the arrow/text consistency with original display
                    if (financialData.isTreasuryFalling) { // Check the strict boolean
                        treasuryRateTrendValue = `⬇️ Falling (${changePercent}%)`;
                    } else if (changeNum > 0.0001) { // Check if strictly rising
                         treasuryRateTrendValue = `⬆️ Rising (+${changePercent}%)`;
                    } else { // Stable or negligible change
                        treasuryRateTrendValue = `↔️ Stable (${changePercent}%)`;
                    }
                    treasuryRateTrendValue += `\nover ${treasuryRateTimeframe}`;
                    // --- End Original Display Logic ---


                     // --- Create Band Influence Description ---
                    let bandInfluenceDescription = "";
                    const influences = [];
                    let recommendationDiffers = mfeaAllocation !== recommendedAllocation;

                    if (bandInfo.isSpyInSmaBand) influences.push(`SPY ($${bandInfo.spyValue}) is within ±1% SMA band ($${bandInfo.smaLower} - $${bandInfo.smaUpper}).`);
                    if (bandInfo.isVolIn14Band) influences.push(`Volatility (${bandInfo.volValue}%) is within ${bandInfo.vol14Lower}-${bandInfo.vol14Upper}% band.`);
                    else if (bandInfo.isVolIn24Band) influences.push(`Volatility (${bandInfo.volValue}%) is within ${bandInfo.vol24Lower}-${bandInfo.vol24Upper}% band.`);
                    if (bandInfo.isTreasuryInBand) influences.push(`Treasury change (${(bandInfo.trsChange * 100).toFixed(2)}%) is between Rec. threshold (${(bandInfo.trsRecThreshold*100).toFixed(2)}%) & MFEA threshold (${(bandInfo.trsMFEAThreshold*100).toFixed(2)}%).`);
                    else if (recommendationDiffers && !bandInfo.isSpyInSmaBand && !bandInfo.isVolIn14Band && !bandInfo.isVolIn24Band && bandInfo.trsChange < bandInfo.trsRecThreshold) {
                        // If differs and nothing else is in band, and treasury crossed Rec threshold
                         influences.push(`Treasury change (${(bandInfo.trsChange*100).toFixed(2)}%) crossed Rec. threshold (${(bandInfo.trsRecThreshold*100).toFixed(2)}%).`);
                    }

                    if (!recommendationDiffers) {
                        if (influences.length > 0) bandInfluenceDescription = "Factors near thresholds (within bands):\n• " + influences.join("\n• ") + "\n*Recommendation aligns with MFEA as no bands were decisively crossed.*";
                        else bandInfluenceDescription = "All factors clear of rebalancing bands. Recommendation aligns with MFEA.";
                    } else {
                        bandInfluenceDescription = "Factors influencing difference from MFEA:\n• " + influences.join("\n• ") + "\n*Recommendation differs due to band thresholds.*";
                    }


                    // --- Send results in Embed ---
                    // Send immediate response (if not deferred)
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: {
                            embeds: [
                                {
                                    title: "MFEA Analysis & Recommendation",
                                    color: 3447003, // Blue
                                    fields: [
                                        // Original Data Fields
                                        { name: "SPY Price", value: `$${financialData.spy}`, inline: true },
                                        { name: "220d SMA", value: `$${financialData.sma220}`, inline: true },
                                        { name: "SPY vs SMA", value: `${financialData.spyStatus}`, inline: true },
                                        { name: "Volatility (Ann.)", value: `${financialData.volatility}%`, inline: true },
                                        { name: "3M Treas Rate", value: `${financialData.treasuryRate}%`, inline: true },
                                        { name: "Treas Rate Trend", value: treasuryRateTrendValue, inline: true }, // Uses original strict logic for display

                                        // Strict MFEA Result
                                        { name: "📊 MFEA Category", value: mfeaCategory, inline: false }, // Start new row
                                        { name: "📈 MFEA Allocation", value: `**${mfeaAllocation}**`, inline: false },

                                        // Recommendation Result
                                        { name: "💡 Recommended Allocation", value: `**${recommendedAllocation}**`, inline: false },

                                        // Band Analysis
                                        { name: "⚙️ Band Influence Analysis", value: bandInfluenceDescription, inline: false },
                                    ],
                                    footer: {
                                        text: "MFEA = Strict Model | Recommendation includes rebalancing bands",
                                    },
                                    timestamp: new Date().toISOString(),
                                },
                            ],
                        },
                    });
                    logDebug("/check command successfully executed with MFEA & Recommendation data");
                    return;

                     // If using Deferral, use followup:
                     // await axios.patch(followupUrl, { embeds: [ /* embed object here */ ] });
                     // logDebug("/check command successfully processed and sent via followup.");


                } catch (error) {
                    console.error("[ERROR] Failed to process /check command:", error);
                    // Send error response (or followup if deferred)
                     try {
                         return res.status(500).json({
                             type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                             data: { content: `⚠️ Unable to process MFEA analysis: ${error.message || 'Please try again later.'}` }
                         });
                         // If deferred:
                         // await axios.patch(followupUrl, { content: `⚠️ Unable to process MFEA analysis: ${error.message || 'Please try again later.'}` });
                     } catch (responseError) {
                          console.error("[ERROR] Failed to send error response for /check:", responseError);
                     }
                    return;
                }

            case TICKER_COMMAND.name.toLowerCase():
                 // (Identical to original, including potential deferral if added previously)
                 // Using the non-deferred version from the *very first* code block provided.
                try {
                    logDebug("Handling /ticker command");
                    const options = message.data.options;
                    const tickerOption = options.find(option => option.name === "symbol");
                    const timeframeOption = options.find(option => option.name === "timeframe");
                    const ticker = tickerOption ? tickerOption.value.toUpperCase() : null;
                    const timeframe = timeframeOption ? timeframeOption.value : '1d';
                    if (!ticker) {
                        return res.status(400).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "❌ Ticker symbol is required." } });
                    }

                    const tickerData = await fetchTickerFinancialData(ticker, timeframe);

                    // Generate Chart Image URL using QuickChart.io (Original chart config from first code block)
                     const chartConfig = {
                        type: 'line',
                        data: {
                            labels: tickerData.historicalData.map(entry => entry.date),
                            datasets: [{
                                label: `${tickerData.ticker} Price`,
                                data: tickerData.historicalData.map(entry => entry.price), // Expects string prices based on original fetcher
                                borderColor: '#0070f3',
                                backgroundColor: 'rgba(0, 112, 243, 0.1)',
                                borderWidth: 2,
                                pointRadius: 0,
                                fill: true,
                            }]
                        },
                        options: {
                            scales: { /* ... original scales ... */ },
                            plugins: { /* ... original plugins ... */ }
                        }
                    };
                    const chartConfigEncoded = encodeURIComponent(JSON.stringify(chartConfig));
                    const chartUrl = `https://quickchart.io/chart?c=${chartConfigEncoded}&w=600&h=400`; // Added size

                    // Original embed structure
                    const embed = {
                        title: `${tickerData.ticker} Financial Data (${timeframe.toUpperCase()})`,
                        color: 3447003,
                        fields: [
                            { name: "Current Price", value: tickerData.currentPrice, inline: true },
                            { name: "Selected Range", value: tickerData.selectedRange, inline: true }, // Use returned range
                            { name: "Data Source", value: "Yahoo Finance", inline: true }, // Original source text
                        ],
                        image: { url: chartUrl },
                        footer: { text: "Data fetched from Yahoo Finance via QuickChart.io" }, // Original footer + source
                         timestamp: new Date().toISOString(),
                    };
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { embeds: [embed] },
                    });
                    logDebug("/ticker command successfully executed with dynamic data and chart");
                    return;
                } catch (error) {
                    console.error("[ERROR] Failed to fetch financial data for /ticker command:", error);
                    return res.status(500).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: `⚠️ Unable to retrieve financial data for ${message.data?.options?.find(o=>o.name==='symbol')?.value || 'ticker'}: ${error.message}` }
                    });
                }


            default:
                // (Identical to original)
                try { console.error("[ERROR] Unknown command"); res.status(400).json({ error: "Unknown Command" }); return; }
                catch (error) { console.error("[ERROR] Failed to handle unknown command:", error); return res.status(500).json({ error: "Internal Server Error" }); }
        }
    } else {
        // (Identical to original)
        try { console.error("[ERROR] Unknown request type"); res.status(400).json({ error: "Unknown Type" }); return; }
        catch (error) { console.error("[ERROR] Failed to handle unknown request type:", error); return res.status(500).json({ error: "Internal Server Error" }); }
    }
};
