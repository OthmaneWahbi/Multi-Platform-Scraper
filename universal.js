/**
 * HTML-First Universal Store Scraper with Auto-Pattern Detection
 *
 * This scraper uses an LLM to auto-detect HTML patterns and coordinate APIs.
 * It then uses a second LLM call to dynamically map the fields from the discovered API,
 * ensuring it can handle diverse and unpredictable JSON response structures.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');
const fs = require('fs').promises;
const path =require('path');
const { parse } = require('json2csv');
const countryReverseGeocoding = require('country-reverse-geocoding').country_reverse_geocoding();
const { newInjectedPage } = require('fingerprint-injector');

// Apply stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

const UserAnonymizePlugin = require('puppeteer-extra-plugin-anonymize-ua');
puppeteer.use(UserAnonymizePlugin());

// Disable SSL verification for development (use with caution)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * Global Configuration
 */
const CONFIG = {
    // LLM Settings
    LLM_ENDPOINT: process.env.LLM_ENDPOINT || 'https://text.pollinations.ai/',
    LLM_MODEL: process.env.LLM_MODEL || 'openai',

    // Scraping Settings
    HEADLESS: process.env.HEADLESS !== 'false',
    OUTPUT_DIR: process.env.OUTPUT_DIR || './scraped_stores',
    PAGE_TIMEOUT: 60000,
    REQUEST_TIMEOUT: 30000,
    RETRY_COUNT: 3,
    RETRY_DELAY: 2000,

    // Coordinate Grid Settings for API sweep
    GRID_LAT_STEP: parseFloat(process.env.GRID_LAT_STEP) || 30,
    GRID_LNG_STEP: parseFloat(process.env.GRID_LNG_STEP) || 30,

    // Processing Settings
    BATCH_SIZE: parseInt(process.env.BATCH_SIZE) || 100,
    MAX_EMPTY_BOXES: 30, // Stop API sweep after this many consecutive empty grid boxes
    RATE_LIMIT_DELAY: 300, // ms between API calls

    // Feature Flags
    USE_LLM_ENHANCEMENT: process.env.USE_LLM_ENHANCEMENT !== 'false',
    SAVE_HTML: process.env.SAVE_HTML === 'true',
    DEBUG: process.env.DEBUG === 'true',

    // HTML Sample Size for pattern detection
    HTML_SAMPLE_SIZE: 800000 // 800KB sample for LLM
};

// Hosts to ignore during network interception to reduce noise
const IGNORE_HOSTS = [
    'cloudfront.net', 'px-cloud.net', 'px-cdn.net', 'cookielaw.org',
    'pinterest.com', 'qualtrics.com', 'snapchat.com', 'akamai', 'adobedc.net',
    'googletagmanager.com', 'google-analytics.com', 'doubleclick.net', 'hotjar.com',
    'tie.cloud.247-inc.net', 'google.com','adobedc.demdex.net','js.klarna.com',
    'emarsys.net','recommender.scarabresearch.com','tie.cloud'
];


/**
 * Utility Functions
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry(fn, retries = CONFIG.RETRY_COUNT) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.warn(`⚠️  Retry ${i + 1}/${retries} after error: ${error.message}`);
            await sleep(CONFIG.RETRY_DELAY * (i + 1));
        }
    }
}

async function withTimeout(promise, ms) {
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Operation timed out')), ms)
    );
    return Promise.race([promise, timeout]);
}


/**
 * Calculate distance between two coordinates in meters.
 * 
 */
function getDistance(coord1, coord2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = coord1.latitude * Math.PI / 180;
    const φ2 = coord2.latitude * Math.PI / 180;
    const Δφ = (coord2.latitude - coord1.latitude) * Math.PI / 180;
    const Δλ = (coord2.longitude - coord1.longitude) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
}

/**
 * Pattern Detector - Uses LLM to detect HTML and API patterns
 */
