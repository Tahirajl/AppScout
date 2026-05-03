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

// Volume signal based on total result count from SerpApi
function getVolumeSignal(totalResults) {
    if (!totalResults || totalResults < 10) return { label: 'Low', score: 0 };
    if (totalResults < 50) return { label: 'Low', score: 5 };
    if (totalResults < 200) return { label: 'Medium', score: 15 };
    return { label: 'High', score: 25 };
}

// Max method: count how many apps have over 100 reviews
function countAppsOver100Reviews(apps) {
    return apps.filter(a => {
          const r = Array.isArray(a.rating) ? a.rating[0] : a.rating;
          const count = r?.count || r?.reviews || 0;
          return count > 100;
    }).length;
}

function calculateOpportunityScore({ rating, reviews, monthsSinceUpdate, totalResults, appsOver100 }) {
    let score = 50;

  // Review count signal
  if (typeof reviews === 'number') {
        if (reviews < 100) score += 25;
        else if (reviews < 500) score += 15;
        else if (reviews < 1000) score += 10;
        else if (reviews < 5000) score += 5;
  }

  // Rating signal - lower rating = more opportunity
  if (typeof rating === 'number') {
        if (rating < 3.5) score += 15;
        else if (rating < 4.0) score += 10;
        else if (rating < 4.3) score += 5;
  }

  // Last update signal
  if (typeof monthsSinceUpdate === 'number') {
        if (monthsSinceUpdate > 24) score += 20;
        else if (monthsSinceUpdate > 12) score += 15;
        else if (monthsSinceUpdate > 6) score += 10;
  }

  // Volume signal from SerpApi result count
  const volume = getVolumeSignal(totalResults);
    score += volume.score;

  // Max method: bonus if fewer than 4 apps have over 100 reviews
  if (typeof appsOver100 === 'number') {
        if (appsOver100 === 0) score += 20;
        else if (appsOver100 <= 2) score += 15;
        else if (appsOver100 <= 4) score += 10;
  }

  return Math.min(score, 100);
}

app.get('/api/test', async (req, res) => {
    try {
          const response = await axios.get(SERPAPI_URL, {
                  params: { engine: 'apple_app_store', term: 'productivity', api_key: SERPAPI_KEY, num: 5 }
          });
          const results = response.data?.organic_results || [];
          res.json({ ok: true, resultCount: results.length });
    } catch (err) {
          res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/scan', async (req, res) => {
    const { keywords } = req.body;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
          return res.status(400).json({ error: 'No keywords provided' });
    }

           const results = [];

           for (const keyword of keywords) {
                 try {
                         const response = await axios.get(SERPAPI_URL, {
                                   params: {
                                               engine: 'apple_app_store',
                                               term: keyword,
                                               api_key: SERPAPI_KEY,
                                               num: 10,
                                               lang: 'en-us',
                                               country: 'us'
                                   }
                         });

                   const apps = response.data?.organic_results || [];
                         const totalResults = response.data?.search_information?.total_results || apps.length;
                         const topApp = apps[0];

                   if (!topApp) {
                             results.push({ keyword, topCompetitor: 'No results', reviews: null, rating: null, lastUpdated: null, opportunityScore: 50, volumeProxy: 'Unknown' });
                             continue;
                   }

                   // Extract rating
                   let avgRating = null;
                         let reviewCount = null;
                         if (Array.isArray(topApp.rating)) {
                                   const allTime = topApp.rating.find(r => r.type === 'All Times') || topApp.rating[0];
                                   if (allTime) { avgRating = allTime.rating; reviewCount = allTime.count; }
                         } else if (topApp.rating && typeof topApp.rating === 'object') {
                                   avgRating = topApp.rating.average || topApp.rating.rating;
                                   reviewCount = topApp.rating.count || topApp.rating.reviews;
                         }

                   const lastUpdated = topApp.latest_version_release_date || topApp.update_date || null;
                         const months = monthsBetween(lastUpdated);
                         const volume = getVolumeSignal(totalResults);
                         const appsOver100 = countAppsOver100Reviews(apps);

                   const opportunityScore = calculateOpportunityScore({
                             rating: avgRating,
                             reviews: reviewCount,
                             monthsSinceUpdate: months,
                             totalResults,
                             appsOver100
                   });

                   results.push({
                             keyword,
                             topCompetitor: topApp.title || topApp.name || 'Unknown',
                             reviews: reviewCount,
                             rating: avgRating ? parseFloat(avgRating.toFixed(2)) : null,
                             lastUpdated: lastUpdated ? lastUpdated.split('T')[0] : null,
                             opportunityScore,
                             volumeProxy: volume.label,
                             totalResults,
                             appsOver100
                   });

                 } catch (err) {
                         results.push({ keyword, error: err.message, opportunityScore: 0, volumeProxy: 'Error' });
                 }
           }

           results.sort((a, b) => b.opportunityScore - a.opportunityScore);
    res.json(results);
});

app.listen(PORT, () => {
    console.log(`AppScout running on port ${PORT}`);
});
