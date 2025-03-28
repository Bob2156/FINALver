// index.js - Using fixed 21 TRADING DAY lookback for Treasury change
"use strict";

const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

// Define your commands (Unchanged)
const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Display MFEA analysis status." };
const TICKER_COMMAND = {
    name: "ticker",
    description: "Fetch and display financial data for a specific ticker and timeframe.",
    options: [ /* options unchanged */ ],
};


// Helper function to log debug messages (Unchanged)
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
    // This prevents the band *itself* from causing a flip; a flip requires crossing *out* of the band OR another factor changing state.

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

    // Treasury Recommendation uses a stricter threshold, no upper/lower band needed here
    const isTreasuryFallingRec = treasuryChange < treasuryRecThreshold;

    logDebug(`MFEA Checks: SPY>${sma220.toFixed(2)}? ${isSpyAboveSmaMFEA}, Vol<14? ${isVolBelow14MFEA}, Vol<24? ${isVolBelow24MFEA}, TrsFall? ${isTreasuryFallingMFEA}`);
    logDebug(`REC Checks (Effective): SPY>SMA? ${isSpyEffectivelyAboveSmaRec} (Band ${smaLowerBand.toFixed(2)}-${smaUpperBand.toFixed(2)}), Vol<14? ${isVolEffectivelyBelow14Rec} (Band ${vol14LowerBand}-${vol14UpperBand}), Vol<24? ${isVolEffectivelyBelow24Rec} (Band ${vol24LowerBand}-${vol24UpperBand}), TrsFall? ${isTreasuryFallingRec} (Thresh ${treasuryRecThreshold})`);

    // --- Calculate MFEA Allocation (using strict checks) ---
    let mfeaResult = calculateAllocation(isSpyAboveSmaMFEA, isVolBelow14MFEA, isVolBelow24MFEA, isTreasuryFallingMFEA);

    // --- Calculate Recommended Allocation (using effective band-aware checks) ---
    let recommendedResult = calculateAllocation(isSpyEffectivelyAboveSmaRec, isVolEffectivelyBelow14Rec, isVolEffectivelyBelow24Rec, isTreasuryFallingRec);

    // --- Store Band Info for Display ---
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

         trsChange: treasuryChange.toFixed(4), // Show more precision for treasury change
         trsMFEAThreshold: -0.0001,
         trsRecThreshold: treasuryRecThreshold,
         isTreasuryInBand: treasuryChange >= treasuryRecThreshold && treasuryChange < -0.0001 // In the zone between Rec and MFEA thresholds
     };


    return {
        mfeaCategory: mfeaResult.category,
        mfeaAllocation: mfeaResult.allocation,
        recommendedCategory: recommendedResult.category,
        recommendedAllocation: recommendedResult.allocation,
        bandInfo: bandInfo // Pass band info for potential display
    };
}