class PatternDetector {
    static async detectHTMLPattern(html) {
        console.log('🤖 Auto-detecting HTML patterns with LLM...');
        if (!html || html.length === 0) {
            console.warn('⚠️ HTML content is empty, cannot detect pattern.');
            return this.getFallbackPattern();
        }
        
        const htmlSample = html.slice(0, CONFIG.HTML_SAMPLE_SIZE);
        const prompt = `Analyze the following HTML, which may contain a main page and an embedded iframe, and identify the CSS selectors for extracting store data. The store list is most likely inside the iframe content if it exists. Return valid JSON.

HTML to analyze:
${htmlSample}

IMPORTANT RULE: If a class name or ID in the HTML literally contains a special character that has meaning in CSS (like '+', '/', ':', '.', etc.), you MUST escape it with a leading backslash ('\').
For example, if an HTML element is <div class="item+new">, the correct CSS selector is '.item\\+new'.

`;

        try {
            const response = await withRetry(() =>
                axios.post(CONFIG.LLM_ENDPOINT, {
                    model: CONFIG.LLM_MODEL,
                    messages: [{
                    role: 'system',
                    content: `You are an expert at analyzing HTML. Be Exact. Identify data extraction patterns and return JSON with the following keys:
                    - "itemSelector"
                    - "fields" (with selectors for name, address, city, etc.)
                    - "pagination" (with type and nextSelector)
                    - "showMoreSelector" (the CSS selector for any "Show More"/"Load More"/"Voir plus de magasins"/"Load more stores"... button) : A **single** CSS selector for the “Show More” button that:
                            - Matches exactly one <button> element
                            - Contains text like “Show”, “Voir”, “Load” (case-insensitive)
                            - Does **not** match any other element
                    - "searchInputSelector" (the CSS selector for a location search input field)
                    - "searchButtonSelector" (the CSS selector for the search submission button)
                    - "initialButtonSelector" (the CSS selector for any initial “choose country” or modal button that must be clicked before the page loads the store list)
                    Do not use unsupported pseudo-selectors like :has(...) or :contains(...).
                    
                    The path should be minimal.
                    `
                        
                
                }, {
                    role: 'user',
                    content: prompt
                    }],
                    temperature: 0.5
                })
            );

            let content = response.data?.choices?.[0]?.message?.content || response.data;
            if (typeof content !== 'string') content = JSON.stringify(content);

            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/);
            const pattern = JSON.parse(jsonMatch ? jsonMatch[1] : content);
            
            console.log('✅ HTML Pattern detected:', JSON.stringify(pattern, null, 2));
            return pattern;

        } catch (error) {
            console.error('❌ HTML Pattern detection failed:', error.message);
            return this.getFallbackPattern();
        }
    }

    static getFallbackPattern() {
        console.log('↪️ Using fallback pattern.');
        return {
            itemSelector: '[class*="store"], [class*="location"], .store-item',
            fields: {
                name: '[class*="name"], h2, h3, .store-name',
                address: '[class*="address"], .address-line',
                city: '[class*="city"]',
                state: '[class*="state"]',
                postal_code: '[class*="zip"], [class*="postal"]',
                phone: '[class*="phone"]',
                email: 'a[href^="mailto:"]@href',
                url: 'a[href*="http"]@href',
                latitude: '@data-lat',
                longitude: '@data-lng',
            },
            pagination: { type: 'none' },
            showMoreSelector: null,
            searchInputSelector: null,
            searchButtonSelector: null
        };
    }

    static async detectCoordinateAPI(apiResponses, baseUrl) {
        if (!apiResponses || apiResponses.length === 0) return null;
        console.log(`🤖 Analyzing ${apiResponses.length} API responses for coordinate patterns...`);
        const relevantResponses = apiResponses.slice(0, 30).map(r => ({
            url: r.url,
            preview: typeof r.data === 'string'
                ? r.data.slice(0, 200)
                : JSON.stringify(r.data).slice(0, 100)
        }));

        if (relevantResponses.length === 0) return null;

        const prompt = `Analyze these API endpoints to find the best store/location search API that accepts geographic coordinates.

Your goal is to create a template URL that can be used to sweep a map for all store locations.

Look for parameters like:
- Center point: latitude, longitude, lat, lng, lon, center, point
- Search radius: radius, distance, range (note the unit: km, miles, or meters if possible)
- Bounding Box: bbox, bounds, ne_lat, sw_lng, north, south, east, west

Based on your analysis, return a JSON object with the following structure:
{
  "hasCoordinateAPI": true,
  "apiTemplate": "THE_FULL_URL_WITH_PLACEHOLDERS",
  "searchType": "radius" or "bbox",
  "distanceUnit": "km", "miles", or "meters" (if searchType is 'radius')
}

Placeholders to use in the template URL:
- For radius search: {{latitude}}, {{longitude}}, {{distance}}
- For bounding box search: {{sw_lat}}, {{sw_lng}}, {{ne_lat}}, {{ne_lng}}

If no suitable coordinate-based API is found, return { "hasCoordinateAPI": false }.
DO NOT ADD THE PARAMETERS TO A URL THAT DOESNT HAVE THEM ORIGINALY.

API endpoints to analyze:
${JSON.stringify(relevantResponses, null, 2)}

Base URL of the website: ${baseUrl}`;
        
        if (CONFIG.DEBUG) {
            console.log('\n--- API Detection Prompt ---\n', prompt, '\n--------------------------\n');
        }

        try {
            const response = await withRetry(() =>
                axios.post(CONFIG.LLM_ENDPOINT, {
                    model: CONFIG.LLM_MODEL,
                    messages: [{ role: 'system', content: 'You are an API expert. Identify coordinate-based search endpoints and return JSON.' }, { role: 'user', content: prompt }],
                    temperature: 0.1
                })
            );

            let content = response.data?.choices?.[0]?.message?.content || response.data;
            if (typeof content !== 'string') content = JSON.stringify(content);
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/);
            const result = JSON.parse(jsonMatch ? jsonMatch[1] : content);
            
            if (result.hasCoordinateAPI && result.apiTemplate) {
                console.log('✅ Coordinate API detected:', result.apiTemplate);
                return result;
            }
            return null;
        } catch (error) {
            console.error('❌ API detection failed:', error.message);
            return null;
        }
    }

    static async detectApiDataMapping(sampleItem) {
        console.log('🤖 Detecting API data mapping from sample item...');
        const prompt = `Based on this sample JSON object for a single store, create a mapping to extract the specified fields. Use dot notation for nested properties.

Sample JSON object:
${JSON.stringify(sampleItem, null, 2)}

Return a JSON object where keys are the desired field names and values are the paths in the sample object.

Desired fields: "name", "address", "city", "state", "country", "postal_code", "latitude", "longitude".

If a field is not present in the sample, its value in the mapping should be null.

Example Response:
{
  "name": "name",
  "address": "streetaddress",
  "city": "address.city",
  "state": "address.state",
  "country": "address.country",
  "postal_code": "address.postal",
  "latitude": "loc_lat",
  "longitude": "loc_long"
}`;

        if (CONFIG.DEBUG) {
            console.log('\n--- API Data Mapping Prompt ---\n', prompt, '\n---------------------------\n');
        }
        
        try {
            const response = await withRetry(() =>
                axios.post(CONFIG.LLM_ENDPOINT, {
                    model: CONFIG.LLM_MODEL,
                    messages: [{ role: 'system', content: 'You are an expert in JSON data mapping. Return only a valid JSON object.' }, { role: 'user', content: prompt }],
                    temperature: 0.0
                })
            );
            let content = response.data?.choices?.[0]?.message?.content || response.data;
            if (typeof content !== 'string') content = JSON.stringify(content);
            const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/);
            const mapping = JSON.parse(jsonMatch ? jsonMatch[1] : content);

            console.log('✅ API Data Mapping detected:', JSON.stringify(mapping, null, 2));
            return mapping;
        } catch (error) {
            console.error('❌ API Data Mapping detection failed:', error.message);
            return null;
        }
    }
}


/**
 * HTML Extractor - Extracts stores from HTML using detected patterns
 */
class HTMLExtractor {
    static extractField(element, selector, $) {
        if (!selector) return '';
        try {
            if (selector.includes('@')) {
                const [sel, attr] = selector.split('@');
                const target = sel ? element.find(sel).first() : element;
                return target.attr(attr) || '';
            }
            return element.find(selector).first().text().trim();
        } catch (e) { return ''; }
    }

