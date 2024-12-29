// api/fetchData.js
const axios = require("axios");
module.exports = async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method Not Allowed" });
        return;
    }
    try {
        // Fetch S&P 500 (price and historical data) and Treasury Rate concurrently
        const [sp500Response, treasuryResponse] = await Promise.all([
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=21d"),
            axios.get("https://query1.finance.yahoo.com/v8/finance/chart/%5EIRX"),
        ]);
        const sp500Data = sp500Response.data;
        const treasuryData = treasuryResponse.data;
        // Extract S&P 500 price
        const sp500Price = sp500Data.chart.result[0].meta.regularMarketPrice;
        // Extract 3-Month Treasury Rate
        const treasuryRate = treasuryData.chart.result[0].meta.regularMarketPrice;
        // Calculate volatility
        const prices = sp500Data.chart.result[0].indicators.adjclose[0].adjclose; // Historical adjusted close prices
        const returns = prices.slice(1).map((p, i) => (p / prices[i] - 1)); // Daily returns
        const dailyVolatility = Math.sqrt(
            returns.reduce((sum, r) => sum + r ** 2, 0) / returns.length
        ); // Standard deviation
        const annualizedVolatility = (dailyVolatility * Math.sqrt(252) * 100).toFixed(2); // Annualized volatility as percentage
        // Return all values
        res.status(200).json({
            sp500: sp500Price,
            treasuryRate: treasuryRate,
            sp500Volatility: `${annualizedVolatility}%`,
        });
    } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).json({ error: "Failed to fetch financial data" });
    }
};
