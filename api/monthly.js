// api/monthly.js

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    // OPTIONAL: quick debug mode to help you find exact property names
    // Visit: /api/monthly?debug=1
    if (req.query?.debug === "1") {
      const metaResp = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28"
        }
      });

      const meta = await metaResp.json();
      if (!metaResp.ok) return res.status(metaResp.status).json(meta);

      // Return property names + types so we can confirm "Status" and "End Date"
      const props = Object.entries(meta.properties || {}).map(([name, obj]) => ({
        name,
        type: obj?.type
      }));

      return res.status(200).json({
        database_title: meta?.title?.[0]?.plain_text ?? "(no title)",
        properties: props
      });
    }

    // --- Local month range (no UTC gymnastics) ---
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // Notion date comparisons work great with YYYY-MM-DD
    const startISO = startOfMonth.toISOString().split("T")[0];
    const nextISO = startOfNextMonth.toISOString().split("T")[0];

    let count = 0;
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = {
        page_size: 100,
        filter: {
          and: [
            // Status is TEXT (rich_text) in your setup:
            // Finished Regular: "📘"
            // Finished ARC:     "📘✨ ARC"
            {
              or: [
                {
                  property: "Status",
                  rich_text: { equals: "📘" }
                },
                {
                  property: "Status",
                  rich_text: { equals: "📘✨ ARC" }
                }
              ]
            },

            // Count only items finished this month based on End Date
            {
              property: "End Date",
              date: {
                on_or_after: startISO,
                before: nextISO
              }
            }
          ]
        }
      };

      if (startCursor) body.start_cursor = startCursor;

      const resp = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      count += (data.results?.length || 0);
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    // Cache at Vercel edge (fast), refreshes automatically
    res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
    return res.status(200).json({ count, start: startISO, end: nextISO });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