    static async extractWithCheerio(html, pattern) {
        console.log('📄 Extracting stores from static HTML with Cheerio...');
        if (!html || !pattern || !pattern.itemSelector) return [];
        
        const $ = cheerio.load(html);
        const stores = [];

        $(pattern.itemSelector).each((i, elem) => {
            const $elem = $(elem);
            const store = { source: 'html-cheerio' };
            for (const [field, selector] of Object.entries(pattern.fields)) {
                store[field] = this.extractField($elem, selector, $);
            }
            if (store.name || store.address) stores.push(store);
        });

        console.log(`  Found ${stores.length} stores with Cheerio.`);
        return stores;
    }

    static async extractWithPuppeteer(executionContext, pattern) {
        const contextType = executionContext.constructor.name === 'CdpFrame' ? 'iframe' : 'main page';
        console.log(`🌐 Extracting stores from live DOM (using ${contextType} context)...`);
        if (!pattern || !pattern.itemSelector) return [];

        try {
            return await executionContext.$$eval(pattern.itemSelector, (elements, pat) => {
                const results = [];
                const extract = (element, selector) => {
                    if (!selector) return '';
                    try {
                        if (selector.includes('@')) {
                            const [sel, attr] = selector.split('@');
                            const target = sel ? element.querySelector(sel) : element;
                            return target ? target.getAttribute(attr) || '' : '';
                        }
                        const el = element.querySelector(selector);
                        return el ? el.textContent.trim() : '';
                    } catch { return ''; }
                };

                elements.forEach(elem => {
                    const store = { source: 'html-puppeteer' };
                    for (const [field, selector] of Object.entries(pat.fields)) {
                        store[field] = extract(elem, selector);
                    }
                    if (store.name || store.address) results.push(store);
                });
                return results;
            }, pattern);
        } catch (error) {
            console.warn(`⚠️  Puppeteer extraction failed for selector: "${pattern.itemSelector}".`);
            if (CONFIG.DEBUG) console.error(error.message);
            return [];
        }
    }
}

/**
 * JSON-LD Extractor
 */
class JSONLDExtractor {
    static async extract(html) {
        console.log('🔍 Extracting JSON-LD structured data...');
        const $ = cheerio.load(html);
        const stores = [];
        const validTypes = ['Store', 'LocalBusiness', 'Restaurant', 'Hotel', 'Shop'];

        $('script[type="application/ld+json"]').each((i, elem) => {
            try {
                const jsonText = $(elem).html();
                if (!jsonText) return;
                
                const data = JSON.parse(jsonText);
                const items = Array.isArray(data) ? data : [data];
                
                for (let item of items) {
                    if (item['@graph']) items.push(...item['@graph']);
                    
                    const itemType = item['@type'];
                    const isStore = Array.isArray(itemType) 
                        ? itemType.some(t => validTypes.includes(t)) 
                        : validTypes.includes(itemType);

                    if (isStore) {
                        const store = {
                            name: item.name || '',
                            address: item.address?.streetAddress || '',
                            city: item.address?.addressLocality || '',
                            state: item.address?.addressRegion || '',
                            country: item.address?.addressCountry || '',
                            postal_code: item.address?.postalCode || '',
                            latitude: item.geo?.latitude || null,
                            longitude: item.geo?.longitude || null,
                            phone: item.telephone || '',
                            email: item.email || '',
                            url: item.url || '',
                            source: 'json-ld'
                        };
                        if (store.name || (store.address && store.city)) stores.push(store);
                    }
                }
            } catch (error) {
                if (CONFIG.DEBUG) console.warn('  Could not parse JSON-LD:', error.message);
            }
        });
        
        console.log(`  Found ${stores.length} stores in JSON-LD.`);
        return stores;
    }
}

/**
 * Inline <Script> Extractor
 */
class ScriptDataExtractor {
  /**
   * Scans every <script> tag for a JS call containing a JSON
   * object with a top-level "stores" array, parses it, and returns
   * that array.
   */
  static extract(html) {
    const $ = cheerio.load(html);
    const stores = [];

    $('script').each((i, el) => {
      const raw = $(el).html();
      if (!raw) return;
    

      const txt = raw.replace(/\\"/g, '"');
      // find the first occurrence of {"stores":
      const start = txt.indexOf('{"stores":');
      //    console.log(start)
      if (start === -1) return;
    
      // 3) Balance braces to slice out a complete {...} block
      let depth = 0, inString = false, escape = false, end = -1;
      for (let j = start; j < txt.length; j++) {
        const ch = txt[j];
        if (inString) {
          if (escape) escape = false;
          else if (ch === '\\') escape = true;
          else if (ch === '"') inString = false;
        } else {
          if (ch === '"') inString = true;
          else if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) { end = j + 1; break; }
          }
        }
      }
      if (end <= start) return;

      // 4) Parse the JSON
      let obj;
      try {
        obj = JSON.parse(txt.slice(start, end));
      } catch (e) {
        if (CONFIG.DEBUG) console.warn('ScriptDataExtractor JSON parse error:', e);
        return;
      }

      // 5) Pull out the array of store-like objects
      let arr = null;
      if (Array.isArray(obj.stores)) {
        arr = obj.stores;
      } else if (obj.page && Array.isArray(obj.page.items)) {
        arr = obj.page.items;
      } else {
        // fallback: find first array of objects anywhere
        arr = ScriptDataExtractor.findFirstObjectArray(obj);
      }
      if (!Array.isArray(arr)) return;

      // 6) Normalize and collect
      arr.forEach(s => {
        stores.push({
          name:        s.name                || '',
          address:     (s.address?.street1
                          ? `${s.address.street1}${s.address.street2 ? ' – '+s.address.street2 : ''}`
                          : s.address)        || '',
          city:        s.city                || s.address?.city || '',
          postal_code: s.postal_code         || s.address?.zipcode || '',
          country:     s.country             || s.address?.country || '',
          latitude:    s.position?.lat       ?? s.latitude  ?? null,
          longitude:   s.position?.lng       ?? s.longitude ?? null,
          url:         s.google_maps_url     || s.url || '',
          source:      'inline-script'
        });
      });
    });

