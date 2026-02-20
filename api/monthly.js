export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    // --- IMPORTANT: match your Notion property names EXACTLY ---
    const STATUS_PROPERTY = "Status";     // your text status property
    const DATE_PROPERTY = "End Date";     // the date you set when you finish a book

    // Your exact finished labels (including emoji)
    const FINISHED_REGULAR = "📘";
    const FINISHED_ARC = "📘✨ ARC";

    // Current month range
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    const startOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

    let count = 0;
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = {
        page_size: 100,
        filter: {
          and: [
            {
              or: [
                {
                  property: STATUS_PROPERTY,
                  rich_text: { equals: FINISHED_REGULAR }
                },
                {
                  property: STATUS_PROPERTY,
                  rich_text: { equals: FINISHED_ARC }
                }
              ]
            },
            {
              property: DATE_PROPERTY,
              date: {
                on_or_after: startOfMonth.toISOString(),
                before: startOfNextMonth.toISOString()
              }
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

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      count,
      month: now.getUTCMonth() + 1,
      year: now.getUTCFullYear()
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
