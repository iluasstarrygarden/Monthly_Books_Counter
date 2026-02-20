// /api/monthly.js

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    // ---- Month boundaries (date-only, no time needed) ----
    // If you ever want a specific month for testing:
    // /api/monthly?year=2026&month=2   (month is 1-12)
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || (now.getMonth() + 1); // 1-12

    const start = new Date(year, month - 1, 1);
    const next = new Date(year, month, 1);

    const startStr = start.toISOString().slice(0, 10); // YYYY-MM-DD
    const nextStr = next.toISOString().slice(0, 10);

    // ---- Query + pagination ----
    let count = 0;
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = {
        page_size: 100,
        filter: {
          and: [
            // Status is TEXT (rich_text) in your setup
            // "📘" matches both:
            // - 📘
            // - 📘✨ ARC
            {
              property: "Status",
              rich_text: {
                contains: "📘"
              }
            },
            // End Date is a Notion DATE property
            {
              property: "End Date",
              date: {
                on_or_after: startStr
              }
            },
            {
              property: "End Date",
              date: {
                before: nextStr
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
      if (!resp.ok) {
        // Pass through Notion’s error so you can see EXACTLY what field name/type is wrong
        return res.status(resp.status).json(data);
      }

      count += (data.results?.length || 0);
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    // Cache a little, but not too long while you're testing
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

    return res.status(200).json({
      count,
      month: `${year}-${String(month).padStart(2, "0")}`,
      range: { start: startStr, next: nextStr }
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