    console.log(`  Found ${stores.length} stores in inline scripts.`);
    return stores;
  }

  // Recursively find the first Array of Objects in an object
  static findFirstObjectArray(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const key in obj) {
      const v = obj[key];
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
        return v;
      }
      if (typeof v === 'object') {
        const nested = ScriptDataExtractor.findFirstObjectArray(v);
        if (nested) return nested;
      }
    }
    return null;
  }
}

/**
 * API Handler - Performs coordinate-based API sweeping
 */
class APIHandler {
    static generateCoordinateGrid() {
        const boxes = [];
        for (let lat = -90; lat < 90; lat += CONFIG.GRID_LAT_STEP) {
            for (let lng = -180; lng < 180; lng += CONFIG.GRID_LNG_STEP) {
                const box = {
                    sw_lat: lat,
                    sw_lng: lng,
                    ne_lat: Math.min(lat + CONFIG.GRID_LAT_STEP, 90),
                    ne_lng: Math.min(lng + CONFIG.GRID_LNG_STEP, 180),
                };
                box.center_lat = (box.sw_lat + box.ne_lat) / 2;
                box.center_lng = (box.sw_lng + box.ne_lng) / 2;
                const diagonal = getDistance({ latitude: box.sw_lat, longitude: box.sw_lng }, { latitude: box.ne_lat, longitude: box.ne_lng });
                box.radius_meters = diagonal / 2;
                box.radius_km = box.radius_meters / 1000;

                if (!this.isOcean(box.center_lat, box.center_lng)) {
                    boxes.push(box);
                }
            }
        }
        console.log(`  Generated ${boxes.length} searchable land-based grid boxes.`);
        return boxes;
    }

    static isOcean(lat, lng) {
        const country = countryReverseGeocoding.get_country(lat, lng);
        return !country || country.code === null;
    }

    static findFirstArrayOfObjects(obj) {
        if (!obj || typeof obj !== 'object') return null;
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const value = obj[key];
                if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
                    return value;
                }
                if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
                    const result = this.findFirstArrayOfObjects(value);
                    if (result) return result;
                }
            }
        }
        return null;
    }

    static getValueByPath(obj, path) {
        if (!path || typeof path !== 'string') return '';
        return path.split('.').reduce((acc, part) => acc && acc[part], obj) || '';
    }
    
    static mapItemWithDynamicPattern(item, mapping) {
        const store = { source: 'api-dynamic' };
        for (const [key, path] of Object.entries(mapping)) {
            store[key] = this.getValueByPath(item, path);
        }

        // Final cleanup and type conversion
        if (store.latitude) store.latitude = parseFloat(store.latitude) || null;
        if (store.longitude) store.longitude = parseFloat(store.longitude) || null;
        
        return store;
    }

    static async fetchWithCoordinateAPI(apiInfo, baseUrl) {
        console.log('🌍 Starting API fetch process...');
        let dynamicMapping = null;

        const processResponse = async (response) => {
            const items = this.findFirstArrayOfObjects(response.data) || [];
            if (items.length === 0) return [];

            if (!dynamicMapping) { // Only detect mapping once
                console.log('🤖 First API response received. Detecting data mapping from sample...');
                dynamicMapping = await PatternDetector.detectApiDataMapping(items[0]);
                if (!dynamicMapping) {
                    console.warn('⚠️ Could not detect dynamic mapping. API data may be incomplete.');
                    return []; // Stop if we can't map the data
                }
            }
            
            console.log(`  Mapping ${items.length} items with dynamic pattern.`);
            return items.map(item => this.mapItemWithDynamicPattern(item, dynamicMapping));
        };
        
        console.log('  Trying a direct API call without geo-parameters...');
        const baseApiUrl = apiInfo.apiTemplate.split('?')[0];
        try {
            const response = await withRetry(() => axios.get(baseApiUrl, { timeout: CONFIG.REQUEST_TIMEOUT }));
            const stores = await processResponse(response);
            if (stores.length > 50) {
                console.log(`✅ Success! Found ${stores.length} stores in a single API call.`);
                return stores;
            } else {
                console.log(`  Single call returned only ${stores.length} items. Proceeding with geographic sweep.`);
            }
        } catch (error) {
            console.warn(`  Direct API call failed: ${error.message}. Proceeding with sweep.`);
        }
        
        console.log('  Starting smart coordinate sweep...');
        const stores = [];
        const landBoxes = this.generateCoordinateGrid();
        let consecutiveEmpty = 0;

        for (const [index, box] of landBoxes.entries()) {
            if (consecutiveEmpty >= CONFIG.MAX_EMPTY_BOXES) {
                console.log(`  ⚠️ Stopping sweep: ${consecutiveEmpty} consecutive empty responses.`);
                break;
            }

            let url = apiInfo.apiTemplate;
            let distance = box.radius_km;
            if (apiInfo.distanceUnit === 'miles') distance = box.radius_km * 0.621371;
            else if (apiInfo.distanceUnit === 'meters') distance = box.radius_meters;
            
            url = url
                .replace(/{{latitude}}/g, box.center_lat)
                .replace(/{{longitude}}/g, box.center_lng)
                .replace(/{{distance}}/g, Math.ceil(distance))
                .replace(/{{sw_lat}}/g, box.sw_lat)
                .replace(/{{sw_lng}}/g, box.sw_lng)
                .replace(/{{ne_lat}}/g, box.ne_lat)
                .replace(/{{ne_lng}}/g, box.ne_lng);

            const fullUrl = new URL(url, baseUrl).toString();
            if (index % 10 === 0) console.log(`  [${index}/${landBoxes.length}] Sweeping near (${box.center_lat.toFixed(1)}, ${box.center_lng.toFixed(1)})`);

            try {
                const response = await withRetry(() => axios.get(fullUrl, { timeout: CONFIG.REQUEST_TIMEOUT }));
                const newStores = await processResponse(response);
                
                if (newStores.length > 0) {
                    consecutiveEmpty = 0;
                    stores.push(...newStores);
                } else {
                    consecutiveEmpty++;
                }
                await sleep(CONFIG.RATE_LIMIT_DELAY);
            } catch (error) {
                if (CONFIG.DEBUG) console.warn(`  Sweep request failed: ${error.message}`);
                consecutiveEmpty++;
            }
        }
        
        console.log(`✅ Coordinate sweep complete. Found ${stores.length} stores.`);
        return stores;
    }
}


