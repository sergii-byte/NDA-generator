const Anthropic = require("@anthropic-ai/sdk").default;

// Extract only relevant parts of HTML (contact info, footer, addresses)
function extractRelevantContent(html) {
  // Remove scripts, styles, and other non-content
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '');
  
  // Extract specific sections that likely contain company info
  const sections = [];
  
  // Look for footer
  const footerMatch = cleaned.match(/<footer[^>]*>[\s\S]*?<\/footer>/gi);
  if (footerMatch) sections.push(...footerMatch);
  
  // Look for contact sections
  const contactPatterns = [
    /<[^>]*(?:id|class)="[^"]*contact[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
    /<[^>]*(?:id|class)="[^"]*address[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
    /<[^>]*(?:id|class)="[^"]*location[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
    /<address[^>]*>[\s\S]*?<\/address>/gi,
  ];
  
  for (const pattern of contactPatterns) {
    const matches = cleaned.match(pattern);
    if (matches) sections.push(...matches);
  }
  
  // Look for Schema.org structured data
  const schemaMatch = cleaned.match(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi);
  if (schemaMatch) sections.push(...schemaMatch);
  
  // Look for text containing address patterns
  const addressPatterns = [
    /(?:registered\s+(?:office|address)|headquarters|head\s+office|hq|corporate\s+address)[:\s]*[^<]{10,200}/gi,
    /\d+[^<]{5,100}(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr)[^<]{5,100}(?:\d{5}|\d{2,4}\s*\d{2,4}|[A-Z]{1,2}\d{1,2}\s*\d[A-Z]{2})/gi,
  ];
  
  for (const pattern of addressPatterns) {
    const matches = cleaned.match(pattern);
    if (matches) sections.push(...matches);
  }
  
  // Get title and meta description
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"[^>]*>/i);
  
  let result = '';
  if (titleMatch) result += `Title: ${titleMatch[1]}\n`;
  if (descMatch) result += `Description: ${descMatch[1]}\n`;
  
  if (sections.length > 0) {
    result += '\nExtracted sections:\n' + sections.join('\n\n');
  }
  
  // If we couldn't extract specific sections, take a smaller portion of the page
  if (sections.length === 0) {
    // Get header area (often contains company name)
    const headerMatch = cleaned.match(/<header[^>]*>[\s\S]*?<\/header>/gi);
    if (headerMatch) result += '\nHeader:\n' + headerMatch[0];
    
    // Get first part of body as fallback
    result += '\nPage content (truncated):\n' + cleaned.substring(0, 8000);
  }
  
  // Strip HTML tags and clean up whitespace
  result = result
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  return result.substring(0, 12000); // Max ~3000 tokens
}

// Helper function to fetch a URL with timeout
async function fetchWithTimeout(url, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      }
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// Try to find and fetch contact page
async function fetchContactPage(baseUrl) {
  const contactPaths = ['/contact', '/contact-us', '/about/contact', '/about-us', '/legal', '/imprint'];
  const url = new URL(baseUrl);
  
  for (const path of contactPaths) {
    try {
      const contactUrl = url.origin + path;
      const response = await fetchWithTimeout(contactUrl, 5000);
      if (response.ok) {
        const html = await response.text();
        if (html.length > 500) return html;
      }
    } catch (e) { /* continue */ }
  }
  return null;
}

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
    const { url } = JSON.parse(event.body);

    if (!url) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "URL is required" }) };
    }

    // Fetch the main website
    let mainHtml = "";
    try {
      const response = await fetchWithTimeout(url);
      mainHtml = await response.text();
    } catch (fetchError) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Could not fetch website" }) };
    }

    // Extract relevant content from main page
    let content = extractRelevantContent(mainHtml);

    // Try contact page if main page content is small
    if (content.length < 2000) {
      try {
        const contactHtml = await fetchContactPage(url);
        if (contactHtml) {
          content += '\n\n--- Contact Page ---\n' + extractRelevantContent(contactHtml);
        }
      } catch (e) { /* continue */ }
    }

    // Limit final content
    content = content.substring(0, 15000);

    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Extract company info from this website content. Return ONLY JSON:
{"name":"Company legal name","addresses":["Full registered/legal address"],"email":"contact email"}

Look for: "Registered Office", "Legal Address", "Headquarters", footer address.
Format address with street, city, postal code, country.

Content:
${content}

JSON only:`
        },
      ],
    });

    const responseText = message.content[0].text;
    
    let companyData;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        companyData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found");
      }
    } catch (parseError) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ name: null, addresses: [], email: null, warning: "Could not extract company info" }),
      };
    }

    if (!Array.isArray(companyData.addresses)) {
      companyData.addresses = companyData.addresses ? [companyData.addresses] : [];
    }
    
    companyData.addresses = companyData.addresses
      .filter(addr => addr && typeof addr === 'string' && addr.length > 10)
      .map(addr => addr.trim());

    return { statusCode: 200, headers, body: JSON.stringify(companyData) };
  } catch (error) {
    console.error("Error:", error);
    
    // Handle rate limit specifically
    if (error.message && error.message.includes('rate_limit')) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: "Rate limit reached. Please wait a moment and try again." }),
      };
    }
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to parse website: " + error.message }),
    };
  }
};
