export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    // --- Month boundaries (start of this month -> start of next month), UTC-safe ---
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    const startOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

    const startISO = startOfMonth.toISOString();
    const nextISO = startOfNextMonth.toISOString();

    // --- We treat "Finished" as any Status text containing 📘 (covers 📘 and 📘✨ ARC) ---
    // If your End Date property name is different, rename "End Date" below.
    const makeBody = (filterVariant) => {
      // filterVariant lets us switch between rich_text vs select if needed
      const statusFilter =
        filterVariant === "rich_text"
          ? { property: "Status", rich_text: { contains: "📘" } }
          : { property: "Status", select: { contains: "📘" } };

      return {
        page_size: 100,
        filter: {
          and: [
            statusFilter,
            {
              property: "End Date",
              date: { on_or_after: startISO }
            },
            {
              property: "End Date",
              date: { before: nextISO }
            }
          ]
        }
      };
    };

    async function runQuery(filterVariant) {
      let count = 0;
      let hasMore = true;
      let startCursor = undefined;

      while (hasMore) {
        const body = makeBody(filterVariant);
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
          // bubble up the exact Notion error (super useful for debugging)
          const err = new Error(JSON.stringify(data));
          err.status = resp.status;
          throw err;
        }

        count += (data.results?.length || 0);
        hasMore = data.has_more;
        startCursor = data.next_cursor;
      }

      return count;
    }

    let count;
    try {
      // Your Status is text -> this should work
      count = await runQuery("rich_text");
    } catch (e) {
      // Fallback if Status is actually a Select property
      // (If this also errors, we’ll need the exact property types/names.)
      count = await runQuery("select");
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({ count });
  } catch (err) {
    return res.status(500).json({
      error: String(err),
      hint:
        "If this mentions 'validation_error', double-check property names are exactly 'Status' and 'End Date'. If it mentions 404, check env vars + database sharing."
    });
  }
}