/**
 * Data Processor - Cleans and structures the final data
 */
class DataProcessor {
    static preFilter(stores) {
        console.log('🧹 Pre-filtering stores...');
        const filtered = stores.filter(s => s.name && (s.address || s.city || (s.latitude && s.longitude)));
        console.log(`  Filtered: ${stores.length} → ${filtered.length} stores.`);
        return filtered;
    }

    static deduplicate(stores) {
        console.log('🔄 Deduplicating stores...');
        const uniqueStores = new Map();
        for (const store of stores) {
            const key = `${(store.name || '').toLowerCase()}_${(store.address || '').toLowerCase()}_${(store.city || '').toLowerCase()}`;
            if (!uniqueStores.has(key)) {
                uniqueStores.set(key, store);
            }
        }
        const result = Array.from(uniqueStores.values());
        console.log(`  Deduplicated: ${stores.length} → ${result.length} stores.`);
        return result;
    }

    static calculateStats(stores) {
        const stats = {
            total: stores.length,
            by_source: {},
            with_coordinates: 0,
        };
        for (const store of stores) {
            stats.by_source[store.source] = (stats.by_source[store.source] || 0) + 1;
            if (store.latitude && store.longitude) stats.with_coordinates++;
        }
        return stats;
    }
}


/**
 * LLM Enhancer (Optional) - Cleans data using an LLM
 */
class LLMEnhancer {
    static async enhance(stores) {
        if (!CONFIG.USE_LLM_ENHANCEMENT) {
            console.log('⏭️  Skipping LLM enhancement.');
            return stores;
        }
        console.log('🤖 Enhancing stores with LLM cleaning...');
        const enhanced = [];
        for (let i = 0; i < stores.length; i += CONFIG.BATCH_SIZE) {
            const batch = stores.slice(i, i + CONFIG.BATCH_SIZE);
            try {
                const cleanedBatch = await this.cleanBatch(batch);
                enhanced.push(...cleanedBatch);
            } catch (error) {
                console.error(`  Enhancement failed for a batch: ${error.message}`);
                enhanced.push(...batch); // Add original batch on failure
            }
        }
        console.log(`✅ LLM enhancement complete: ${stores.length} → ${enhanced.length} stores`);
        return enhanced;
    }

    static async cleanBatch(batch) {
        const prompt = `Clean and standardize this JSON array of store records. Fix formatting, validate data, and remove duplicates. Preserve all valid stores. Return only the cleaned JSON array.

Stores: ${JSON.stringify(batch)}`;

        const response = await withRetry(() =>
            axios.post(CONFIG.LLM_ENDPOINT, {
                model: CONFIG.LLM_MODEL,
                messages: [{ role: 'system', content: 'You are a data cleaning expert. Return only a valid JSON array.' }, { role: 'user', content: prompt }],
                temperature: 0.1
            })
        );
        let content = response.data?.choices?.[0]?.message?.content || response.data;
        if (typeof content !== 'string') content = JSON.stringify(content);
        const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/);
        return JSON.parse(jsonMatch ? jsonMatch[1] : content);
    }
}


/**
 * Output Handler - Saves results to files
 */
class OutputHandler {
    static async save(stores, url, stats) {
        if (stores.length === 0) {
            console.log("\n⚠️ No stores found to save.");
            return;
        }
        console.log('\n💾 Saving results...');
        
        const domain = new URL(url).hostname.replace('www.', '');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const folderPath = path.join(CONFIG.OUTPUT_DIR, `${domain}_${timestamp}`);
        await fs.mkdir(folderPath, { recursive: true });

        // Save stores.json
        await fs.writeFile(
            path.join(folderPath, 'stores.json'),
            JSON.stringify({ metadata: { url, ...stats }, stores }, null, 2)
        );

        // Save stores.csv
        const fields = ['name', 'address', 'city', 'state', 'country', 'postal_code', 'latitude', 'longitude', 'phone', 'email', 'url', 'source'];
        const csv = parse(stores, { fields });
        await fs.writeFile(path.join(folderPath, 'stores.csv'), csv);
        
        console.log(`✅ Results for ${stats.total} stores saved to: ${folderPath}`);
    }
}


/**
 * Main Scraper CLI
 */
