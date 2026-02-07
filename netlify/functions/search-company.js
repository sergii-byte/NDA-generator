exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" }, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };

  try {
    const { query, source, fetchDetails, companyUrl } = JSON.parse(event.body);

    if (fetchDetails && companyUrl) {
      return await fetchCompanyDetails(companyUrl, headers);
    }
    if (!query) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Query is required" }) };
    }

    let warnings = [];

    // ═══════ PARALLEL SEARCH — only 4 calls (was 10+) ═══════
    // 1. UK Companies House   (direct API)
    // 2. Estonia ariregister   (free autocomplete, no auth)
    // 3. Czech ARES            (free REST API, no auth)
    // 4. OpenCorporates        (single call, per_page=15, covers 140+ countries)

    const [ukResults, eeResults, czResults, ocResults] = await Promise.all([
      searchCompaniesHouse(query).catch(e => { warnings.push('UK Companies House unavailable'); return []; }),
      searchEstoniaAriregister(query).catch(e => { warnings.push('Estonia register unavailable'); return []; }),
      searchCzechARES(query).catch(e => { warnings.push('Czech ARES unavailable'); return []; }),
      searchOpenCorporates(query).catch(e => { warnings.push('OpenCorporates unavailable'); return []; }),
    ]);

    // Direct registers first (higher quality data), then OC as fallback
    let results = [...ukResults, ...eeResults, ...czResults, ...ocResults];

    // Deduplicate by reg number + jurisdiction + normalized name
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

    // Sort: prefer results with addresses, then direct sources over OC
    uniqueResults.sort((a, b) => {
      if (a.address && !b.address) return -1;
      if (!a.address && b.address) return 1;
      const aIsOC = a.source === 'OpenCorporates' ? 1 : 0;
      const bIsOC = b.source === 'OpenCorporates' ? 1 : 0;
      return aIsOC - bIsOC;
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        results: uniqueResults.slice(0, 15),
        warning: warnings.length > 0 ? warnings.join('; ') : undefined,
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Search failed: " + error.message }) };
  }
};


