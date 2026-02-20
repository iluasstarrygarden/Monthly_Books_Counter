export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    // Current month range (local server time; good enough for this use)
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    // Notion wants ISO strings
    const startISO = startOfMonth.toISOString();
    const endISO = startOfNextMonth.toISOString();

    let count = 0;
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = {
        page_size: 100,
        filter: {
          and: [
            // End Date is within this month
            {
              property: "End Date",
              date: {
                on_or_after: startISO,
                before: endISO
              }
            },

            // Status text is one of your "finished" values
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
            }
          ]
        }
      };

      if (startCursor) body.start_cursor = startCursor;

      const resp = await fetch(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        }
      );

      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      count += (data.results?.length || 0);
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    // While debugging, keep cache short so tests show quickly
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60");
    return res.status(200).json({ count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