class ScraperCLI {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async initialize(proxyLocation = null,opts={}) {
        console.log('🚀 Initializing browser...');
        // Build your launch options
          const launchOpts = {
            headless: CONFIG.HEADLESS,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
            ],
          };
          // If Render has downloaded Chrome for Puppeteer, point to it:
          if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
          }
        this.browser = await puppeteer.launch(launchOpts);
        // Prepare options for the injector
        const injectorOptions = {
            // Let the library generate a fingerprint based on these constraints
            fingerprintOptions: {
                devices: ['desktop'],
                operatingSystems: ['windows']
            },
            // Pass Puppeteer-specific new context options here
            newContextOptions: {}
        };
        // If you have location data, add it to the newContextOptions
        if (proxyLocation) {
            injectorOptions.newContextOptions.geolocation = {
                latitude: proxyLocation.latitude,
                longitude: proxyLocation.longitude,
                accuracy: 100
            };
            // Note: emulateTimezone is a method on the page, so we'll call it after creating the page.
        }

        this.page = await newInjectedPage(this.browser, injectorOptions); 
        if (proxyLocation && proxyLocation.timezone) {
            await this.page.emulateTimezone(proxyLocation.timezone);
        }
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }

    async cleanup() {
        if (this.browser) await this.browser.close();
    }

    async saveHTML(html, url, suffix) {
        try {
            const domain = new URL(url).hostname.replace('www.', '');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `${domain}_${suffix}_${timestamp}.html`;
            const dir = path.join(CONFIG.OUTPUT_DIR, 'html_logs');
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, filename), html);
            console.log(`  HTML (${suffix}) saved for debugging.`);
        } catch (error) {
            console.warn(`  Failed to save HTML: ${error.message}`);
        }
    }

    async scrape(url, proxyLocation = null, launchOpts={}) {
        if (opts.headless !== undefined) CONFIG.HEADLESS = opts.headless;
        if (opts.batchSize !== undefined) CONFIG.BATCH_SIZE = opts.batchSize;
        console.log(`\n${'='.repeat(70)}`);
        console.log(`🏪 Universal Store Scraper Started`);
        console.log(`📍 Target: ${url}`);
        console.log(`${'='.repeat(70)}\n`);

        try {
            await this.initialize(proxyLocation);
            
            const apiResponses = [];
            const responseHandler = async (response) => {
                const responseUrl = response.url();
                try {
                    const responseUrl = response.url();
                    const { hostname } = new URL(responseUrl);
                    const contentType = response.headers()['content-type'] || '';
                    
                    // Skip any host we don't care about
                    if (IGNORE_HOSTS.some(sub => hostname.includes(sub))) {
                    if (CONFIG.DEBUG) console.log(`⏭️ Skipping ${hostname}`);
                    return;
                    }
                    // console.log(`📍 contentv type : ${contentType}`);
                    if (contentType.includes('application/json')) {
                    const data = await withTimeout(response.json(), 3000).catch(() => null);
                    if (data) {
                        apiResponses.push({ url: responseUrl, contentType: 'application/json', data });
                        // console.log(`📍 API APPJSON : ${responseUrl}`);
                    }
                    }
                    else if (contentType.includes('text/html')) {
                    const text = await withTimeout(response.text(), 3000).catch(() => null);
                    if (text) {
                        apiResponses.push({ url: responseUrl, contentType: 'text/html', data: text });
                        // console.log(`📍 API TEXT/HTML : ${responseUrl}`);
                    }
                    }
                } catch (e) {
                    // Ignore
                }
            };
            
            this.page.on('response', responseHandler);
            this.page.on('frameattached', async (frame) => {
                frame.on('response', responseHandler);
            });
            
            console.log('🌐 Loading page...');
            await this.page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.PAGE_TIMEOUT });
            await sleep(5000);

            // Check for redirect
            const currentUrl = this.page.url();
            if (currentUrl !== url) {
            console.warn(`🔁 Detected redirect: landed on ${currentUrl} instead of ${url}`);
            console.log('🔄 Attempting to re-access original URL...');

            // Retry original URL once
            try {
                await this.page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.PAGE_TIMEOUT });
                await sleep(3000);
                console.log(`✅ Re-accessed original URL successfully.`);
            } catch (err) {
                console.warn(`⚠️ Retry failed: ${err.message}`);
            }
            }
            

            const mainPageHtml = await this.page.content();
            if (CONFIG.SAVE_HTML) await this.saveHTML(mainPageHtml, url, 'main');
            console.log(`  Page loaded: ${(mainPageHtml.length / 1024).toFixed(1)} KB`);
            console.log('\n🔍 Phase 1: Finding iframe and preparing HTML context');
            let frame;
            let iframeHtml = '';
            let htmlToAnalyze = mainPageHtml;

            {
                console.log('🔍 Merging ALL iframes for analysis…');
                const iframeEls = await this.page.$$('iframe');
                const iframeHtmls = [];
                const frameContexts = [];

                for (let idx = 0; idx < iframeEls.length; idx++) {
                    const el = iframeEls[idx];
                    const f = await el.contentFrame();
                    if (!f) continue;
                    try {
                    // wait briefly for the iframe to load
                    await f.waitForSelector('body', { timeout: 3000 });
                    await sleep(500);
                    const html = await f.content();
                    iframeHtmls.push(`<!-- IFRAME ${idx} -->\n${html}`);
                    frameContexts.push(f);
                    if (CONFIG.SAVE_HTML) {
                        await this.saveHTML(html, url, `iframe_${idx}`);
                    }
                    } catch {
                    // ignore frames that won’t load
                    }
                }

                // combine main page HTML + all iframe HTML snippets
                htmlToAnalyze = [
                    `<!-- MAIN PAGE HTML -->\n${mainPageHtml}`,
                    ...iframeHtmls
                ].join('\n');

                console.log(`  🔗 Combined main HTML + ${iframeHtmls.length} iframes for pattern detection.`);
                // store the list of iframe contexts for Phase 3 extraction
                this._iframeContexts = frameContexts;
                }
            
            console.log('\n📊 Phase 2: Pattern Detection & Source Selection');
            let htmlPattern = await PatternDetector.detectHTMLPattern(htmlToAnalyze);

            let extractionHtml = mainPageHtml;
            let extractionContext = this.page;

            if (iframeHtml && htmlPattern?.itemSelector) {
                const $iframe = cheerio.load(iframeHtml);
                console.log(iframeHtml) 
                if ($iframe(htmlPattern.itemSelector).length > 0) {
                    console.log('🎯 Pattern selector found in iframe. Setting iframe as extraction target.');
                    extractionHtml = iframeHtml;
                    extractionContext = frame;
                } else {
                    console.log('🎯 Pattern selector not in iframe. Defaulting to main page for extraction.');
                }
            }

            if (htmlPattern.initialButtonSelector) {
            console.log('Initial page detected, attempting to bypass it...')
            console.log(`🛠️ Clicking initial button: ${htmlPattern.initialButtonSelector}`);
            try {
                await this.page.click(htmlPattern.initialButtonSelector);
                await sleep(5000);

                await this.page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.PAGE_TIMEOUT });
                await sleep(5000);
                // now re-grab the HTML and (re-)detect patterns on the real content
                const postClickHtml = await this.page.content();
                let frame;
                let iframeHtml = '';
                let htmlToAnalyze = postClickHtml;

                {
                    console.log('🔍 Merging ALL iframes for analysis…');
                    const iframeEls = await this.page.$$('iframe');
                    const iframeHtmls = [];
                    const frameContexts = [];

                    for (let idx = 0; idx < iframeEls.length; idx++) {
                        const el = iframeEls[idx];
                        const f = await el.contentFrame();
                        if (!f) continue;
                        try {
                        // wait briefly for the iframe to load
                        await f.waitForSelector('body', { timeout: 3000 });
                        await sleep(500);
                        const html = await f.content();
                        iframeHtmls.push(`<!-- IFRAME ${idx} -->\n${html}`);
                        frameContexts.push(f);
                        if (CONFIG.SAVE_HTML) {
                            await this.saveHTML(html, url, `iframe_${idx}`);
                        }
                        } catch {
                        // ignore frames that won’t load
                        }
                    }

                    // combine main page HTML + all iframe HTML snippets
                    htmlToAnalyze = [
                        `<!-- MAIN PAGE HTML -->\n${mainPageHtml}`,
                        ...iframeHtmls
                    ].join('\n');

                    console.log(`  🔗 Combined main HTML + ${iframeHtmls.length} iframes for pattern detection.`);
                    // store the list of iframe contexts for Phase 3 extraction
                    this._iframeContexts = frameContexts;
                }

                htmlPattern = await PatternDetector.detectHTMLPattern(htmlToAnalyze);
                let extractionHtml = mainPageHtml;
                let extractionContext = this.page;

                if (iframeHtml && htmlPattern?.itemSelector) {
                    const $iframe = cheerio.load(iframeHtml);
                    if ($iframe(htmlPattern.itemSelector).length > 0) {
                        console.log('🎯 Pattern selector found in iframe. Setting iframe as extraction target.');
                        extractionHtml = iframeHtml;
                        extractionContext = frame;
                    } else {
                        console.log('🎯 Pattern selector not in iframe. Defaulting to main page for extraction.');
                    }
                }
            } catch (e) {
                console.warn(`⚠️ Initial click failed: ${e.message}`);
            }
            }

            console.log('\n📄 Phase 3: Extracting Data');
            let allStores = [];
            allStores.push(...await HTMLExtractor.extractWithCheerio(mainPageHtml, htmlPattern));
            allStores.push(...await HTMLExtractor.extractWithPuppeteer(this.page, htmlPattern));

            // 3b) From each iframe you collected
            for (const f of this._iframeContexts || []) {
            const iframeHtml = await f.content();
            allStores.push(...await HTMLExtractor.extractWithCheerio(iframeHtml, htmlPattern));
            allStores.push(...await HTMLExtractor.extractWithPuppeteer(f, htmlPattern));
            }

            // 3c) From any JSON-LD blocks in the main page
            allStores.push(...await JSONLDExtractor.extract(mainPageHtml));

            // 3d) From inline scripts (merged HTML)
            allStores.push(...ScriptDataExtractor.extract(htmlToAnalyze));

            console.log(`  Found ${allStores.length} stores from HTML + iframe(s) + JSON-LD + scripts.`);

            
            console.log(`  Found ${allStores.length} stores from HTML sources.`);
            console.log("Stores :")
            console.log(allStores)

            console.log('\n🕹️ Phase 3b: Interactive Extraction');

            // 1) “Show More” loop
            if (htmlPattern.showMoreSelector && allStores.length < 200) {
            console.log('  ▶️ Detected show-more button. Expanding…');

            // Build the list of contexts: top level + every iframe
            const contexts = [ this.page, ...(this._iframeContexts || []) ];
            try {
                // Build a list of contexts to try: main page + each iframe
                for (const ctx of contexts) {
                    let clicks = 0 
                    const contextName = ctx === this.page ? 'main page' : 'iframe';
                    console.log(`  ▶️ Expanding in ${contextName} context…`);
                while (clicks < 20) {
                try {
                    // 1) wait for the button to appear in the right context (main page or iframe)
                    await ctx.waitForSelector(htmlPattern.showMoreSelector, { timeout: 5000 });
                    
                    // 2) scroll it into view in case it's off-screen
                    await ctx.$eval(
                    htmlPattern.showMoreSelector,
                    el => el.scrollIntoView({ block: 'center', inline: 'center' })
                    );
                    
                    // 3) click it
                    await ctx.click(htmlPattern.showMoreSelector);
                    clicks++;
                    console.log(`   ▶️ click #${clicks}`);
                    
                    // small pause before next iteration
                    await sleep(2000);
                    if (clicks == 20){
                        console.log(await ctx.content())
                        // ONLY FOR DEBUGGING
                        await this.page.screenshot({
                        path: 'screenshot.png',  // relative to your working dir
                        fullPage: true          // capture the entire scrollable page
                        });
                    }

                } catch (err) {
                    console.warn(`   ⚠️ showMore loop stopped after ${clicks} clicks: ${err.message}`);
                    break;
                }
                }
                // 5) re-extract from this context
                const updatedHtml = ctx === this.page
                ? await this.page.content()
                : await ctx.content();
                if (clicks == 20){
                        htmlPattern = await PatternDetector.detectHTMLPattern(updatedHtml);
                    }
                allStores.push(...await HTMLExtractor.extractWithCheerio(updatedHtml, htmlPattern));
                allStores.push(...await HTMLExtractor.extractWithPuppeteer(ctx, htmlPattern));
            }} catch (err) {
                console.warn(`   ⚠️ Show-more loop failed completely: ${err.message}`);
            }
            }

            // 2) “Search” probe for Paris & New York
            if (htmlPattern.searchInputSelector && htmlPattern.searchButtonSelector) {
            console.log('  🔎 Detected search UI. Probing major cities…');
            for (const city of ['Paris', 'New York']) {
                try {
                // locate & trigger the search
                // Build a list of contexts to try: main page + each iframe
                const contexts = [ this.page, ...(this._iframeContexts || []) ];

                for (const ctx of contexts) {
                    const contextName = ctx === this.page ? 'main page' : 'iframe';
                const input  = await ctx.$(htmlPattern.searchInputSelector);
                const button = await ctx.$(htmlPattern.searchButtonSelector);
                if (!input || !button) {
                    console.warn('   ⚠️ Search input or button not found, skipping probe.');
                    break;
                }

                try {
                    await input.click({ clickCount: 3 });
                    await input.type(city, { delay: 100 });
                    await button.click();
                    console.log(`   • Searched for ${city}`);
                } catch (interactErr) {
                    console.warn(`   ⚠️ Interaction for "${city}" failed: ${interactErr.message}`);
                    continue;  // move on to next city
                }

                await sleep(4000);  // wait for the DOM & iframe to update

                // Grab updated main page HTML
                const updatedMainHtml = await ctx.content();
            }
                // Re-scan iframes safely
                let updatedIframeHtml = '';
                let updatedFrame      = null;
                try {
                    const iframeEls2 = await this.page.$$('iframe');
                    for (const el2 of iframeEls2) {
                    const f2 = await el2.contentFrame();
                    if (!f2) continue;
                    try {
                        await f2.waitForSelector('body', { timeout: 3000 });
                        await sleep(1000);
                        const content = await f2.content();
                        if (content.length > updatedIframeHtml.length) {
                        updatedIframeHtml = content;
                        updatedFrame      = f2;
                        }
                    } catch { /* ignore frame load errors */ }
                    }
                } catch (iframeErr) {
                    console.warn(`   ⚠️ Iframe re-scan failed: ${iframeErr.message}`);
                }

                // Combine for analysis
                const htmlToAnalyzeNew = updatedIframeHtml
                    ? `<!-- MAIN PAGE HTML -->\n${updatedMainHtml}\n<!-- IFRAME HTML -->\n${updatedIframeHtml}`
                    : updatedMainHtml;
                if (CONFIG.SAVE_HTML) {
                    await this.saveHTML(htmlToAnalyzeNew, url, `search-${city.replace(/\s+/g,'_')}`);
                }

                // Re-detect patterns
                console.log(`   🔄 Re-detecting patterns after searching for ${city}`);
                let updatedPattern;
                try {
                    updatedPattern = await PatternDetector.detectHTMLPattern(htmlToAnalyzeNew);
                } catch (pdErr) {
                    console.warn(`   ⚠️ Pattern detection failed for "${city}": ${pdErr.message}`);
                    continue;
                }

                // Choose extraction context
                let extractionHtmlNew    = updatedMainHtml;
                let extractionContextNew = this.page;
                if (updatedIframeHtml && updatedPattern.itemSelector) {
                    const $if = cheerio.load(updatedIframeHtml);
                    if ($if(updatedPattern.itemSelector).length > 0) {
                    extractionHtmlNew    = updatedIframeHtml;
                    extractionContextNew = updatedFrame;
                    }
                }

                // Extract stores
                const newCheerioStores   = await HTMLExtractor.extractWithCheerio(extractionHtmlNew, updatedPattern);
                const newPuppeteerStores = await HTMLExtractor.extractWithPuppeteer(extractionContextNew, updatedPattern);
                console.log(`   • Found ${newCheerioStores.length + newPuppeteerStores.length} stores after searching for ${city}`);

                // Merge results
                allStores.push(...newCheerioStores, ...newPuppeteerStores);
                htmlPattern = { ...htmlPattern, ...updatedPattern };
                frame       = updatedFrame;
                iframeHtml  = updatedIframeHtml;
                } catch (loopErr) {
                console.warn(`   ⚠️ Search probe for "${city}" failed: ${loopErr.message}`);
                // continue to next city
                }
                }
            }

            let apiStores = [];
            if (allStores.length < 200) {
                console.log('\n📡 Phase 4: API-based Scraping');
                const apiInfo = await PatternDetector.detectCoordinateAPI(apiResponses, url);
                if (apiInfo) {
                    apiStores = await APIHandler.fetchWithCoordinateAPI(apiInfo, url);
                    allStores.push(...apiStores);
                } else {
                    console.log('  No coordinate-based API pattern detected.');
                }
            } else {
                console.log('\n✅ Sufficient stores found in HTML, skipping API phase.');
            }
            
            console.log('\n🔧 Phase 5: Final Processing');
            let processed = DataProcessor.preFilter(allStores);
            processed = DataProcessor.deduplicate(processed);
            
            // if (CONFIG.USE_LLM_ENHANCEMENT && processed.length > 0) {
            //      console.log('🤖 LLM Enhancement is currently disabled for debugging.');
            //     // processed = await LLMEnhancer.enhance(processed);
            // }
            
            const stats = DataProcessor.calculateStats(processed);
            await OutputHandler.save(processed, url, stats);

        } catch (error) {
            console.error('\n❌ An unrecoverable error occurred during scraping:', error);
            return { success: false, error: error.message };
        } finally {
            await this.cleanup();
        }
        
        return { success: true };
    }
    
}

