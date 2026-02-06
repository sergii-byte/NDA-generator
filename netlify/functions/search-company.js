exports.handler = async (event, context) => {
  // Handle preflight CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const headers = getCorsHeaders();

  try {
    const { query, source, fetchDetails, companyUrl } = JSON.parse(event.body);

    // If fetchDetails is true, get full company info from OpenCorporates URL
    if (fetchDetails && companyUrl) {
      return await fetchCompanyDetails(companyUrl, headers);
    }

    if (!query) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Query is required" }) };
    }

    const results = [];
    const errors = [];

    // Run searches in parallel for speed
    const searches = [];

    // Companies House (UK) - FREE API, excellent data
    if (!source || source === 'uk' || source === 'companieshouse') {
      searches.push(searchCompaniesHouse(query).catch(e => { errors.push('Companies House: ' + e.message); return []; }));
    }

    // OpenCorporates (140+ countries)
    if (!source || source === 'opencorporates' || source === 'global') {
      searches.push(searchOpenCorporates(query).catch(e => { errors.push('OpenCorporates: ' + e.message); return []; }));
    }

    const searchResults = await Promise.all(searches);
    searchResults.forEach(r => results.push(...r));

    // Remove duplicates by company number + jurisdiction
    const uniqueResults = deduplicateResults(results);

    // Sort: prioritize results with addresses, then by source quality
    uniqueResults.sort((a, b) => {
      if (a.address && !b.address) return -1;
      if (!a.address && b.address) return 1;
      // Prefer Companies House over OpenCorporates
      if (a.source === 'Companies House UK' && b.source !== 'Companies House UK') return -1;
      if (a.source !== 'Companies House UK' && b.source === 'Companies House UK') return 1;
      return 0;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        results: uniqueResults.slice(0, 12),
        ...(errors.length > 0 ? { warnings: errors } : {})
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

// ─── Companies House UK ───
async function searchCompaniesHouse(query) {
  const results = [];
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  const authHeaders = apiKey 
    ? { "Authorization": "Basic " + Buffer.from(apiKey + ":").toString('base64') }
    : {};

  const chRes = await fetchWithTimeout(
    `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(query)}&items_per_page=6`,
    { headers: { "User-Agent": "NDA-Generator/1.0", ...authHeaders } },
    8000
  );

  if (!chRes.ok) return results;

  const chData = await chRes.json();
  if (!chData.items) return results;

  // Fetch full profiles in parallel if we have API key
  const profilePromises = chData.items.map(async (company) => {
    let fullAddress = company.address_snippet || formatUKAddress(company.address);

    if (apiKey && company.company_number) {
      try {
        const profileRes = await fetchWithTimeout(
          `https://api.company-information.service.gov.uk/company/${company.company_number}`,
          { headers: { "User-Agent": "NDA-Generator/1.0", ...authHeaders } },
          5000
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

  const resolved = await Promise.allSettled(profilePromises);
  resolved.forEach(r => { if (r.status === 'fulfilled') results.push(r.value); });
  return results;
}

// ─── OpenCorporates ───
async function searchOpenCorporates(query) {
  const results = [];
  
  const ocRes = await fetchWithTimeout(
    `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(query)}&per_page=10`,
    { headers: { "User-Agent": "NDA-Generator/1.0" } },
    10000
  );

  if (!ocRes.ok) return results;

  const ocData = await ocRes.json();
  if (!ocData.results || !ocData.results.companies) return results;

  for (const c of ocData.results.companies) {
    const company = c.company;
    let address = company.registered_address_in_full;

    if (!address && company.registered_address) {
      const addr = company.registered_address;
      const parts = [addr.street_address, addr.locality, addr.region, addr.postal_code, addr.country].filter(Boolean);
      address = parts.join(', ');
    }

    // For results without address, try to fetch details (but don't block)
    if (!address && company.opencorporates_url) {
      try {
        const detailRes = await fetchWithTimeout(
          company.opencorporates_url + '?format=json',
          { headers: { "User-Agent": "NDA-Generator/1.0" } },
          4000
        );
        if (detailRes.ok) {
          const detailData = await detailRes.json();
          const detail = detailData.results?.company;
          if (detail) {
            address = detail.registered_address_in_full;
            if (!address && detail.registered_address) {
              const addr = detail.registered_address;
              const parts = [addr.street_address, addr.locality, addr.region, addr.postal_code, addr.country].filter(Boolean);
              address = parts.join(', ');
            }
          }
        }
      } catch (e) { /* continue without detailed address */ }
    }

    results.push({
      source: 'OpenCorporates',
      name: company.name,
      jurisdiction: mapJurisdiction(company.jurisdiction_code),
      address: address || null,
      status: company.current_status,
      companyNumber: company.company_number,
      incorporationDate: company.incorporation_date,
      companyType: company.company_type,
      url: company.opencorporates_url
    });
  }

  return results;
}

// ─── Fetch company details ───
async function fetchCompanyDetails(url, headers) {
  try {
    const res = await fetchWithTimeout(url + '?format=json', {
      headers: { "User-Agent": "NDA-Generator/1.0" }
    }, 10000);

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
      const parts = [addr.street_address, addr.locality, addr.region, addr.postal_code, addr.country].filter(Boolean);
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

// ─── Helpers ───
function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

function deduplicateResults(results) {
  const unique = [];
  const seen = new Set();
  results.forEach(r => {
    const key = `${(r.companyNumber || '').toLowerCase()}-${(r.jurisdiction || '').toLowerCase()}`;
    const nameKey = (r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seen.has(key) && !seen.has(nameKey)) {
      seen.add(key);
      seen.add(nameKey);
      unique.push(r);
    }
  });
  return unique;
}

function formatUKAddress(addr) {
  if (!addr) return null;
  const parts = [addr.premises, addr.address_line_1, addr.address_line_2, addr.locality, addr.region, addr.postal_code, addr.country].filter(Boolean);
  return parts.join(', ');
}

// Map OpenCorporates jurisdiction codes to readable format
function mapJurisdiction(code) {
  if (!code) return null;
  const upper = code.toUpperCase();
  const map = {
    'GB': 'GB', 'US_DE': 'US-DE', 'US_NY': 'US-NY', 'US_CA': 'US-CA', 'US_TX': 'US-TX',
    'US_FL': 'US-FL', 'US_NV': 'US-NV', 'US_WY': 'US-WY', 'DE': 'DE', 'FR': 'FR',
    'NL': 'NL', 'EE': 'EE', 'PL': 'PL', 'CZ': 'CZ', 'LT': 'LT', 'ES': 'ES',
    'HU': 'HU', 'AE': 'AE', 'IE': 'IE', 'BE': 'BE', 'AT': 'AT', 'IT': 'IT',
    'CH': 'CH', 'SE': 'SE', 'DK': 'DK', 'FI': 'FI', 'PT': 'PT', 'RO': 'RO',
    'BG': 'BG', 'HR': 'HR', 'SK': 'SK', 'SI': 'SI', 'LV': 'LV', 'UA': 'UA',
    'SG': 'SG', 'HK': 'HK', 'AU': 'AU', 'NZ': 'NZ', 'CA': 'CA', 'JP': 'JP',
    'KR': 'KR', 'IN': 'IN', 'IL': 'IL', 'BR': 'BR', 'MX': 'MX',
  };
  return map[upper] || upper;
}
