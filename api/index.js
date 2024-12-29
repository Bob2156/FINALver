// api/index.js
const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");
const axios = require("axios");

// Define your commands
const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Display MFEA analysis status." };

// Helper function to log debug messages
function logDebug(message) {
    console.log(`[DEBUG] ${message}`);
}

// Helper function to fetch financial data
async function fetchFinancialData() {
    try {
        // Fetch S&P 500 (price and historical data for 220 days), Treasury Rate (30 days), and VIX concurrently
        const [sp500Response, treasuryResponse, vixResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=220d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX?interval=1d&range=30d"), // Fetch 30 days for Treasury rate
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=2d"), // Fetch 2 days to ensure latest value
        ]);

        const sp500Data = sp500Response.data;
        const treasuryData = treasuryResponse.data;
        const vixData = vixResponse.data;

        // Extract S&P 500 price
        const sp500Price = sp500Data.chart.result[0].meta.regularMarketPrice;
        logDebug(`SPX Price: ${sp500Price}`);

        // Extract 220-day SMA
        const sp500Prices = sp500Data.chart.result[0].indicators.adjclose[0].adjclose;
        if (sp500Prices.length < 220) {
            throw new Error("Not enough data to calculate 220-day SMA.");
        }
        const sum220 = sp500Prices.slice(-220).reduce((acc, price) => acc + price, 0);
        const sma220 = (sum220 / 220).toFixed(2);
        logDebug(`220-day SMA: ${sma220}`);

        // Extract 3-Month Treasury Rate
        // Corrected to use 'close' instead of 'adjclose'
        const treasuryRates = treasuryData.chart.result[0].indicators.quote[0].close;
        if (!treasuryRates || treasuryRates.length === 0) {
            throw new Error("Treasury rate data is unavailable.");
        }
        const currentTreasuryRate = parseFloat(treasuryRates[treasuryRates.length - 1]).toFixed(2);
        const oneMonthAgoTreasuryRate = treasuryRates.length >= 30
            ? parseFloat(treasuryRates[treasuryRates.length - 30]).toFixed(2)
            : parseFloat(treasuryRates[0]).toFixed(2); // Handle cases with less than 30 data points
        logDebug(`Current 3-Month Treasury Rate: ${currentTreasuryRate}%`);
        logDebug(`3-Month Treasury Rate 30 Days Ago: ${oneMonthAgoTreasuryRate}%`);

        // Determine if Treasury rate is falling
        const isTreasuryFalling = currentTreasuryRate < oneMonthAgoTreasuryRate;
        logDebug(`Is Treasury Rate Falling: ${isTreasuryFalling}`);

        // Extract Volatility (VIX)
        const vixValues = vixData.chart.result[0].indicators.quote[0].close;
        // Handle cases where VIX might not be available or null
        const validVixValues = vixValues.filter(v => v !== null && v !== undefined);
        const currentVix = validVixValues.length > 0 ? parseFloat(validVixValues[validVixValues.length - 1]).toFixed(2) : null;
        if (currentVix === null) {
            throw new Error("VIX data is unavailable.");
        }
        logDebug(`Current VIX (Volatility): ${currentVix}%`);

        return {
            sp500: parseFloat(sp500Price).toFixed(2),
            sma220: parseFloat(sma220).toFixed(2),
            volatility: parseFloat(currentVix).toFixed(2),
            treasuryRate: parseFloat(currentTreasuryRate).toFixed(2),
            isTreasuryFalling: isTreasuryFalling,
        };
    }

    // Helper function to determine risk category and allocation
    function determineRiskCategory(data) {
        const { sp500, sma220, volatility, treasuryRate, isTreasuryFalling } = data;

        logDebug(`Determining risk category with SPX: ${sp500}, SMA220: ${sma220}, VIX: ${volatility}, Treasury Rate: ${treasuryRate}, Is Treasury Falling: ${isTreasuryFalling}`);

        if (sp500 > sma220) {
            if (volatility < 14) {
                return {
                    category: "Risk On",
                    allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
                };
            } else if (volatility < 24) {
                return {
                    category: "Risk Mid",
                    allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
                };
            } else {
                if (isTreasuryFalling) {
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
        } else {
            // Corrected Logic: Directly evaluate Treasury Rate trend without considering volatility
            if (isTreasuryFalling) {
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

    // Main handler
    module.exports = async (req, res) => {
        logDebug("Received a new request");

        if (req.method !== "POST") {
            logDebug("Invalid method, returning 405");
            res.status(405).json({ error: "Method Not Allowed" });
            return;
        }

        const signature = req.headers["x-signature-ed25519"];
        const timestamp = req.headers["x-signature-timestamp"];

        if (!signature || !timestamp) {
            console.error("[ERROR] Missing signature or timestamp headers");
            res.status(401).json({ error: "Bad request signature" });
            return;
        }

        let rawBody;
        try {
            rawBody = await getRawBody(req, {
                encoding: "utf-8",
            });
        } catch (error) {
            console.error("[ERROR] Failed to get raw body:", error);
            res.status(400).json({ error: "Invalid request body" });
            return;
        }

        const isValidRequest = verifyKey(
            rawBody,
            signature,
            timestamp,
            process.env.PUBLIC_KEY
        );

        if (!isValidRequest) {
            console.error("[ERROR] Invalid request signature");
            res.status(401).json({ error: "Bad request signature" });
            return;
        }

        let message;
        try {
            message = JSON.parse(rawBody);
        } catch (error) {
            console.error("[ERROR] Failed to parse JSON:", error);
            res.status(400).json({ error: "Invalid JSON format" });
            return;
        }

        logDebug(`Message type: ${message.type}`);

        if (message.type === InteractionType.PING) {
            logDebug("Handling PING");
            res.status(200).json({ type: InteractionResponseType.PONG });
            return;
        }

        if (message.type === InteractionType.APPLICATION_COMMAND) {
            const commandName = message.data.name.toLowerCase();
            switch (commandName) {
                case HI_COMMAND.name.toLowerCase():
                    logDebug("Handling /hi command");
                    res.status(200).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "Hello!" },
                    });
                    logDebug("/hi command successfully executed");
                    break;

                case CHECK_COMMAND.name.toLowerCase():
                    logDebug("Handling /check command");

                    try {
                        // Fetch financial data
                        const financialData = await fetchFinancialData();

                        // Determine risk category and allocation
                        const { category, allocation } = determineRiskCategory(financialData);

                        // Send the formatted embed with actual data and recommendation
                        res.status(200).json({
                            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                            data: {
                                embeds: [
                                    {
                                        title: "MFEA Analysis Status",
                                        color: 3447003, // Blue banner
                                        fields: [
                                            { name: "S&P 500 Price", value: `$${financialData.sp500}`, inline: true },
                                            { name: "220-day SMA", value: `$${financialData.sma220}`, inline: true },
                                            { name: "Volatility (VIX)", value: `${financialData.volatility}%`, inline: true },
                                            { name: "3-Month Treasury Rate", value: `${financialData.treasuryRate}%`, inline: true },
                                            { name: "Treasury Rate Trend", value: financialData.isTreasuryFalling ? "Falling" : "Not Falling", inline: true },
                                            { name: "Risk Category", value: category, inline: false },
                                            { name: "Allocation Recommendation", value: allocation, inline: false },
                                        ],
                                        footer: {
                                            text: "MFEA Recommendation based on current market conditions",
                                        },
                                    },
                                ],
                            },
                        });
                        logDebug("/check command successfully executed with fetched data");
                    } catch (error) {
                        console.error("[ERROR] Failed to fetch financial data for /check command", error);
                        res.status(500).json({
                            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                            data: { content: "Failed to fetch financial data." }
                        });
                    }

                    break;

                default:
                    console.error("[ERROR] Unknown command");
                    res.status(400).json({ error: "Unknown Command" });
            }
        } else {
            console.error("[ERROR] Unknown request type");
            res.status(400).json({ error: "Unknown Type" });
        }
    };
    ```

### **Key Changes Explained**

1. **Corrected Decision Tree Logic in `determineRiskCategory`:**
   
   - **Original Logic Flaw:**
     - For **SPX ≤ 220 SMA**, the bot was evaluating **volatility < 24%** to allocate to **Risk Mid** instead of directly assessing the **3-Month Treasury Rate**.
   
   - **Corrected Logic:**
     - When **SPX ≤ 220 SMA**, the bot **directly checks** if the **3-Month Treasury Rate is falling** to allocate to **Risk Alt** or **Risk Off**.
   
   - **Implementation:**
     ```javascript
     if (sp500 > sma220) {
         if (volatility < 14) {
             return {
                 category: "Risk On",
                 allocation: "100% UPRO (3× leveraged S&P 500) or 3×(100% SPY)",
             };
         } else if (volatility < 24) {
             return {
                 category: "Risk Mid",
                 allocation: "100% SSO (2× S&P 500) or 2×(100% SPY)",
             };
         } else {
             if (isTreasuryFalling) {
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
     } else {
         // Directly evaluate Treasury Rate trend without considering volatility
         if (isTreasuryFalling) {
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
     ```

2. **Corrected Data Extraction for 3-Month Treasury Rate:**
   
   - **Issue:** The Treasury rate was being extracted from `adjclose`, which is incorrect.
   
   - **Fix:** Changed to extract from the `close` field.
   
   - **Implementation:**
     ```javascript
     const treasuryRates = treasuryData.chart.result[0].indicators.quote[0].close;
     ```

3. **Enhanced Logging for Better Traceability:**
   
   - **Purpose:** To ensure that each step is transparent and to aid in debugging.
   
   - **Implementation:** Added `logDebug` statements after extracting each financial metric.
   
   - **Example:**
     ```javascript
     logDebug(`SPX Price: ${sp500Price}`);
     logDebug(`220-day SMA: ${sma220}`);
     logDebug(`Current 3-Month Treasury Rate: ${currentTreasuryRate}%`);
     logDebug(`3-Month Treasury Rate 30 Days Ago: ${oneMonthAgoTreasuryRate}%`);
     logDebug(`Is Treasury Rate Falling: ${isTreasuryFalling}`);
     logDebug(`Current VIX (Volatility): ${currentVix}%`);
     logDebug(`Determining risk category with SPX: ${sp500}, SMA220: ${sma220}, VIX: ${volatility}, Treasury Rate: ${treasuryRate}, Is Treasury Falling: ${isTreasuryFalling}`);
     ```

4. **Minor Adjustments for Data Validity:**
   
   - **VIX Data Fetching:** Changed the VIX data range to 2 days to ensure at least one valid data point is retrieved.
   
   - **Treasury Rate Fallback:** Ensured that if there are fewer than 30 data points, the earliest available rate is used without causing an error.

### **Testing the Updated Bot**

To ensure that the bot now correctly categorizes the market as **Risk Alt**, follow these steps:

1. **Deploy the Updated Code:**
   
   - **Commit and Push:** Ensure that the revised `api/index.js` is committed and pushed to your GitHub repository.
   - **Vercel Deployment:** Vercel should automatically redeploy your project. If not, trigger a manual deployment via the Vercel dashboard.

2. **Verify Environment Variables:**
   
   - **Ensure Correct Setup:** Confirm that all required environment variables (`DISCORD_BOT_TOKEN`, `APPLICATION_ID`, `PUBLIC_KEY`) are correctly set in Vercel's dashboard.

3. **Invoke the `/check` Command in Discord:**
   
   - **Expected Outcome:** Based on your current market conditions (e.g., **SPX ≤ 220 SMA** and **Treasury Rate is Falling**), the bot should categorize the market as **Risk Alt** and provide the corresponding allocation recommendation.
   
   - **Sample Output Embed:**
     ```
     MFEA Analysis Status
     S&P 500 Price: $4,500.00
     220-day SMA: $4,300.00
     Volatility (VIX): 25.00%
     3-Month Treasury Rate: 1.50%
     Treasury Rate Trend: Falling
     Risk Category: Risk Alt
     Allocation Recommendation: 25% UPRO + 75% ZROZ (long‑duration zero‑coupon bonds) or 1.5×(50% SPY + 50% ZROZ)
     Footer: MFEA Recommendation based on current market conditions
     ```

4. **Cross-Check Financial Metrics:**
   
   - **Accuracy:** Compare the displayed financial metrics (SPX Price, 220-day SMA, VIX, 3-Month Treasury Rate) with reliable financial sources like [Yahoo Finance](https://finance.yahoo.com/) to ensure they are accurate.

5. **Review Logs for Debugging:**
   
   - **Access Vercel Logs:** Navigate to your Vercel project's dashboard and review the deployment logs.
   - **Verify Data Flow:** Ensure that all debug statements are logging the correct values and that the decision-making process aligns with the fetched data.

6. **Confirm Risk Category Allocation:**
   
   - **Scenario:** For **SPX ≤ 220 SMA** and **Treasury Rate is Falling**, the bot should allocate to **Risk Alt**.
   - **Verification:** The embed should reflect **Risk Alt** with the appropriate allocation recommendation.

### **Final Notes**

- **Minimal Changes:** The primary adjustments involved correcting the decision tree logic and ensuring accurate data extraction for the 3-Month Treasury Rate.
- **Enhanced Logging:** These additions will help monitor the bot's behavior and quickly identify any future discrepancies.
- **Testing:** Thoroughly test under different market conditions to ensure all paths in the decision tree are functioning as intended.

### **Conclusion**

By implementing the above **minimal and precise changes**, your MFEA Discord bot should now correctly categorize the market as **Risk Alt** when **SPX ≤ 220 SMA** and the **3-Month Treasury Rate is Falling**, without erroneously considering volatility in this scenario. This ensures that your investment allocation recommendations are aligned with your specified decision tree logic.

If you continue to encounter issues or need further assistance, please provide specific details or error messages, and I'll be happy to help you troubleshoot further.

Happy Investing and Coding! 🚀
