// Netlify V2 Function — streaming proxy to Anthropic API
// V2 functions use standard Request/Response and support streaming without timeout issues

export default async (req, context) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    const body = await req.json();
    const { prompt } = body;

    if (!prompt) {
      return new Response(JSON.stringify({ error: "Prompt is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API key not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Call Anthropic streaming API directly
    const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error("Anthropic API error:", apiResponse.status, errorText);
      return new Response(
        JSON.stringify({
          error: `Claude API error (${apiResponse.status}). Please try again.`,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Create a TransformStream to process Anthropic SSE into our format
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Process Anthropic stream in background
    (async () => {
      try {
        const reader = apiResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);

              if (
                parsed.type === "content_block_delta" &&
                parsed.delta?.type === "text_delta"
              ) {
                await writer.write(
                  encoder.encode(
                    `data: ${JSON.stringify({ text: parsed.delta.text })}\n\n`
                  )
                );
              } else if (parsed.type === "message_stop") {
                await writer.write(encoder.encode("data: [DONE]\n\n"));
              } else if (parsed.type === "error") {
                await writer.write(
                  encoder.encode(
                    `data: ${JSON.stringify({ error: parsed.error?.message || "Stream error" })}\n\n`
                  )
                );
              }
            } catch (e) {
              // Skip unparseable SSE lines
            }
          }
        }

        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (e) {
        console.error("Stream error:", e);
        try {
          await writer.write(
            encoder.encode(
              `data: ${JSON.stringify({ error: e.message })}\n\n`
            )
          );
        } catch (_) {}
      } finally {
        try {
          await writer.close();
        } catch (_) {}
      }
    })();

    // Return streaming response immediately — this prevents timeout!
    return new Response(readable, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    console.error("Function error:", e);
    return new Response(
      JSON.stringify({ error: "Server error: " + e.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
};

export const config = {
  path: "/api/generate-nda-stream",
  method: "POST",
};
