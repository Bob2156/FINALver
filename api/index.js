"use strict";

/**
 * index.js — Overhauled/Refactored for clarity
 * 
 * This preserves original logic and features:
 * 1. Discord interaction verification via PUBLIC_KEY
 * 2. MFEA strict analysis (/check)
 * 3. Recommendation with band thresholds (/check)
 * 4. Ticker data retrieval (/ticker)
 * 5. Simple "hi" command
 * 
 * Structured into several classes/services for readability,
 * but you can place them inline or in separate files if desired.
 */

const { InteractionResponseType, InteractionType, verifyKey } = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

//=================//
//    Constants    //
//=================//

// Commands
const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = {
  name: "check",
  description: "Display MFEA analysis status (Strict & Recommended).",
};
const TICKER_COMMAND = {
  name: "ticker",
  description: "Fetch and display financial data for a specific ticker and timeframe.",
  options: [
    {
      name: "symbol",
      type: 3, // STRING
      description: "The stock ticker symbol (e.g., AAPL, GOOGL)",
      required: true,
    },
    {
      name: "timeframe",
      type: 3, // STRING
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

// A preset image URL (used in original code for /ticker in test mode, left here if needed)
const PRESET_IMAGE_URL =
  "https://th.bing.com/th/id/R.aeccf9d26746b036234619be80502098?rik=JZrA%2f9rIOJ3Fxg&riu=http%3a%2f%2fwww.clipartbest.com%2fcliparts%2fbiy%2fE8E%2fbiyE8Er5T.jpeg&ehk=FOPbyrcgKCZzZorMhY69pKoHELUk3FiBPDkgwkqNvis%3d&risl=&pid=ImgRaw&r=0";

//===============================//
//    Logging / Debug Utility    //
//===============================//
class Logger {
  static debug(message) {
    console.log(`[DEBUG] ${message}`);
  }
}

//==========================================================//
//  MFEA & Recommendation Logic (Strict vs. Banded) Helper  //
//==========================================================//
class MfeaCalculator {
  /**
   * STRICT MFEA calculation (original logic):
   * data must have: spy, sma220, volatility, isTreasuryFalling
   */
  static determineStrictRiskCategory(data) {
    const spyValue = parseFloat(data.spy);
    const sma220Value = parseFloat(data.sma220);
    const volatilityValue = parseFloat(data.volatility);

    Logger.debug(
      `Determining STRICT MFEA with SPY: ${data.spy}, SMA220: ${data.sma220}, ` +
        `Volatility: ${data.volatility}%, isTreasuryFalling (strict): ${data.isTreasuryFalling}`
    );

    if (spyValue > sma220Value) {
      // SPY > SMA
      if (volatilityValue < 14) {
        return {
          category: "Risk On",
          allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
        };
      } else if (volatilityValue < 24) {
        return {
          category: "Risk Mid",
          allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
        };
      } else {
        // vol >= 24
        if (data.isTreasuryFalling) {
          return {
            category: "Risk Alt",
            allocation:
              "25% UPRO + 75% ZROZ (long-duration zero-coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
          };
        } else {
          return {
            category: "Risk Off",
            allocation: "100% SPY or 1×(100% SPY)",
          };
        }
      }
    } else {
      // SPY <= SMA
      if (data.isTreasuryFalling) {
        return {
          category: "Risk Alt",
          allocation:
            "25% UPRO + 75% ZROZ (long-duration zero-coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
        };
      } else {
        return {
          category: "Risk Off",
          allocation: "100% SPY or 1×(100% SPY)",
        };
      }
    }
  }

  /**
   * Core decision tree used by both Strict and Banded logic
   * (Pulled from original code; reused for recommended approach).
   */
  static calculateAllocationLogic(isSpyAboveSma, isVolBelow14, isVolBelow24, isTreasuryFalling) {
    if (isSpyAboveSma) {
      if (isVolBelow14) {
        return {
          category: "Risk On",
          allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
        };
      } else if (isVolBelow24) {
        return {
          category: "Risk Mid",
          allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
        };
      } else {
        if (isTreasuryFalling) {
          return {
            category: "Risk Alt",
            allocation:
              "25% UPRO + 75% ZROZ (long-duration zero-coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
          };
        } else {
          return {
            category: "Risk Off",
            allocation: "100% SPY or 1×(100% SPY)",
          };
        }
      }
    } else {
      // SPY <= SMA
      if (isTreasuryFalling) {
        return {
          category: "Risk Alt",
          allocation:
            "25% UPRO + 75% ZROZ (long-duration zero-coupon bonds) or 1.5×(50% SPY + 50% ZROZ)",
        };
      } else {
        return {
          category: "Risk Off",
          allocation: "100% SPY or 1×(100% SPY)",
        };
      }
    }
  }

  /**
   * Banded RECOMMENDATION calculation (with updated threshold logic).
   * data must have: spy, sma220, volatility, treasuryRateChange
   */
  static determineRecommendationWithBands(data) {
    const spy = parseFloat(data.spy);
    const sma220 = parseFloat(data.sma220);
    const volatility = parseFloat(data.volatility);
    const treasuryChange = parseFloat(data.treasuryRateChange);

    // Strict states for fallback if in a "band"
    const isSpyAboveSmaMFEA = spy > sma220;
    const isVolBelow14MFEA = volatility < 14;
    const isVolBelow24MFEA = volatility < 24;

    // Band thresholds
    const smaBandPercent = 0.02; // ±2% around SMA
    const volBandAbsolute = 1.0; // ±1% around 14% / 24%
    // New treasury recommendation threshold
    const treasuryRecThreshold = -0.001; // -0.1%

    // Calculate band boundaries
    const smaLowerBand = sma220 * (1 - smaBandPercent);
    const smaUpperBand = sma220 * (1 + smaBandPercent);
    const vol14LowerBand = 14 - volBandAbsolute; // 13%
    const vol14UpperBand = 14 + volBandAbsolute; // 15%
    const vol24LowerBand = 24 - volBandAbsolute; // 23%
    const vol24UpperBand = 24 + volBandAbsolute; // 25%

    // "Effective" states
    let isSpyEffectivelyAboveSmaRec =
      spy > smaUpperBand ? true : spy < smaLowerBand ? false : isSpyAboveSmaMFEA;
    let isVolEffectivelyBelow14Rec =
      volatility < vol14LowerBand
        ? true
        : volatility > vol14UpperBand
        ? false
        : isVolBelow14MFEA;
    let isVolEffectivelyBelow24Rec =
      volatility < vol24LowerBand
        ? true
        : volatility > vol24UpperBand
        ? false
        : isVolBelow24MFEA;

    const isTreasuryFallingRec = treasuryChange < treasuryRecThreshold;

    Logger.debug(
      `REC Checks: SPY in band? [${smaLowerBand.toFixed(2)}-${smaUpperBand.toFixed(2)}], ` +
        `VOL14 in band? [${vol14LowerBand}-${vol14UpperBand}], ` +
        `VOL24 in band? [${vol24LowerBand}-${vol24UpperBand}], ` +
        `TrsFalling? ${isTreasuryFallingRec} (threshold ${treasuryRecThreshold}).`
    );

    const recommendedResult = this.calculateAllocationLogic(
      isSpyEffectivelyAboveSmaRec,
      isVolEffectivelyBelow14Rec,
      isVolEffectivelyBelow24Rec,
      isTreasuryFallingRec
    );

    // Provide "band info" for display
    const bandInfo = {
      spyValue: spy.toFixed(2),
      smaValue: sma220.toFixed(2),
      smaLower: smaLowerBand.toFixed(2),
      smaUpper: smaUpperBand.toFixed(2),
      isSpyInSmaBand: spy >= smaLowerBand && spy <= smaUpperBand,

      volValue: volatility.toFixed(2),
      vol14Lower: vol14LowerBand.toFixed(2),
      vol14Upper: vol14UpperBand.toFixed(2),
      vol24Lower: vol24LowerBand.toFixed(2),
      vol24Upper: vol24UpperBand.toFixed(2),
      isVolIn14Band: volatility >= vol14LowerBand && volatility <= vol14UpperBand,
      isVolIn24Band: volatility >= vol24LowerBand && volatility <= vol24UpperBand,

      trsChange: treasuryChange.toFixed(4),
      trsMFEAThreshold: -0.0001,
      trsRecThreshold: treasuryRecThreshold,
      isTreasuryInBand: treasuryChange >= treasuryRecThreshold && treasuryChange < -0.0001,
    };

    return {
      recommendedCategory: recommendedResult.category,
      recommendedAllocation: recommendedResult.allocation,
      bandInfo: bandInfo,
    };
  }
}

//======================================================//
//  Financial Data Fetching: MFEA (/check) & Ticker (/ticker)
//======================================================//
class FinancialDataService {
  /**
   * Fetch data for /check:
   * - 220d data for SPY + parse out SMA
   * - 50d data for IRX + parse out 1-month-later comparison
   * - 40d data for SPY to compute volatility from last 21 daily returns
   */
  static async fetchMfeaData() {
    Logger.debug("Fetching MFEA data for /check command...");

    try {
      const [spySMAResponse, treasuryResponse, spyVolResponse] = await Promise.all([
        axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=220d"),
        axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=50d"),
        axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=40d"),
      ]);

      // --- SPY Price and SMA ---
      const spyData = spySMAResponse.data;
      if (
        !spyData.chart?.result?.[0]?.meta?.regularMarketPrice ||
        !spyData.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose
      ) {
        throw new Error("Invalid SPY data for SMA.");
      }
      const spyPrice = spyData.chart.result[0].meta.regularMarketPrice;
      const spyAdjClosePrices = spyData.chart.result[0].indicators.adjclose[0].adjclose;

      if (!spyAdjClosePrices || spyAdjClosePrices.length < 220) {
        throw new Error("Not enough data for 220-day SMA.");
      }

      const validSpyPrices = spyAdjClosePrices
        .slice(-220)
        .filter((p) => typeof p === "number" && p !== null && p > 0);

      if (validSpyPrices.length < 220) {
        Logger.debug(`Warning: Only ${validSpyPrices.length} valid prices for SMA.`);
        if (validSpyPrices.length === 0) {
          throw new Error("No valid SPY prices for SMA.");
        }
      }

      const sum220 = validSpyPrices.reduce((acc, price) => acc + price, 0);
      const sma220 = sum220 / validSpyPrices.length;
      const spyStatus = spyPrice > sma220 ? "Over" : "Under";

      Logger.debug(
        `SPY Price: ${spyPrice}, SMA220: ${sma220.toFixed(2)}, Status: ${spyStatus}`
      );

      // --- Treasury Data (IRX) ---
      const treasuryData = treasuryResponse.data.chart.result[0];
      if (
        !treasuryData ||
        !treasuryData.indicators?.quote?.[0]?.close ||
        !treasuryData.timestamp
      ) {
        throw new Error("Invalid Treasury data structure.");
      }

      const treasuryRatesRaw = treasuryData.indicators.quote[0].close;
      const treasuryTimestampsRaw = treasuryData.timestamp;
      const validTreasuryData = treasuryTimestampsRaw
        .map((ts, i) => ({ timestamp: ts, rate: treasuryRatesRaw[i] }))
        .filter(
          (item) => item.timestamp != null && typeof item.rate === "number" && item.rate !== null
        )
        .sort((a, b) => a.timestamp - b.timestamp);

      if (validTreasuryData.length < 22) {
        throw new Error(
          `Not enough valid Treasury points (need 22, got ${validTreasuryData.length}).`
        );
      }

      const lastIndex = validTreasuryData.length - 1;
      const latestTreasuryEntry = validTreasuryData[lastIndex];
      const currentTreasuryRateValue = latestTreasuryEntry.rate;
      const targetIndex = lastIndex - 21;
      const oneMonthAgoEntry = validTreasuryData[targetIndex];
      const oneMonthAgoTreasuryRateValue = oneMonthAgoEntry.rate;
      const treasuryRateChangeValue = currentTreasuryRateValue - oneMonthAgoTreasuryRateValue;
      const isTreasuryFallingStrict = treasuryRateChangeValue < -0.0001;

      Logger.debug(
        `Treasury Rate Change: ${treasuryRateChangeValue.toFixed(4)}, ` +
          `IsFalling(Strict)? ${isTreasuryFallingStrict}`
      );

      // --- SPY Volatility (21 daily returns) ---
      const spyVolData = spyVolResponse.data;
      if (!spyVolData.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose) {
        throw new Error("Invalid SPY data for volatility.");
      }
      const spyVolAdjClose = spyVolData.chart.result[0].indicators.adjclose[0].adjclose;
      const validVolPrices = spyVolAdjClose.filter(
        (p) => typeof p === "number" && p !== null && p > 0
      );

      if (validVolPrices.length < 22) {
        throw new Error(
          `Not enough valid data for 22-day prices (need 22, got ${validVolPrices.length}).`
        );
      }

      // last 22
      const relevantVolPrices = validVolPrices.slice(-22);
      // 21 daily returns
      const spyVolDailyReturns = relevantVolPrices.slice(1).map((price, idx) => {
        const prevPrice = relevantVolPrices[idx];
        return prevPrice === 0 ? 0 : price / prevPrice - 1;
      });

      if (spyVolDailyReturns.length !== 21) {
        throw new Error(
          `Incorrect number of returns for vol calc (expected 21, got ${spyVolDailyReturns.length})`
        );
      }

      const meanReturn = spyVolDailyReturns.reduce((acc, r) => acc + r, 0) / spyVolDailyReturns.length;
      const variance =
        spyVolDailyReturns.reduce((acc, r) => acc + Math.pow(r - meanReturn, 2), 0) /
        spyVolDailyReturns.length;

      const dailyVolatility = Math.sqrt(variance);
      const annualizedVolatility = dailyVolatility * Math.sqrt(252) * 100;

      Logger.debug(
        `Calculated Annualized Volatility (21 returns): ${annualizedVolatility.toFixed(2)}%`
      );

      // Return the combined data
      return {
        spy: parseFloat(spyPrice).toFixed(2),
        sma220: sma220.toFixed(2),
        spyStatus,
        volatility: annualizedVolatility.toFixed(2),
        treasuryRate: currentTreasuryRateValue.toFixed(3),
        isTreasuryFalling: isTreasuryFallingStrict,
        treasuryRateChange: treasuryRateChangeValue.toFixed(4),
      };
    } catch (error) {
      console.error("Error fetching financial data:", error);
      if (error.response) {
        console.error("Axios Error Data:", error.response.data);
        console.error("Axios Error Status:", error.response.status);
      }
      throw new Error("Failed to fetch financial data");
    }
  }

  /**
   * Fetch data for /ticker command (unchanged from original except reorganized).
   */
  static async fetchTickerData(ticker, range) {
    try {
      const rangeOptions = {
        "1d": { range: "1d", interval: "1m" },
        "1mo": { range: "1mo", interval: "5m" },
        "1y": { range: "1y", interval: "1d" },
        "3y": { range: "3y", interval: "1wk" },
        "10y": { range: "10y", interval: "1mo" },
      };
      const selectedRange = rangeOptions[range] ? range : "1d";
      const { range: yahooRange, interval } = rangeOptions[selectedRange];

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        ticker
      )}?interval=${interval}&range=${yahooRange}`;
      const tickerResponse = await axios.get(url);
      const tickerData = tickerResponse.data;

      // Basic validation
      if (
        !tickerData.chart.result ||
        tickerData.chart.result.length === 0 ||
        tickerData.chart.result[0].meta?.regularMarketPrice === undefined
      ) {
        if (tickerData.chart?.error?.description) {
          throw new Error(`Yahoo Finance error: ${tickerData.chart.error.description}`);
        }
        throw new Error("Invalid ticker symbol or data unavailable.");
      }

      const currentPrice = parseFloat(
        tickerData.chart.result[0].meta.regularMarketPrice
      ).toFixed(2);
      const timestamps = tickerData.chart.result[0].timestamp;
      let prices = [];

      // Attempt to get adjclose first; fallback to quote->close
      if (tickerData.chart.result[0].indicators?.adjclose?.[0]?.adjclose) {
        prices = tickerData.chart.result[0].indicators.adjclose[0].adjclose;
      } else if (tickerData.chart.result[0].indicators?.quote?.[0]?.close) {
        prices = tickerData.chart.result[0].indicators.quote[0].close;
      } else {
        throw new Error("Price data is unavailable.");
      }

      if (!timestamps || !prices || timestamps.length !== prices.length) {
        throw new Error("Incomplete historical data.");
      }

      const validHistoricalEntries = timestamps
        .map((ts, idx) => ({ timestamp: ts, price: prices[idx] }))
        .filter(
          (entry) => entry.timestamp != null && typeof entry.price === "number" && entry.price != null
        );

      // Convert into date/price pairs
      const selectedRangeUpper = selectedRange.toUpperCase();
      const historicalData = validHistoricalEntries.map((entry) => {
        const dateObj = new Date(entry.timestamp * 1000);
        const options = { timeZone: "America/New_York" };
        let dateLabel = "";

        if (selectedRange === "1d") {
          options.hour = "2-digit";
          options.minute = "2-digit";
          options.hour12 = true;
          dateLabel = dateObj.toLocaleString("en-US", options);
        } else if (selectedRange === "1mo") {
          options.month = "short";
          options.day = "numeric";
          options.hour = "2-digit";
          options.minute = "2-digit";
          options.hour12 = true;
          dateLabel = dateObj.toLocaleString("en-US", options);
        } else {
          options.month = "short";
          options.day = "numeric";
          options.year = "numeric";
          dateLabel = dateObj.toLocaleDateString("en-US", options);
        }

        return { date: dateLabel, price: entry.price };
      });

      // For 10y, aggregate monthly
      let aggregatedData = historicalData;
      if (selectedRange === "10y" && validHistoricalEntries.length > 0) {
        Logger.debug(`Aggregating 10y data for ${ticker}...`);
        const monthlyMap = {};

        validHistoricalEntries.forEach((entry) => {
          const dateObj = new Date(entry.timestamp * 1000);
          if (dateObj && !isNaN(dateObj.getTime())) {
            const monthKey = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(
              2,
              "0"
            )}`;
            if (!monthlyMap[monthKey]) {
              const monthLabel = dateObj.toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
                timeZone: "America/New_York",
              });
              monthlyMap[monthKey] = { sum: 0, count: 0, label: monthLabel };
            }
            monthlyMap[monthKey].sum += entry.price;
            monthlyMap[monthKey].count += 1;
          }
        });

        aggregatedData = Object.keys(monthlyMap)
          .sort()
          .map((key) => {
            const avgPrice = monthlyMap[key].sum / monthlyMap[key].count;
            return {
              date: monthlyMap[key].label,
              price: parseFloat(avgPrice).toFixed(2),
            };
          });

        Logger.debug(`Aggregated into ${aggregatedData.length} points.`);
      }

      return {
        ticker: ticker.toUpperCase(),
        currentPrice: `$${currentPrice}`,
        historicalData: aggregatedData.map((d) => ({ ...d, price: String(d.price) })),
        selectedRange: selectedRangeUpper,
      };
    } catch (error) {
      console.error("Error fetching financial data for /ticker:", error);
      throw new Error(
        error.response?.data?.chart?.error?.description
          ? error.response.data.chart.error.description
          : "Failed to fetch financial data."
      );
    }
  }
}

