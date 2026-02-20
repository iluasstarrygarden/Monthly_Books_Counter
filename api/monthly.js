// /api/monthly.js

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    const debug = String(req.query.debug || "") === "1";

    let count = 0;
    let hasMore = true;
    let startCursor = undefined;

    // Collect a few matches so we can identify "the 1"
    const matches = [];

    while (hasMore) {
      const body = {
        page_size: 100,
        filter: {
          and: [
            // Status is TEXT (rich_text)
            { property: "Status", rich_text: { contains: "📘" } },

            // End Date is a Notion DATE property
            // Uses Notion’s "this month" logic (avoids UTC boundary weirdness)
            { property: "End Date", date: { this_month: {} } }
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

      const results = data.results || [];
      count += results.length;

      if (debug) {
        for (const page of results) {
          // title can vary by property name, so we try to grab the first title field
          const props = page.properties || {};
          const titleProp = Object.values(props).find(p => p?.type === "title");
          const title = titleProp?.title?.map(t => t.plain_text).join("") || "(untitled)";

          const endDate = props["End Date"]?.date?.start || null;
          const statusText = props["Status"]?.rich_text?.map(t => t.plain_text).join("") || null;

          matches.push({ title, endDate, statusText });

          // don’t spam huge responses
          if (matches.length >= 20) break;
        }
      }

      hasMore = data.has_more;
      startCursor = data.next_cursor;

      if (debug && matches.length >= 20) break;
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");

    return res.status(200).json(
      debug
        ? { count, matches }
        : { count }
    );
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
