const Anthropic = require("@anthropic-ai/sdk").default;

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const { image, mimeType } = JSON.parse(event.body);

    if (!image) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Image is required" }),
      };
    }

    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType || "image/jpeg",
                data: image,
              },
            },
            {
              type: "text",
              text: `Extract contact information from this business card. Return ONLY valid JSON with these fields (use null if not found):

{
  "name": "Person's full name",
  "company": "Company name",
  "title": "Job title",
  "email": "Email address",
  "phone": "Phone number",
  "address": "Full address"
}

Return ONLY the JSON, no explanation.`
            }
          ],
        },
      ],
    });

    const responseText = message.content[0].text;
    
    // Parse the JSON response
    let cardData;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cardData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found");
      }
    } catch (parseError) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          name: null, 
          company: null,
          email: null,
          address: null,
          warning: "Could not extract info from card"
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(cardData),
    };
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to parse card: " + error.message }),
    };
  }
};