// ═══════════════════════════════════════════════════════════
// UK Companies House
// ═══════════════════════════════════════════════════════════
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
      { headers: { "User-Agent": "NDA-Generator/1.0", ...authHeaders }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!chRes.ok) return [];
    const chData = await safeJson(chRes);
    if (!chData || !chData.items) return [];

    const profilePromises = chData.items.map(async (company) => {
      let fullAddress = company.address_snippet || formatUKAddress(company.address);
      if (apiKey && company.company_number) {
        try {
          const profileRes = await fetch(
            `https://api.company-information.service.gov.uk/company/${company.company_number}`,
            { headers: { "User-Agent": "NDA-Generator/1.0", ...authHeaders } }
          );
          if (profileRes.ok) {
            const profile = await safeJson(profileRes);
            if (profile && profile.registered_office_address) {
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


// ═══════════════════════════════════════════════════════════
// Estonia — ariregister.rik.ee Autocomplete API (FREE, no auth)
// Docs: https://avaandmed.ariregister.rik.ee/en/node/31
// ═══════════════════════════════════════════════════════════
async function searchEstoniaAriregister(query) {
  const endpoints = [
    `https://ariregister.rik.ee/est/api/autocomplete?q=${encodeURIComponent(query)}`,
    `https://ariregister.rik.ee/eng/api/autocomplete?q=${encodeURIComponent(query)}`,
  ];

  for (const url of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, {
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
      if (!res.ok) continue;

      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) continue;

      const text = await res.text();
      if (!text.trim().startsWith('[') && !text.trim().startsWith('{')) continue;

      const data = JSON.parse(text);
      const items = Array.isArray(data) ? data : [];
      if (items.length === 0) continue;

      return items.map(c => {
        let address = c.legal_address || null;
        if (address && c.zip_code) address = `${address}, ${c.zip_code}`;
        if (address && !address.toLowerCase().includes('estonia') && !address.toLowerCase().includes('eesti')) {
          address = `${address}, Estonia`;
        }
        const statusMap = { 'R': 'Registered', 'Registrisse kantud': 'Registered', 'K': 'Deleted', 'Kustutatud': 'Deleted', 'L': 'In liquidation', 'Likvideerimisel': 'In liquidation' };
        const regCode = String(c.reg_code || c.ariregistri_kood || '');
        return {
          source: 'Estonia e-Business Register',
          name: c.name || c.nimi,
          jurisdiction: 'EE',
          address,
          status: statusMap[c.status] || c.status || 'Active',
          companyNumber: regCode,
          incorporationDate: null,
          companyType: null,
          url: `https://ariregister.rik.ee/eng/company/${regCode}`,
        };
      }).filter(r => r.name && r.companyNumber);
    } catch (e) {
      clearTimeout(timeout);
      continue;
    }
  }
  return [];
}


// ═══════════════════════════════════════════════════════════
// Czech Republic — ARES REST API (FREE, no auth)
// Docs: https://ares.gov.cz/swagger-ui/
// ═══════════════════════════════════════════════════════════
async function searchCzechARES(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    // POST search endpoint (preferred)
    const res = await fetch(
      'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/vyhledat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'NDA-Generator/1.0' },
        body: JSON.stringify({ obchodniJmeno: query, start: 0, pocet: 10 }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) return await searchCzechARESGet(query);

    const data = await safeJson(res);
    if (!data) return await searchCzechARESGet(query);

    const subjects = data.ekonomickeSubjekty;
    if (!Array.isArray(subjects) || subjects.length === 0) return await searchCzechARESGet(query);

    return subjects.map(s => formatCzechResult(s)).filter(r => r.name);

  } catch (e) {
    clearTimeout(timeout);
    try { return await searchCzechARESGet(query); } catch (e2) { return []; }
  }
}

// ARES GET fallback
async function searchCzechARESGet(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(
      `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty?obchodniJmeno=${encodeURIComponent(query)}&start=0&pocet=10`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'NDA-Generator/1.0' }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await safeJson(res);
    if (!data || !Array.isArray(data.ekonomickeSubjekty)) return [];
    return data.ekonomickeSubjekty.map(s => formatCzechResult(s)).filter(r => r.name);
  } catch (e) {
    clearTimeout(timeout);
    return [];
  }
}

function formatCzechResult(subj) {
  let address = null;
  if (subj.sidlo) {
    const s = subj.sidlo;
    if (s.textovaAdresa) {
      address = s.textovaAdresa;
      if (!address.includes('Czech') && !address.includes('Česk')) address += ', Czech Republic';
    } else {
      const street = s.nazevUlice
        ? `${s.nazevUlice} ${s.cisloDomovni || ''}${s.cisloOrientacni ? '/' + s.cisloOrientacni : ''}`.trim()
        : (s.cisloDomovni ? `č.p. ${s.cisloDomovni}` : null);
      const parts = [
        street,
        s.nazevCastiObce && s.nazevCastiObce !== s.nazevObce ? s.nazevCastiObce : null,
        s.nazevObce,
        s.psc,
        s.nazevStatu || 'Czech Republic'
      ].filter(Boolean);
      address = parts.join(', ');
    }
  }

  const legalForms = {
    '101': 'v.o.s.', '112': 's.r.o.', '121': 'a.s.', '131': 'k.s.',
    '141': 'o.p.s.', '205': 'Družstvo', '301': 'Státní podnik',
    '421': 'Zahraniční osoba', '706': 'Spolek', '801': 'Obec',
  };

  const ico = String(subj.ico || '').padStart(8, '0');

  return {
    source: 'Czech ARES',
    name: subj.obchodniJmeno || subj.nazev,
    jurisdiction: 'CZ',
    address,
    status: subj.stavSubjektu === 'AKTIVNI' ? 'Active' : (subj.stavSubjektu || 'Active'),
    companyNumber: ico,
    incorporationDate: subj.datumVzniku || null,
    companyType: legalForms[String(subj.pravniForma)] || null,
    url: `https://ares.gov.cz/ekonomicke-subjekty?ico=${ico}`,
  };
}


// ═══════════════════════════════════════════════════════════
// OpenCorporates (140+ countries — single call)
// ═══════════════════════════════════════════════════════════
async function searchOpenCorporates(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const ocRes = await fetch(
      `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(query)}&per_page=15`,
      { headers: { "User-Agent": "NDA-Generator/1.0" }, signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!ocRes.ok) return [];
    const ocData = await safeJson(ocRes);
    if (!ocData || !ocData.results || !ocData.results.companies) return [];

    return ocData.results.companies.map(c => {
      const company = c.company;
      let address = company.registered_address_in_full;
      if (!address && company.registered_address) {
        const addr = company.registered_address;
        address = [addr.street_address, addr.locality, addr.region, addr.postal_code, addr.country].filter(Boolean).join(', ');
      }
      return {
        source: 'OpenCorporates',
        name: company.name,
        jurisdiction: mapJurisdiction(company.jurisdiction_code),
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


// ═══════════════════════════════════════════════════════════
// Fetch Full Company Details (OpenCorporates)
// ═══════════════════════════════════════════════════════════
async function fetchCompanyDetails(url, headers) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url + '?format=json', {
      headers: { "User-Agent": "NDA-Generator/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return { statusCode: 404, headers, body: JSON.stringify({ error: "Company not found" }) };

    const data = await safeJson(res);
    if (!data) return { statusCode: 404, headers, body: JSON.stringify({ error: "Invalid response" }) };
    const company = data.results?.company;
    if (!company) return { statusCode: 404, headers, body: JSON.stringify({ error: "Company data not found" }) };

    let address = company.registered_address_in_full;
    if (!address && company.registered_address) {
      const addr = company.registered_address;
      address = [addr.street_address, addr.locality, addr.region, addr.postal_code, addr.country].filter(Boolean).join(', ');
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        name: company.name,
        jurisdiction: mapJurisdiction(company.jurisdiction_code),
        address,
        status: company.current_status,
        companyNumber: company.company_number,
        incorporationDate: company.incorporation_date,
        companyType: company.company_type,
        registeredAgent: company.agent_name,
        url: company.opencorporates_url
      }),
    };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to fetch company details" }) };
  }
}


// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

// Safe JSON parser — handles HTML error pages, malformed responses
async function safeJson(res) {
  try {
    const text = await res.text();
    if (!text || text.trim().startsWith('<')) return null;
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function formatUKAddress(addr) {
  if (!addr) return null;
  return [addr.premises, addr.address_line_1, addr.address_line_2, addr.locality, addr.region, addr.postal_code, addr.country].filter(Boolean).join(', ');
}

function mapJurisdiction(code) {
  if (!code) return null;
  const mapped = code.toUpperCase().replace(/_/g, '-');
  const map = {
    'GB': 'GB', 'US-DE': 'US-DE', 'US-NY': 'US-NY', 'US-CA': 'US-CA',
    'EE': 'EE', 'LT': 'LT', 'PL': 'PL', 'CZ': 'CZ', 'ES': 'ES',
    'HU': 'HU', 'DE': 'DE', 'FR': 'FR', 'NL': 'NL', 'IE': 'IE',
    'AE': 'AE', 'AE-DU': 'AE-DU', 'AE-AZ': 'AE-AZ', 'SG': 'SG', 'HK': 'HK',
    'CH': 'CH', 'SV': 'SV', 'BE': 'BE', 'AT': 'AT', 'IT': 'IT', 'PT': 'PT',
  };
  return map[mapped] || mapped;
}
