exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { query, source, fetchDetails, companyUrl } = JSON.parse(event.body);

    // If fetchDetails is true, get full company info from OpenCorporates URL
    if (fetchDetails && companyUrl) {
      return await fetchCompanyDetails(companyUrl, headers);
    }

    if (!query) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Query is required" }) };
    }

    let warnings = [];

    // Run all searches in parallel
    const [ukResults, ocResults, eeResults] = await Promise.all([
      searchCompaniesHouse(query).catch(e => { warnings.push('UK Companies House unavailable'); return []; }),
      searchOpenCorporates(query).catch(e => { warnings.push('OpenCorporates unavailable'); return []; }),
      searchEstoniaRegister(query).catch(e => { warnings.push('Estonia register unavailable'); return []; }),
    ]);

    let results = [...ukResults, ...eeResults, ...ocResults];

    // Remove duplicates by company number + jurisdiction + normalized name
    const uniqueResults = [];
    const seen = new Set();
    results.forEach(r => {
      const key = `${r.companyNumber}-${(r.jurisdiction || '').toLowerCase()}`;
      const nameKey = (r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!seen.has(key) && !seen.has(nameKey)) {
        seen.add(key);
        if (nameKey) seen.add(nameKey);
        uniqueResults.push(r);
      }
    });

    // Sort: prioritize results with addresses, then by source quality
    uniqueResults.sort((a, b) => {
      if (a.address && !b.address) return -1;
      if (!a.address && b.address) return 1;
      const sourceOrder = { 'Companies House UK': 0, 'Estonia e-Business Register': 1, 'OpenCorporates': 2 };
      return (sourceOrder[a.source] || 3) - (sourceOrder[b.source] || 3);
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        results: uniqueResults.slice(0, 12),
        warning: warnings.length > 0 ? warnings.join('; ') : undefined,
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Search failed: " + error.message }),
    };
  }
};

// ═══════ UK Companies House ═══════
async function searchCompaniesHouse(query) {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  const authHeaders = apiKey
    ? { "Authorization": "Basic " + Buffer.from(apiKey + ":").toString('base64') }
    : {};

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const chRes = await fetch(
      `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(query)}&items_per_page=5`,
      {
        headers: { "User-Agent": "NDA-Generator/1.0", ...authHeaders },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!chRes.ok) return [];
    const chData = await chRes.json();
    if (!chData.items) return [];

    // Fetch full profiles in parallel for better address data
    const profilePromises = chData.items.map(async (company) => {
      let fullAddress = company.address_snippet || formatUKAddress(company.address);

      if (apiKey && company.company_number) {
        try {
          const profileRes = await fetch(
            `https://api.company-information.service.gov.uk/company/${company.company_number}`,
            { headers: { "User-Agent": "NDA-Generator/1.0", ...authHeaders } }
          );
          if (profileRes.ok) {
            const profile = await profileRes.json();
            if (profile.registered_office_address) {
              fullAddress = formatUKAddress(profile.registered_office_address);
            }
          }
        } catch (e) { /* use search address */ }
      }

      return {
        source: 'Companies House UK',
        name: company.title,
        jurisdiction: 'GB',
        address: fullAddress,
        status: company.company_status,
        companyNumber: company.company_number,
        incorporationDate: company.date_of_creation,
        companyType: company.company_type,
        url: `https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`
      };
    });

    const results = await Promise.allSettled(profilePromises);
    return results.filter(r => r.status === 'fulfilled').map(r => r.value);
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ═══════ Estonia e-Business Register (ariregister) ═══════
async function searchEstoniaRegister(query) {
  // Try both Estonian and English API endpoints
  const endpoints = [
    `https://ariregister.rik.ee/est/api/autocomplete?q=${encodeURIComponent(query)}`,
    `https://ariregister.rik.ee/eng/api/autocomplete?q=${encodeURIComponent(query)}`,
  ];

  for (const url of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const eeRes = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9,et;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Referer": "https://ariregister.rik.ee/",
          "Origin": "https://ariregister.rik.ee",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!eeRes.ok) {
        console.log(`Estonia API returned ${eeRes.status} for ${url}`);
        continue; // Try next endpoint
      }

      // Check content-type to avoid parsing HTML (Cloudflare challenge)
      const contentType = eeRes.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        console.log('Estonia API returned HTML (likely Cloudflare challenge), skipping');
        continue; // Try next endpoint
      }

      const responseText = await eeRes.text();

      // Safety check: ensure response is actually JSON
      if (!responseText.trim().startsWith('[') && !responseText.trim().startsWith('{')) {
        console.log('Estonia API returned non-JSON response, skipping');
        continue; // Try next endpoint
      }

      const eeData = JSON.parse(responseText);

      // The API returns an array of company objects
      if (!Array.isArray(eeData) || eeData.length === 0) return [];

      return eeData.map(company => {
        // Build address from legal_address and zip_code
        let address = company.legal_address || null;
        if (address && company.zip_code) {
          address = `${address}, ${company.zip_code}`;
        }
        // Append ", Estonia" if address exists and doesn't already mention it
        if (address && !address.toLowerCase().includes('estonia') && !address.toLowerCase().includes('eesti')) {
          address = `${address}, Estonia`;
        }

        // Map status to English
        const statusMap = {
          'R': 'Registered',
          'Registrisse kantud': 'Registered',
          'K': 'Deleted',
          'Kustutatud': 'Deleted',
          'L': 'In liquidation',
          'Likvideerimisel': 'In liquidation',
        };

        return {
          source: 'Estonia e-Business Register',
          name: company.name || company.nimi,
          jurisdiction: 'EE',
          address: address,
          status: statusMap[company.status] || company.status || 'Active',
          companyNumber: String(company.reg_code || company.ariregistri_kood || ''),
          incorporationDate: null,
          companyType: null,
          url: company.url || `https://ariregister.rik.ee/eng/company/${company.reg_code}`,
        };
      }).filter(r => r.name && r.companyNumber);
    } catch (e) {
      clearTimeout(timeout);
      console.log(`Estonia API error for ${url}: ${e.message}`);
      continue; // Try next endpoint
    }
  }

  // All endpoints failed
  throw new Error('Estonia register unavailable');
}