/**
 * CLI Entry Point
 */
function parseArgs(args) {
    const options = { url: null, help: false };
    for (const arg of args) {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            if (key === 'help' || arg === '-h') options.help = true;
            else process.env[key.toUpperCase().replace(/-/g, '_')] = value;
        } else if (!options.url) {
            options.url = arg;
        }
    }
    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    
    if (options.help || !options.url) {
        console.log(`
🏪 Universal Store Scraper
---------------------------
Usage: node scraper.js <URL> [options]

Options:
  --headless=false       Run in non-headless mode for debugging.
  --save-html=true       Save main and iframe HTML to ./scraped_stores/html_logs
  --debug=true           Enable more verbose logging.
  --use-llm-enhancement=false   Disable the optional LLM cleaning phase.
`);
        return;
    }

    try {
        new URL(options.url);
    } catch (error) {
        console.error('❌ Invalid URL provided.');
        process.exit(1);
    }
    
    const scraper = new ScraperCLI();
    const locationData = {
        timezone: 'America/New_York',
        latitude: 40.7128,
        longitude: -74.0060
    };
    const result = await scraper.scrape(options.url, locationData);
    
    if (result.success) {
        console.log('\n✅ Scraping completed successfully!');
        process.exit(0);
    } else {
        console.error('\n❌ Scraping failed.');
        process.exit(1);
    }
}

module.exports = ScraperCLI;
if (require.main===module) require('./server')(); // allow `node server.js`
