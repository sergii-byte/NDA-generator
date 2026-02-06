exports.handler = async (event, context) => {
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

    let results = [];

    // Companies House (UK) - FREE API, good data quality
    if (!source || source === 'uk' || source === 'companieshouse') {
      try {
        // Companies House has a free API with basic auth
        const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
        const authHeaders = apiKey 
          ? { "Authorization": "Basic " + Buffer.from(apiKey + ":").toString('base64') }
          : {};
        
        const chRes = await fetch(
          `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(query)}&items_per_page=5`,
          { 
            headers: { 
              "User-Agent": "NDA-Generator/1.0",
              ...authHeaders
            } 
          }
        );
        if (chRes.ok) {
          const chData = await chRes.json();
          if (chData.items) {
            for (const company of chData.items) {
              // Try to get full company details for better address
              let fullAddress = company.address_snippet || formatUKAddress(company.address);
              
              // If we have API key, fetch full profile for registered office
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
              
              results.push({
                source: 'Companies House UK',
                name: company.title,
                jurisdiction: 'GB',
                address: fullAddress,
                status: company.company_status,
                companyNumber: company.company_number,
                incorporationDate: company.date_of_creation,
                companyType: company.company_type,
                url: `https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`
              });
            }
          }
        }
      } catch (e) { console.error('Companies House error:', e); }
    }

    // OpenCorporates (140+ countries)
    if (!source || source === 'opencorporates' || source === 'global') {
      try {
        const ocRes = await fetch(
          `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(query)}&per_page=8`,
          { headers: { "User-Agent": "NDA-Generator/1.0" } }
        );
        if (ocRes.ok) {
          const ocData = await ocRes.json();
          if (ocData.results && ocData.results.companies) {
            for (const c of ocData.results.companies) {
              const company = c.company;
              
              // Get full address - try registered_address_in_full first
              let address = company.registered_address_in_full;
              
              // If no full address, try to construct from parts
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
              
              // If still no address, try to fetch company details
              if (!address && company.opencorporates_url) {
                try {
                  const detailRes = await fetch(
                    company.opencorporates_url + '?format=json',
                    { headers: { "User-Agent": "NDA-Generator/1.0" } }
                  );
                  if (detailRes.ok) {
                    const detailData = await detailRes.json();
                    const detail = detailData.results?.company;
                    if (detail) {
                      address = detail.registered_address_in_full;
                      if (!address && detail.registered_address) {
                        const addr = detail.registered_address;
                        const parts = [
                          addr.street_address,
                          addr.locality,
                          addr.region,
                          addr.postal_code,
                          addr.country
                        ].filter(Boolean);
                        address = parts.join(', ');
                      }
                    }
                  }
                } catch (e) { /* continue without detailed address */ }
              }
              
              results.push({
                source: 'OpenCorporates',
                name: company.name,
                jurisdiction: company.jurisdiction_code?.toUpperCase(),
                address: address || null,
                status: company.current_status,
                companyNumber: company.company_number,
                incorporationDate: company.incorporation_date,
                companyType: company.company_type,
                url: company.opencorporates_url
              });
            }
          }
        }
      } catch (e) { console.error('OpenCorporates error:', e); }
    }

    // Remove duplicates by company number + jurisdiction
    const uniqueResults = [];
    const seen = new Set();
    results.forEach(r => {
      const key = `${r.companyNumber}-${r.jurisdiction}`.toLowerCase();
      const nameKey = r.name?.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!seen.has(key) && !seen.has(nameKey)) {
        seen.add(key);
        seen.add(nameKey);
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
      body: JSON.stringify({ results: uniqueResults.slice(0, 10) }),
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

// Fetch full company details from OpenCorporates URL
async function fetchCompanyDetails(url, headers) {
  try {
    const res = await fetch(url + '?format=json', {
      headers: { "User-Agent": "NDA-Generator/1.0" }
    });
    
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
        addr.street_address,
        addr.locality,
        addr.region,
        addr.postal_code,
        addr.country
      ].filter(Boolean);
      address = parts.join(', ');
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        name: company.name,
        jurisdiction: company.jurisdiction_code?.toUpperCase(),
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