// ═══════ OpenCorporates (140+ countries) ═══════
async function searchOpenCorporates(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const ocRes = await fetch(
      `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(query)}&per_page=8`,
      {
        headers: { "User-Agent": "NDA-Generator/1.0" },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!ocRes.ok) return [];
    const ocData = await ocRes.json();
    if (!ocData.results || !ocData.results.companies) return [];

    return ocData.results.companies.map(c => {
      const company = c.company;

      // Get full address
      let address = company.registered_address_in_full;
      if (!address && company.registered_address) {
        const addr = company.registered_address;
        const parts = [
          addr.street_address,
          addr.locality,
          addr.region,
          addr.postal_code,
          addr.country
        ].filter(Boolean);
        address = parts.join(', ');
      }

      // Map jurisdiction codes
      const jurisdiction = mapJurisdiction(company.jurisdiction_code);

      return {
        source: 'OpenCorporates',
        name: company.name,
        jurisdiction: jurisdiction,
        address: address || null,
        status: company.current_status,
        companyNumber: company.company_number,
        incorporationDate: company.incorporation_date,
        companyType: company.company_type,
        url: company.opencorporates_url
      };
    });
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ═══════ Fetch Full Company Details (OpenCorporates) ═══════
async function fetchCompanyDetails(url, headers) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url + '?format=json', {
      headers: { "User-Agent": "NDA-Generator/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Company not found" }) };
    }

    const data = await res.json();
    const company = data.results?.company;

    if (!company) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Company data not found" }) };
    }

    let address = company.registered_address_in_full;
    if (!address && company.registered_address) {
      const addr = company.registered_address;
      const parts = [
        addr.street_address, addr.locality, addr.region,
        addr.postal_code, addr.country
      ].filter(Boolean);
      address = parts.join(', ');
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        name: company.name,
        jurisdiction: mapJurisdiction(company.jurisdiction_code),
        address: address,
        status: company.current_status,
        companyNumber: company.company_number,
        incorporationDate: company.incorporation_date,
        companyType: company.company_type,
        registeredAgent: company.agent_name,
        url: company.opencorporates_url
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to fetch company details" }),
    };
  }
}

// ═══════ Helpers ═══════
function formatUKAddress(addr) {
  if (!addr) return null;
  const parts = [
    addr.premises,
    addr.address_line_1,
    addr.address_line_2,
    addr.locality,
    addr.region,
    addr.postal_code,
    addr.country
  ].filter(Boolean);
  return parts.join(', ');
}

function mapJurisdiction(code) {
  if (!code) return null;
  const upper = code.toUpperCase();
  // Handle compound codes like US_DE → US-DE, GB_SCT → GB-SCT
  const mapped = upper.replace(/_/g, '-');
  // Common mappings
  const map = {
    'GB': 'GB', 'US-DE': 'US-DE', 'US-NY': 'US-NY', 'US-CA': 'US-CA',
    'EE': 'EE', 'LT': 'LT', 'PL': 'PL', 'CZ': 'CZ', 'ES': 'ES',
    'HU': 'HU', 'DE': 'DE', 'FR': 'FR', 'NL': 'NL', 'IE': 'IE',
    'AE': 'AE', 'AE-DU': 'AE-DU', 'AE-AZ': 'AE-AZ', 'SG': 'SG', 'HK': 'HK',
    'CH': 'CH', 'SV': 'SV', 'BE': 'BE', 'AT': 'AT', 'IT': 'IT', 'PT': 'PT',
  };
  return map[mapped] || mapped;
}
