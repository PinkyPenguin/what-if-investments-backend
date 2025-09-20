import express from 'express';
import cors from 'cors';
import yahooFinance from 'yahoo-finance2';
import serverless from 'serverless-http';

// =================================================================
// HELPER FUNCTIONS
// =================================================================

/**
 * Formats a large number into a human-readable currency string (e.g., "$2.95 Trillion").
 * @param {number} num - The raw number to format.
 * @returns {string} - The formatted string or 'N/A'.
 */
function formatMarketCap(num) {
  if (!num && num !== 0) return 'N/A';
  if (num < 1e9) return `$${(num / 1e6).toFixed(2)} Million`;
  if (num < 1e12) return `$${(num / 1e9).toFixed(2)} Billion`;
  return `$${(num / 1e12).toFixed(2)} Trillion`;
}

/**
 * Fetches qualitative company profile information like name, summary, and location.
 * @param {string} ticker - The stock ticker symbol.
 * @returns {object|null} - An object with company details or null if the request fails.
 */
async function getCompanyDetails(ticker) {
  try {
    const summary = await yahooFinance.quoteSummary(ticker, {
      modules: ['assetProfile', 'price']
    });

    const companyDetails = {
      fullName: summary.price?.longName,
      businessSummary: summary.assetProfile?.longBusinessSummary,
      sector: summary.assetProfile?.sector,
      industry: summary.assetProfile?.industry,
      location: `${summary.assetProfile?.city}, ${summary.assetProfile?.country}`,
      exchange: summary.price?.exchangeName
    };
    return companyDetails;
  } catch (error) {
    console.error(`Error fetching profile data for ${ticker}:`, error.message);
    return null;
  }
}

/**
 * Formats a Date object into a 'YYYY-MM-DD' string without timezone conversion issues.
 * This is crucial for preventing "off-by-one-day" errors.
 * @param {Date} date - The date object to format.
 * @returns {string} - The formatted date string.
 */
function formatDateToYMD(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}


// =================================================================
// EXPRESS APP SETUP
// =================================================================

const app = express();

app.use(cors());


// =================================================================
// MAIN API ENDPOINT
// =================================================================

app.get('/api/investment-data', async (req, res) => {
  const { ticker, startDate, amount } = req.query;

  if (!ticker || !startDate || !amount) {
    return res.status(400).json({ error: 'Missing required query parameters: ticker, startDate, amount' });
  }

  try {
    const [historicalData, quote, profileData, summaryData] = await Promise.all([
      yahooFinance.historical(ticker, { period1: startDate, interval: '1d' }),
      yahooFinance.quote(ticker),
      getCompanyDetails(ticker),
      yahooFinance.quoteSummary(ticker, {
        modules: ['defaultKeyStatistics', 'incomeStatementHistory', 'summaryDetail', 'financialData']
      })
    ]);

    if (historicalData.length === 0) {
      return res.status(404).json({ error: 'No historical data found for the given ticker and date.' });
    }

    // --- PARSE DATA FOR "END-OF-DAY SNAPSHOT" ---

    // The date of the last close is the date of the most recent item in historical data.
    // We use our timezone-safe formatter to prevent "off-by-one-day" errors.
    const lastTradingDayDate = formatDateToYMD(historicalData[historicalData.length - 1].date);

    // Resiliently parse revenue, falling back to TTM data if annual data is unavailable.
    let revenueValue = null;
    let revenueDate = null;
    let revenueLabel = 'Annual';
    const latestAnnualStatement = summaryData.incomeStatementHistory?.incomeStatementHistory?.[0];

    if (latestAnnualStatement?.totalRevenue && latestAnnualStatement?.endDate) {
      revenueValue = latestAnnualStatement.totalRevenue;
      const revenueDateString = latestAnnualStatement.endDate;
      revenueDate = formatDateToYMD(new Date(revenueDateString));
    }
    else if (summaryData.financialData?.totalRevenue?.raw) {
      revenueValue = summaryData.financialData.totalRevenue.raw;
      revenueDate = lastTradingDayDate;
      revenueLabel = 'TTM';
    }

    const beta = summaryData.summaryDetail?.beta;
    const sharesOutstanding = summaryData.defaultKeyStatistics?.sharesOutstanding;

    // Calculate market cap based on the previous close price for data consistency.
    const calculatedMarketCap = (quote.regularMarketPreviousClose && sharesOutstanding)
      ? quote.regularMarketPreviousClose * sharesOutstanding
      : quote.marketCap;


    // --- PERFORM INVESTMENT CALCULATIONS ---
    const initialInvestment = parseFloat(amount);
    const startingPrice = historicalData[0].adjClose;
    const sharesPurchased = initialInvestment / startingPrice;
    const currentValue = sharesPurchased * quote.regularMarketPrice;

    // --- ASSEMBLE THE FINAL, COMBINED RESPONSE ---
    const result = {
      summary: {
        initialInvestment: initialInvestment,
        currentValue: parseFloat(currentValue.toFixed(2)),
        totalReturnDollars: parseFloat((currentValue - initialInvestment).toFixed(2)),
        totalReturnPercent: parseFloat((((currentValue - initialInvestment) / initialInvestment) * 100).toFixed(2)),
        ticker: ticker.toUpperCase(),
        startDate: startDate,
        sharesOwned: parseFloat(sharesPurchased.toFixed(6)),
        // Provide an explicit timestamp for "current value" calculations.
        requestTimestamp: new Date().toISOString()
      },
      chartData: historicalData.map(day => ({
        date: formatDateToYMD(day.date), // Use timezone-safe formatter here too.
        value: parseFloat((sharesPurchased * day.adjClose).toFixed(2)),
        price: parseFloat(day.adjClose.toFixed(2))
      })),
      profile: {
        name: profileData?.fullName || ticker.toUpperCase(),
        sector: profileData?.sector || 'N/A',
        industry: profileData?.industry || 'N/A',
        summary: profileData?.businessSummary || 'No summary available.',
        location: profileData?.location || 'N/A',
        exchange: profileData?.exchange || 'N/A'
      },
      metrics: {
        previousClose: {
            value: historicalData[historicalData.length - 1].adjClose,
            asOfDate: lastTradingDayDate
        },
        marketCap: {
          value: calculatedMarketCap,
          asOfDate: lastTradingDayDate
        },
        totalRevenue: {
          value: revenueValue,
          asOfDate: revenueDate,
          label: revenueLabel
        },
        beta: {
          value: beta
        }
      }
    };

    return res.status(200).json(result);

  } catch (error) {
    console.error(`Error in main endpoint for ${ticker}:`, error.message);
    if (error.code === '404' || error.message?.includes('Not Found')) {
      return res.status(404).json({ error: `Invalid ticker symbol: ${ticker}` });
    }
    return res.status(500).json({ error: 'An internal server error occurred.' });
  }
});


// =================================================================
// LAMBDA HANDLER EXPORT
// =================================================================

// This is the correct, robust export pattern
const lambda = serverless(app);

export const handler = async (event, context) => {
  return await lambda(event, context);
};