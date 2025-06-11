const express = require('express');
const path = require('path');
const open = require('open');
const bodyParser = require('body-parser');
const ScraperCLI = require('./universal');  // your existing scraper class

const app = express();
app.use(express.static(path.join(__dirname,'public')));
app.use(bodyParser.json());

app.post('/scrape', async (req, res) => {
  const { url, opts } = req.body;
  try {
    const scraper = new ScraperCLI();
    const result = await scraper.scrape(url, opts);
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GUI running at http://localhost:${PORT}`);
  // open browser on start (no electron)
});
