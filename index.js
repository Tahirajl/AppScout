require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const SERPAPI_URL = 'https://serpapi.com/search.json';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function monthsBetween(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return null;
  const now = new Date();
  return (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
}

function calculateOpportunityScore({ rating, reviews, monthsSinceUpdate }) {
  let score = 50;

  if (typeof reviews === 'number') {
    if (reviews < 100) score += 25;
    else if (reviews < 500) score += 15;
    else if (reviews < 1000) score += 10;
  }

  if (typeof rating === 'number') {
    if (rating < 3.5) score += 15;
    else if (rating < 4.0) score += 10;
  }

  if (typeof monthsSinceUpdate === 'number') {
    if (monthsSinceUpdate > 12) score += 20;
    else if (monthsSinceUpdate > 6) score += 10;
  }

  return Math.min(100, score);
}

function pickRating(app) {
  if (Array.isArray(app.rating) && app.rating.length > 0) {
    const all = app.rating.find((r) => r.type === 'All Times') || app.rating[0];
    return all?.rating ?? null;
  }
  if (typeof app.rating === 'number') return app.rating;
  return app.average_rating ?? app.ratings?.average ?? null;
}

function pickReviewCount(app) {
  if (Array.isArray(app.rating) && app.rating.length > 0) {
    const all = app.rating.find((r) => r.type === 'All Times') || app.rating[0];
    return all?.count ?? null;
  }
  return app.reviews ?? app.review_count ?? app.ratings?.count ?? null;
}

function pickLastUpdated(app) {
  return (
    app.latest_version_release_date ||
    app.latest_version_released_on ||
    app.release_date ||
    app.updated ||
    null
  );
}

async function scanKeyword(keyword) {
  const { data } = await axios.get(SERPAPI_URL, {
    params: {
      engine: 'apple_app_store',
      term: keyword,
      country: 'us',
      lang: 'en-us',
      api_key: SERPAPI_KEY,
    },
    timeout: 30000,
  });

  const results = (data.organic_results || data.results || []).slice(0, 10);
  if (results.length === 0) {
    return {
      keyword,
      volumeProxy: 'Low',
      topCompetitor: null,
      reviews: null,
      rating: null,
      lastUpdated: null,
      monthsSinceUpdate: null,
      opportunityScore: 50,
    };
  }

  const enriched = results.map((app) => {
    const rating = pickRating(app);
    const reviews = pickReviewCount(app);
    const lastUpdated = pickLastUpdated(app);
    const monthsSinceUpdate = monthsBetween(lastUpdated);
    return {
      title: app.title || app.name || 'Unknown',
      rating: typeof rating === 'number' ? rating : rating ? Number(rating) : null,
      reviews: typeof reviews === 'number' ? reviews : reviews ? Number(reviews) : null,
      lastUpdated,
      monthsSinceUpdate,
    };
  });

  const valid = enriched.filter((e) => e.rating !== null || e.reviews !== null);
  const avgRating = valid.length
    ? valid.reduce((s, e) => s + (e.rating || 0), 0) / valid.filter((e) => e.rating !== null).length
    : null;
  const avgReviews = valid.length
    ? valid.reduce((s, e) => s + (e.reviews || 0), 0) / valid.filter((e) => e.reviews !== null).length
    : null;
  const avgMonthsSince = (() => {
    const withMonths = enriched.filter((e) => typeof e.monthsSinceUpdate === 'number');
    if (!withMonths.length) return null;
    return withMonths.reduce((s, e) => s + e.monthsSinceUpdate, 0) / withMonths.length;
  })();

  const top = enriched[0];

  const opportunityScore = calculateOpportunityScore({
    rating: isNaN(avgRating) ? null : avgRating,
    reviews: isNaN(avgReviews) ? null : avgReviews,
    monthsSinceUpdate: avgMonthsSince,
  });

  const signalReviews =
    typeof top.reviews === 'number' ? top.reviews : isNaN(avgReviews) ? null : avgReviews;
  let volumeProxy;
  if (typeof signalReviews !== 'number') volumeProxy = 'Low';
  else if (signalReviews < 500) volumeProxy = 'Low';
  else if (signalReviews <= 5000) volumeProxy = 'Medium';
  else volumeProxy = 'High';

  return {
    keyword,
    volumeProxy,
    topCompetitor: top.title,
    reviews: isNaN(avgReviews) ? null : avgReviews ? Math.round(avgReviews) : null,
    rating: isNaN(avgRating) ? null : avgRating ? Number(avgRating.toFixed(2)) : null,
    lastUpdated: top.lastUpdated,
    monthsSinceUpdate: avgMonthsSince !== null ? Number(avgMonthsSince.toFixed(1)) : null,
    opportunityScore,
  };
}

app.post('/api/scan', async (req, res) => {
  try {
    if (!SERPAPI_KEY) {
      return res.status(500).json({ error: 'SERPAPI_KEY not configured' });
    }

    const { keywords } = req.body;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'keywords must be a non-empty array' });
    }

    const cleaned = keywords
      .map((k) => String(k).trim())
      .filter(Boolean)
      .slice(0, 50);

    const results = [];
    for (const kw of cleaned) {
      try {
        results.push(await scanKeyword(kw));
      } catch (err) {
        results.push({
          keyword: kw,
          error: err.response?.data?.error || err.message,
          opportunityScore: 0,
        });
      }
    }

    results.sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0));
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test', async (req, res) => {
  try {
    if (!SERPAPI_KEY) {
      return res.status(500).json({ ok: false, error: 'SERPAPI_KEY not configured' });
    }
    const { data } = await axios.get(SERPAPI_URL, {
      params: {
        engine: 'apple_app_store',
        term: 'weather',
        country: 'us',
        lang: 'en-us',
        api_key: SERPAPI_KEY,
      },
      timeout: 20000,
    });
    const count = (data.organic_results || data.results || []).length;
    res.json({ ok: true, resultCount: count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data?.error || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AppScout running at http://localhost:${PORT}`);
});