// Helper function to fetch financial data for /check command (Unchanged - logic remains the same)
async function fetchCheckFinancialData() {
    try {
        logDebug("Fetching data for /check command...");
        const [spySMAResponse, treasuryResponse, spyVolResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"), // Keep 50d range to ensure enough history
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"),
        ]);

        // --- SPY Price and SMA ---
        const spyData = spySMAResponse.data;
        const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;
        const spyAdjClosePrices = spyData.chart.result[0].indicators.adjclose[0].adjclose;
        if (!spyAdjClosePrices || spyAdjClosePrices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const validSpyPrices = spyAdjClosePrices.slice(-220).filter(p => typeof p === 'number');
        if (validSpyPrices.length < 220) {
             logDebug(`Warning: Only found ${validSpyPrices.length} valid SPY prices out of the last 220 days for SMA.`);
            if (validSpyPrices.length === 0) throw new Error("No valid SPY prices found in the last 220 days for SMA.");
        }
        const sum220 = validSpyPrices.reduce((acc, price) => acc + price, 0);
        const sma220 = (sum220 / validSpyPrices.length);
        const spyStatus = spyPrice > sma220 ? "Over" : "Under";
        logDebug(`SPY Price: ${spyPrice}, SMA220: ${sma220.toFixed(2)} (from ${validSpyPrices.length} points), Status: ${spyStatus}`);


        // --- Treasury Data Processing ---
        const treasuryData = treasuryResponse.data.chart.result[0];
         if (!treasuryData || !treasuryData.indicators?.quote?.[0]?.close || !treasuryData.timestamp) {
             throw new Error("Invalid or incomplete Treasury (^IRX) data structure from Yahoo Finance.");
         }
        const treasuryRatesRaw = treasuryData.indicators.quote[0].close;
        const treasuryTimestampsRaw = treasuryData.timestamp;

        const validTreasuryData = treasuryTimestampsRaw
            .map((ts, i) => ({ timestamp: ts, rate: treasuryRatesRaw[i] }))
            .filter(item => item.timestamp != null && typeof item.rate === 'number')
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
        const treasuryRateChangeValue = currentTreasuryRateValue - oneMonthAgoTreasuryRateValue;
        const isTreasuryFalling = treasuryRateChangeValue < -0.0001; // Keep original check here for basic status display if needed elsewhere
        logDebug(`Treasury Rate: Current=${currentTreasuryRateValue.toFixed(3)}, 21d Ago=${oneMonthAgoTreasuryRateValue.toFixed(3)}, Change=${treasuryRateChangeValue.toFixed(4)}, IsFalling (Strict)? ${isTreasuryFalling}`);


        // --- Volatility Calculation ---
        const spyVolData = spyVolResponse.data;
        const spyVolAdjClose = spyVolData.chart.result[0].indicators.adjclose[0].adjclose;
         // Need at least 21 valid prices to calculate 20 returns
        const validVolPrices = spyVolAdjClose.filter(p => typeof p === 'number' && p !== null);
        if (validVolPrices.length < 21) {
             throw new Error(`Not enough valid data points for 21-day volatility calc (need >= 21, got ${validVolPrices.length}).`);
        }
        const spyVolDailyReturns = validVolPrices.slice(1).map((price, idx) => {
            const prevPrice = validVolPrices[idx];
            return prevPrice === 0 ? 0 : (price / prevPrice - 1);
        });

        // Need 20 returns to calculate 21-day vol
        if (spyVolDailyReturns.length < 20) {
             throw new Error(`Not enough daily returns for 21-day vol calc (need 20, got ${spyVolDailyReturns.length}).`);
        }
        // Use the most recent 21 returns (which requires 22 days of prices, hence 21 periods)
        // If we have 21 prices, we get 20 returns. Use the latest 20 returns for 21-day volatility.
        const recentReturns = spyVolDailyReturns.slice(-21); // If length is > 21, take latest 21. If length is 20, this takes all 20. Let's take last 20 strictly.
        const returnsForVol = spyVolDailyReturns.slice(-20); // Use the most recent 20 returns

        if (returnsForVol.length < 20) { // Should not happen due to earlier checks, but good safeguard
             throw new Error(`Insufficient returns for final 21-day volatility calc (need 20, got ${returnsForVol.length}).`);
        }

        const meanReturn = returnsForVol.reduce((acc, r) => acc + r, 0) / returnsForVol.length;
        const variance = returnsForVol.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) / returnsForVol.length; // Use N
        const dailyVolatility = Math.sqrt(variance);
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100);
        logDebug(`Calculated Annualized Volatility (${returnsForVol.length} returns used): ${annualizedVolatility.toFixed(2)}%`);

        // --- Return results formatted as strings ---
        return {
            spy: parseFloat(spyPrice).toFixed(2),
            sma220: sma220.toFixed(2),
            spyStatus: spyStatus, // Basic status relative to exact SMA
            volatility: annualizedVolatility.toFixed(2),
            treasuryRate: currentTreasuryRateValue.toFixed(3),
            // isTreasuryFalling: isTreasuryFalling, // No longer primary decision factor, use change
            treasuryRateChange: treasuryRateChangeValue.toFixed(4), // Return change with more precision
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


// Helper function to fetch financial data for /ticker command (Unchanged)
async function fetchTickerFinancialData(ticker, range) { /* ... unchanged ... */ }


// Main handler
module.exports = async (req, res) => {
    // ... (Request validation, PING handling - unchanged) ...

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name.toLowerCase();
        switch (commandName) {
            case HI_COMMAND.name.toLowerCase():
                // ... (unchanged) ...
                return;

            case CHECK_COMMAND.name.toLowerCase():
                try {
                    logDebug("Handling /check command");
                    const financialData = await fetchCheckFinancialData();

                    // --- Get BOTH MFEA and Recommended Allocations ---
                    const {
                        mfeaCategory,
                        mfeaAllocation,
                        recommendedCategory,
                        recommendedAllocation,
                        bandInfo // Get band info for display
                    } = determineAllocations(financialData);

                    // --- Treasury Rate Trend Display Logic (Based on strict MFEA check) ---
                    let treasuryRateTrendValue = "";
                    const treasuryRateTimeframe = "last 21 trading days";
                    const changeNumMFEA = parseFloat(financialData.treasuryRateChange); // Use the fetched change

                    // Use the original MFEA threshold for display text
                    if (changeNumMFEA < -0.0001) {
                        treasuryRateTrendValue = `⬇️ Falling (${changeNumMFEA.toFixed(4)}%)`; // Show value
                    } else if (changeNumMFEA > 0.0001) {
                         treasuryRateTrendValue = `⬆️ Rising (${changeNumMFEA.toFixed(4)}%)`; // Show value
                    } else {
                        treasuryRateTrendValue = `↔️ Stable (${changeNumMFEA.toFixed(4)}%)`; // Show value
                    }
                     treasuryRateTrendValue += ` over ${treasuryRateTimeframe}`;


                    // --- Create Band Influence Description ---
                    let bandInfluenceDescription = "";
                    const influences = [];
                    if (bandInfo.isSpyInSmaBand) {
                        influences.push(`SPY ($${bandInfo.spyValue}) is within ±1% SMA band ($${bandInfo.smaLower} - $${bandInfo.smaUpper}).`);
                    }
                    if (bandInfo.isVolIn14Band) {
                        influences.push(`Volatility (${bandInfo.volValue}%) is within ${bandInfo.vol14Lower}-${bandInfo.vol14Upper}% band.`);
                    }
                    if (bandInfo.isVolIn24Band) {
                        influences.push(`Volatility (${bandInfo.volValue}%) is within ${bandInfo.vol24Lower}-${bandInfo.vol24Upper}% band.`);
                    }
                    // Check if treasury change is between the two thresholds
                    if (bandInfo.isTreasuryInBand) {
                        influences.push(`Treasury change (${bandInfo.trsChange}%) is between recommendation threshold (${bandInfo.trsRecThreshold}) and MFEA threshold (${bandInfo.trsMFEAThreshold}).`);
                    } else if (mfeaAllocation !== recommendedAllocation && !bandInfo.isSpyInSmaBand && !bandInfo.isVolIn14Band && !bandInfo.isVolIn24Band) {
                        // If allocations differ but nothing is in a vol/SMA band, the treasury *must* be the cause (crossed Rec threshold)
                         influences.push(`Treasury change (${bandInfo.trsChange}%) crossed recommendation threshold (${bandInfo.trsRecThreshold}).`);
                    }


                    if (mfeaAllocation === recommendedAllocation) {
                        if (influences.length > 0) {
                            bandInfluenceDescription = "Factors near thresholds (within bands):\n• " + influences.join("\n• ") + "\n*Recommendation aligns with MFEA as no bands were decisively crossed.*";
                        } else {
                            bandInfluenceDescription = "All factors are clear of rebalancing bands. Recommendation aligns with MFEA.";
                        }
                    } else {
                         bandInfluenceDescription = "Factors influencing difference from MFEA:\n• " + influences.join("\n• ") + "\n*Recommendation differs due to band thresholds.*";
                    }


                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: {
                            embeds: [
                                {
                                    title: "MFEA Analysis Status",
                                    color: 3447003, // Blue
                                    fields: [
                                        // Market Data Fields
                                        { name: "SPY Price", value: `$${financialData.spy}`, inline: true },
                                        { name: "220d SMA", value: `$${financialData.sma220}`, inline: true },
                                        { name: "SPY vs SMA", value: `${financialData.spyStatus} SMA`, inline: true }, // Simplified label
                                        { name: "Volatility", value: `${financialData.volatility}%`, inline: true },
                                        { name: "3M Treas Rate", value: `${financialData.treasuryRate}%`, inline: true },
                                        { name: "Treas Rate Trend", value: treasuryRateTrendValue, inline: true }, // Based on strict MFEA check

                                        // MFEA Strict Calculation
                                        { name: "📊 MFEA Category", value: mfeaCategory, inline: true }, // Use new name
                                        { name: "📈 MFEA Allocation", value: `**${mfeaAllocation}**`, inline: false }, // Use new name

                                        // Recommendation with Bands
                                        { name: "💡 Recommended Allocation (with Bands)", value: `**${recommendedAllocation}**`, inline: false }, // New recommendation field

                                        // Explanation of Band Influence
                                        { name: "⚙️ Band Influence Analysis", value: bandInfluenceDescription, inline: false },
                                    ],
                                    footer: {
                                        text: "MFEA = Strict Model | Recommendation includes rebalancing bands",
                                    },
                                },
                            ],
                        },
                    });
                    logDebug("/check command successfully executed with MFEA, Recommendation, and Band analysis");
                    return;
                } catch (error) {
                    console.error("[ERROR] Failed to process /check command:", error);
                    res.status(500).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: `⚠️ Unable to process MFEA analysis: ${error.message || 'Please try again later.'}` }
                    });
                    return;
                }

            case TICKER_COMMAND.name.toLowerCase():
                 // --- Using Deferral Logic from previous step ---
                try {
                    logDebug("Handling /ticker command");
                    // Defer the response immediately
                    res.status(200).json({
                        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
                    });
                    logDebug(`Deferred response sent for /ticker`);

                    const options = message.data.options;
                    const tickerOption = options.find(option => option.name === "symbol");
                    const timeframeOption = options.find(option => option.name === "timeframe");
                    const ticker = tickerOption ? tickerOption.value.toUpperCase() : null;
                    const timeframe = timeframeOption ? timeframeOption.value : '1d';

                    if (!ticker) {
                        // Edit deferred response with error
                        await axios.patch(`https://discord.com/api/v10/webhooks/${message.application_id}/${message.token}/messages/@original`, {
                            content: "❌ Ticker symbol is required."
                        });
                        return;
                    }

                    const tickerData = await fetchTickerFinancialData(ticker, timeframe); // Assume fetchTickerFinancialData is robust

                    // Generate Chart Image URL
                    const chartConfig = { /* ... chart config as before ... */ };
                    const chartConfigEncoded = encodeURIComponent(JSON.stringify(chartConfig));
                    const chartUrl = `https://quickchart.io/chart?c=${chartConfigEncoded}&w=600&h=400`; // Specify size

                    // Embed Structure
                    const embed = { /* ... embed structure as before ... */ };

                    // Edit the original deferred response with the results
                    const followupUrl = `https://discord.com/api/v10/webhooks/${message.application_id}/${message.token}/messages/@original`;
                    await axios.patch(followupUrl, { embeds: [embed] });
                    logDebug(`/ticker ${ticker} command successfully executed`);

                } catch (error) {
                    console.error(`[ERROR] Failed to process /ticker command for ${message.data?.options?.find(o => o.name === 'symbol')?.value}:`, error);
                    const followupUrl = `https://discord.com/api/v10/webhooks/${message.application_id}/${message.token}/messages/@original`;
                    try {
                         await axios.patch(followupUrl, {
                              content: `⚠️ Unable to retrieve financial data for the specified ticker: ${error.message || 'Please ensure the symbol is correct and try again.'}`
                         });
                    } catch (followupError) {
                         console.error("[ERROR] Failed to send error followup message for /ticker:", followupError.response ? followupError.response.data : followupError.message);
                    }
                }
                return; // Explicit return after handling /ticker


            default:
                // ... (unchanged) ...
                return;
        }
    } else {
        // ... (Unknown type handling - unchanged) ...
        return;
    }
};

// --- Make sure fetchTickerFinancialData is included or required if in a separate file ---
// Example placeholder if it wasn't included above:
// async function fetchTickerFinancialData(ticker, range) {
//     console.log(`Fetching data for ${ticker} (${range})...`);
//     // ... actual implementation needed here ...
//     return { ticker: ticker, currentPrice: '$100.00', historicalData: [{date: 'Jan 1', price: '99.00'}, {date: 'Jan 2', price: '100.00'}], selectedRange: range };
// }
