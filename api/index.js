// api/index.js

const {
    InteractionResponseType,
    InteractionType,
    verifyKey,
} = require("discord-interactions");
const getRawBody = require("raw-body");

// Define your commands
const HI_COMMAND = { name: "hi", description: "Say hello!" };
const CHECK_COMMAND = { name: "check", description: "Display MFEA analysis status." };
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

// Preset image URLs for /ticker command
const PRESET_IMAGES = [
    "https://via.placeholder.com/800x400.png?text=Financial+Chart+1",
    "https://via.placeholder.com/800x400.png?text=Financial+Chart+2",
    "https://via.placeholder.com/800x400.png?text=Financial+Chart+3",
    "https://via.placeholder.com/800x400.png?text=Financial+Chart+4",
    "https://via.placeholder.com/800x400.png?text=Financial+Chart+5",
];

// Helper function to log debug messages
function logDebug(message) {
    console.log(`[DEBUG] ${message}`);
}

// Main handler
module.exports = async (req, res) => {
    logDebug("Received a new request");

    if (req.method !== "POST") {
        logDebug("Invalid method, returning 405");
        res.status(405).json({ error: "Method Not Allowed" });
        return; // Terminate after responding
    }

    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];

    if (!signature || !timestamp) {
        console.error("[ERROR] Missing signature or timestamp headers");
        res.status(401).json({ error: "Bad request signature" });
        return; // Terminate after responding
    }

    let rawBody;
    try {
        rawBody = await getRawBody(req, {
            encoding: "utf-8",
        });
    } catch (error) {
        console.error("[ERROR] Failed to get raw body:", error);
        res.status(400).json({ error: "Invalid request body" });
        return; // Terminate after responding
    }

    let message;
    try {
        message = JSON.parse(rawBody);
    } catch (error) {
        console.error("[ERROR] Failed to parse JSON:", error);
        res.status(400).json({ error: "Invalid JSON format" });
        return; // Terminate after responding
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
        return; // Terminate after responding
    }

    logDebug(`Message type: ${message.type}`);

    if (message.type === InteractionType.PING) {
        logDebug("Handling PING");
        res.status(200).json({ type: InteractionResponseType.PONG });
        logDebug("PONG sent");
        return; // Terminate after responding
    }

    if (message.type === InteractionType.APPLICATION_COMMAND) {
        const commandName = message.data.name.toLowerCase();
        switch (commandName) {
            case HI_COMMAND.name.toLowerCase():
                logDebug("Handling /hi command");
                res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: { content: "Hello! 👋 How can I assist you today?" },
                });
                logDebug("/hi command successfully executed");
                return; // Terminate after responding

            case CHECK_COMMAND.name.toLowerCase():
                logDebug("Handling /check command");

                // Preset data for /check command
                const presetCheckEmbed = {
                    title: "MFEA Analysis Status",
                    color: 3447003, // Blue color
                    fields: [
                        { name: "SPY Price", value: `$450.25`, inline: true },
                        { name: "220-day SMA", value: `$430.50`, inline: true },
                        { name: "SPY Status", value: `Over the 220-day SMA`, inline: true },
                        { name: "Volatility", value: `12.5%`, inline: true },
                        { name: "3-Month Treasury Rate", value: `1.75%`, inline: true },
                        { name: "Treasury Rate Trend", value: `Increasing by 0.25%`, inline: true },
                        { 
                            name: "📈 **Risk Category**", 
                            value: `Risk Mid`, 
                            inline: false 
                        },
                        { 
                            name: "💡 **Allocation Recommendation**", 
                            value: `**100% SSO (2× S&P 500) or 2×(100% SPY)**`, 
                            inline: false 
                        },
                    ],
                    footer: {
                        text: "MFEA Recommendation based on current market conditions",
                    },
                };

                res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: {
                        embeds: [presetCheckEmbed],
                    },
                });
                logDebug("/check command successfully executed with preset data");
                return; // Terminate after responding

            case TICKER_COMMAND.name.toLowerCase():
                logDebug("Handling /ticker command");

                // Extract options
                const options = message.data.options;
                const tickerOption = options.find(option => option.name === "symbol");
                const timeframeOption = options.find(option => option.name === "timeframe");

                const ticker = tickerOption ? tickerOption.value.toUpperCase() : null;
                const timeframe = timeframeOption ? timeframeOption.value : '1d'; // Default to '1d' if not provided

                if (!ticker) {
                    res.status(400).json({
                        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                        data: { content: "❌ Ticker symbol is required." },
                    });
                    return; // Terminate after responding
                }

                // Select a random preset image
                const randomImage = PRESET_IMAGES[Math.floor(Math.random() * PRESET_IMAGES.length)];

                // Preset data for /ticker command
                const presetTickerEmbed = {
                    title: `${ticker} Financial Data`,
                    color: 3447003, // Blue color
                    fields: [
                        { name: "Current Price", value: `$350.75`, inline: true },
                        { name: "Timeframe", value: timeframe.toUpperCase(), inline: true },
                    ],
                    image: {
                        url: randomImage,
                    },
                    footer: {
                        text: "Data fetched from Yahoo Finance",
                    },
                };

                res.status(200).json({
                    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
                    data: {
                        embeds: [presetTickerEmbed],
                    },
                });
                logDebug("/ticker command successfully executed with preset data and random image");
                return; // Terminate after responding

            default:
                console.error("[ERROR] Unknown command");
                res.status(400).json({ error: "Unknown Command" });
                return; // Terminate after responding
        }
    } else {
        console.error("[ERROR] Unknown request type");
        res.status(400).json({ error: "Unknown Type" });
        return; // Terminate after responding
    }
};