//========================================//
//   Main Interaction Handler / Export    //
//========================================//
class DiscordInteractionHandler {
  // The main entry point for the serverless function
  static async handleRequest(req, res) {
    Logger.debug("Received a new request");

    // Check method
    if (req.method !== "POST") {
      Logger.debug("Invalid method");
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    // Verify signature / timestamp
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    if (!signature || !timestamp) {
      console.error("Missing headers for signature verification");
      return res.status(401).json({ error: "Bad request signature" });
    }

    let rawBody;
    try {
      rawBody = await getRawBody(req, { encoding: "utf-8" });
    } catch (error) {
      console.error("Raw body error:", error);
      return res.status(400).json({ error: "Invalid request body" });
    }

    let message;
    try {
      message = JSON.parse(rawBody);
    } catch (error) {
      console.error("JSON parse error:", error);
      return res.status(400).json({ error: "Invalid JSON format" });
    }

    if (!process.env.PUBLIC_KEY) {
      console.error("PUBLIC_KEY not set in environment");
      return res.status(500).json({ error: "Internal server configuration error." });
    }

    const isValidRequest = verifyKey(rawBody, signature, timestamp, process.env.PUBLIC_KEY);
    if (!isValidRequest) {
      console.error("Invalid signature");
      return res.status(401).json({ error: "Bad request signature" });
    }

    Logger.debug("Signature verified");
    Logger.debug(`Message type: ${message.type}`);

    // Handle PING
    if (message.type === InteractionType.PING) {
      Logger.debug("Handling PING");
      return res.status(200).json({ type: InteractionResponseType.PONG });
    }

    // Handle Slash Commands
    if (message.type === InteractionType.APPLICATION_COMMAND) {
      const commandName = message.data.name.toLowerCase();

      switch (commandName) {
        // ================
        //    /hi
        // ================
        case HI_COMMAND.name.toLowerCase():
          try {
            Logger.debug("Handling /hi command");
            return res.status(200).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: "hii <3" },
            });
          } catch (error) {
            console.error("[ERROR] /hi:", error);
            return res.status(500).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: "⚠️ Error processing /hi." },
            });
          }

        // ================
        //   /check
        // ================
        case CHECK_COMMAND.name.toLowerCase():
          try {
            Logger.debug("Handling /check command");
            const financialData = await FinancialDataService.fetchMfeaData();

            // 1. Strict MFEA
            const { category: mfeaCategory, allocation: mfeaAllocation } =
              MfeaCalculator.determineStrictRiskCategory(financialData);

            // 2. Recommendation (with bands)
            const {
              recommendedCategory,
              recommendedAllocation,
              bandInfo,
            } = MfeaCalculator.determineRecommendationWithBands(financialData);

            // Format Treasury Rate Trend
            let treasuryRateTrendValue = "";
            const treasuryRateTimeframe = "last 21 trading days";
            const changeNum = parseFloat(financialData.treasuryRateChange);

            if (changeNum > 0.0001) {
              treasuryRateTrendValue = `⬆️ Increasing by ${Math.abs(changeNum).toFixed(
                3
              )}% since ${treasuryRateTimeframe}`;
            } else if (changeNum < -0.0001) {
              treasuryRateTrendValue = `⬇️ ${Math.abs(changeNum).toFixed(3)}% since ${treasuryRateTimeframe}`;
            } else {
              treasuryRateTrendValue = `↔️ No change since ${treasuryRateTimeframe}`;
            }

            // Band Influence Explanation
            let influences = [];
            const recommendationDiffers = mfeaAllocation !== recommendedAllocation;
            if (bandInfo.isSpyInSmaBand) influences.push("SPY within ±2% SMA");
            if (bandInfo.isVolIn14Band) influences.push("Vol within 13-15%");
            else if (bandInfo.isVolIn24Band) influences.push("Vol within 23-25%");
            if (bandInfo.isTreasuryInBand) {
              influences.push("Treasury change between Rec(-0.1%)/MFEA thresholds");
            } else if (
              recommendationDiffers &&
              !bandInfo.isSpyInSmaBand &&
              !bandInfo.isVolIn14Band &&
              !bandInfo.isVolIn24Band &&
              bandInfo.trsChange < bandInfo.trsRecThreshold
            ) {
              influences.push("Treasury change crossed Rec. threshold (<-0.1%)");
            }

            let bandInfluenceDescription = "";
            if (!recommendationDiffers) {
              bandInfluenceDescription =
                influences.length > 0
                  ? `Factors within bands: ${influences.join("; ")}. Recommendation aligns.`
                  : `All factors clear of bands. Recommendation aligns.`;
            } else {
              bandInfluenceDescription = `Recommendation differs. Influences: ${influences.join(
                "; "
              )}.`;
            }
            bandInfluenceDescription += `\n*Bands: ±2% SMA, ±1% Vol, <-0.1% Treas*`;

            // Construct embed
            return res.status(200).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                embeds: [
                  {
                    title: "MFEA Analysis Status & Recommendation",
                    color: 3447003,
                    fields: [
                      { name: "SPY Price", value: `$${financialData.spy}`, inline: true },
                      { name: "220-day SMA", value: `$${financialData.sma220}`, inline: true },
                      {
                        name: "SPY Status",
                        value: `${financialData.spyStatus} the 220-day SMA`,
                        inline: true,
                      },
                      { name: "Volatility", value: `${financialData.volatility}%`, inline: true },
                      {
                        name: "3-Month Treasury Rate",
                        value: `${financialData.treasuryRate}%`,
                        inline: true,
                      },
                      {
                        name: "Treasury Rate Trend",
                        value: treasuryRateTrendValue,
                        inline: true,
                      },
                      {
                        name: "📊 MFEA Category",
                        value: mfeaCategory,
                        inline: false,
                      },
                      {
                        name: "📈 MFEA Allocation",
                        value: `**${mfeaAllocation}**`,
                        inline: false,
                      },
                      {
                        name: "💡 Recommended Allocation",
                        value: `**${recommendedAllocation}**`,
                        inline: false,
                      },
                      {
                        name: "⚙️ Band Influence Analysis",
                        value: bandInfluenceDescription,
                        inline: false,
                      },
                    ],
                    footer: {
                      text: "MFEA = Strict Model | Recommendation includes rebalancing bands",
                    },
                    timestamp: new Date().toISOString(),
                  },
                ],
              },
            });
          } catch (error) {
            console.error("[ERROR] Failed processing /check command:", error);
            return res.status(500).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: `⚠️ Unable to retrieve financial data: ${
                  error.message || "Please try again later."
                }`,
              },
            });
          }

        // ================
        //   /ticker
        // ================
        case TICKER_COMMAND.name.toLowerCase():
          try {
            Logger.debug("Handling /ticker command");
            const options = message.data.options;
            const tickerOption = options.find((o) => o.name === "symbol");
            const timeframeOption = options.find((o) => o.name === "timeframe");

            const ticker = tickerOption ? tickerOption.value.toUpperCase() : null;
            const timeframe = timeframeOption ? timeframeOption.value : "1d";

            if (!ticker) {
              return res.status(400).json({
                type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                data: { content: "❌ Ticker symbol is required." },
              });
            }

            const tickerData = await FinancialDataService.fetchTickerData(ticker, timeframe);

            // QuickChart config
            const chartConfig = {
              type: "line",
              data: {
                labels: tickerData.historicalData.map((entry) => entry.date),
                datasets: [
                  {
                    label: `${tickerData.ticker} Price`,
                    data: tickerData.historicalData.map((entry) => entry.price),
                    borderColor: "#0070f3",
                    backgroundColor: "rgba(0, 112, 243, 0.1)",
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: true,
                  },
                ],
              },
              options: {
                scales: {
                  x: {
                    title: { display: true, text: "Date", color: "#333", font: { size: 14 } },
                    ticks: {
                      maxTicksLimit: 10,
                      color: "#333",
                      maxRotation: 0,
                      minRotation: 0,
                    },
                    grid: { display: false },
                  },
                  y: {
                    title: { display: true, text: "Price ($)", color: "#333", font: { size: 14 } },
                    ticks: { color: "#333" },
                    grid: { color: "rgba(0,0,0,0.1)", borderDash: [5, 5] },
                  },
                },
                plugins: {
                  legend: {
                    display: true,
                    labels: { color: "#333", font: { size: 12 } },
                  },
                  tooltip: {
                    enabled: true,
                    mode: "index",
                    intersect: false,
                    callbacks: {
                      label: function (context) {
                        const value = parseFloat(context.parsed?.y);
                        return !isNaN(value) ? `$${value.toFixed(2)}` : "N/A";
                      },
                    },
                  },
                },
              },
            };

            const chartConfigEncoded = encodeURIComponent(JSON.stringify(chartConfig));
            const chartUrl = `https://quickchart.io/chart?c=${chartConfigEncoded}&w=600&h=400&bkg=%23ffffff`;

            const embed = {
              title: `${tickerData.ticker} Financial Data`,
              color: 3447003,
              fields: [
                { name: "Current Price", value: tickerData.currentPrice, inline: true },
                { name: "Timeframe", value: timeframe.toUpperCase(), inline: true },
                { name: "Selected Range", value: tickerData.selectedRange, inline: true },
                { name: "Data Source", value: "Yahoo Finance", inline: true },
              ],
              image: { url: chartUrl },
              footer: { text: "Data fetched from Yahoo Finance" },
              timestamp: new Date().toISOString(),
            };

            return res.status(200).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { embeds: [embed] },
            });
          } catch (error) {
            console.error("[ERROR] /ticker:", error);
            return res.status(500).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content:
                  "⚠️ Unable to retrieve financial data at this time. Please ensure the ticker symbol is correct and try again later.",
              },
            });
          }

        //================
        //  Unknown Cmd
        //================
        default:
          console.error("[ERROR] Unknown command");
          return res.status(400).json({ error: "Unknown Command" });
      }
    }

    // Unknown/Unhandled interaction type
    console.error("[ERROR] Unknown request type");
    return res.status(400).json({ error: "Unknown Type" });
  }
}

// Export for serverless environment
module.exports = async (req, res) => {
  return DiscordInteractionHandler.handleRequest(req, res);
};
