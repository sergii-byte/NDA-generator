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

    // ═══════ 3 PARALLEL SEARCHES (rate-limit safe) ═══════
    // 1. UK Companies House (direct API)
    // 2. OpenCorporates (140+ countries, single call, 15 results)
    // 3. Estonia ariregister direct (bonus, may be Cloudflare-blocked)

    const [ukResults, ocResults, ariResults] = await Promise.all([
      searchCompaniesHouse(query).catch(e => { warnings.push('UK Companies House unavailable'); return []; }),
      searchOpenCorporates(query).catch(e => { warnings.push('OpenCorporates unavailable'); return []; }),
      searchEstoniaViaDirect(query).catch(() => []),
    ]);

    // Label OC results with proper register names per jurisdiction
    const labeledOC = ocResults.map(r => ({
      ...r,
      source: JURISDICTION_LABELS[r.jurisdiction] || JURISDICTION_LABELS[(r.jurisdiction || '').split('-')[0]] || 'OpenCorporates',
      url: getRegisterUrl(r.jurisdiction, r.companyNumber) || r.url,
    }));

    // If ariregister returned results, they replace OC Estonian results
    let finalOC = labeledOC;
    if (ariResults.length > 0) {
      finalOC = labeledOC.filter(r => r.jurisdiction !== 'EE');
    }

    // Merge: UK first, then Estonia direct, then OC (labeled)
    let results = [...ukResults, ...ariResults, ...finalOC];

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

    // Sort: prioritize results with addresses
    uniqueResults.sort((a, b) => {
      if (a.address && !b.address) return -1;
      if (!a.address && b.address) return 1;
      return 0;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        results: uniqueResults.slice(0, 15),
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

// ═══════ Jurisdiction Labels & Register URLs ═══════
const JURISDICTION_LABELS = {
  'EE': 'Estonia e-Business Register',
  'LT': 'Lithuania Register of Legal Entities',
  'PL': 'Poland KRS',
  'CZ': 'Czech Commercial Register',
  'DE': 'Germany Handelsregister',
  'HU': 'Hungary Company Register',
  'ES': 'Spain Registro Mercantil',
  'FR': 'France RCS',
  'NL': 'Netherlands KVK',
  'BE': 'Belgium CBE',
  'IE': 'Ireland CRO',
  'AT': 'Austria Firmenbuch',
  'IT': 'Italy Registro Imprese',
  'PT': 'Portugal Registo Comercial',
  'CH': 'Switzerland ZEFIX',
  'GB': 'Companies House UK',
  'SG': 'Singapore ACRA',
  'HK': 'Hong Kong Companies Registry',
  'AE': 'UAE Commercial Register',
  'US': 'US Corporate Registry',
  'US-DE': 'Delaware Division of Corporations',
  'US-NY': 'New York DOS',
  'US-CA': 'California SOS',
  'SV': 'El Salvador Registro de Comercio',
};

function getRegisterUrl(jurisdiction, companyNumber) {
  if (!jurisdiction || !companyNumber) return null;
  const urls = {
    'EE': `https://ariregister.rik.ee/eng/company/${companyNumber}`,
    'LT': `https://rekvizitai.vz.lt/en/company/-/${companyNumber}/`,
    'CZ': `https://or.justice.cz/ias/ui/rejstrik-firma?ico=${companyNumber}`,
    'GB': `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}`,
    'IE': `https://core.cro.ie/company/${companyNumber}`,
  };
  return urls[jurisdiction] || null;
}

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

// ═══════ OpenCorporates (140+ countries, single call) ═══════
async function searchOpenCorporates(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const ocRes = await fetch(
      `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(query)}&per_page=15`,
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

      const jurisdiction = mapJurisdiction(company.jurisdiction_code);

      return {
        source: 'OpenCorporates', // Will be relabeled by JURISDICTION_LABELS
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

// ═══════ Estonia: Direct ariregister API (bonus) ═══════
async function searchEstoniaViaDirect(query) {
  const endpoints = [
    `https://ariregister.rik.ee/est/api/autocomplete?q=${encodeURIComponent(query)}`,
    `https://ariregister.rik.ee/eng/api/autocomplete?q=${encodeURIComponent(query)}`,
  ];
  for (const url of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const eeRes = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://ariregister.rik.ee/",
          "Origin": "https://ariregister.rik.ee",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!eeRes.ok) continue;
      const ct = eeRes.headers.get('content-type') || '';
      if (ct.includes('text/html')) continue;
      const text = await eeRes.text();
      if (!text.trim().startsWith('[')) continue;
      const eeData = JSON.parse(text);
      if (!Array.isArray(eeData) || eeData.length === 0) continue;
      return eeData.map(company => {
        let address = company.legal_address || null;
        if (address && company.zip_code) address = `${address}, ${company.zip_code}`;
        if (address && !address.toLowerCase().includes('estonia') && !address.toLowerCase().includes('eesti')) {
          address = `${address}, Estonia`;
        }
        const statusMap = { 'R': 'Registered', 'Registrisse kantud': 'Registered', 'K': 'Deleted', 'Kustutatud': 'Deleted', 'L': 'In liquidation', 'Likvideerimisel': 'In liquidation' };
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
      continue;
    }
  }
  return [];
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
  const mapped = upper.replace(/_/g, '-');
  const map = {
    'GB': 'GB', 'US-DE': 'US-DE', 'US-NY': 'US-NY', 'US-CA': 'US-CA',
    'EE': 'EE', 'LT': 'LT', 'PL': 'PL', 'CZ': 'CZ', 'ES': 'ES',
    'HU': 'HU', 'DE': 'DE', 'FR': 'FR', 'NL': 'NL', 'IE': 'IE',
    'AE': 'AE', 'AE-DU': 'AE-DU', 'AE-AZ': 'AE-AZ', 'SG': 'SG', 'HK': 'HK',
    'CH': 'CH', 'SV': 'SV', 'BE': 'BE', 'AT': 'AT', 'IT': 'IT', 'PT': 'PT',
  };
  return map[mapped] || mapped;
}
