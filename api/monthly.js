// /api/monthly.js

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthRangeISO(now = new Date()) {
  // Uses server time for "current month". This is OK because we filter by DATE-only ISO (YYYY-MM-DD).
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11

  const start = `${y}-${pad2(m + 1)}-01`;

  const nextMonth = new Date(Date.UTC(y, m + 1, 1));
  const y2 = nextMonth.getUTCFullYear();
  const m2 = nextMonth.getUTCMonth();

  const endExclusive = `${y2}-${pad2(m2 + 1)}-01`; // "before" this date

  return { start, endExclusive };
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    // Optional: override month/year for testing:
    // /api/monthly?year=2026&month=2   (month is 1-12)
    const year = req.query.year ? Number(req.query.year) : null;
    const month = req.query.month ? Number(req.query.month) : null;

    let range;
    if (year && month && month >= 1 && month <= 12) {
      const start = `${year}-${pad2(month)}-01`;
      const next = new Date(Date.UTC(year, month, 1)); // month here is 1-12 => next month in Date.UTC
      const endExclusive = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-01`;
      range = { start, endExclusive };
    } else {
      range = monthRangeISO(new Date());
    }

    const debug = String(req.query.debug || "") === "1";

    let count = 0;
    let hasMore = true;
    let startCursor;

    const matches = [];

    while (hasMore) {
      const body = {
        page_size: 100,
        filter: {
          and: [
            // Status is TEXT (rich_text). We count anything with 📘 (covers 📘 and 📘✨ ARC)
            { property: "Status", rich_text: { contains: "📘" } },

            // STRICT: End Date must exist AND be within this month
            {
              property: "End Date",
              date: {
                on_or_after: range.start,
                before: range.endExclusive
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

      const results = data.results || [];
      count += results.length;

      if (debug) {
        for (const page of results) {
          const props = page.properties || {};
          const titleProp = Object.values(props).find(p => p?.type === "title");
          const title = titleProp?.title?.map(t => t.plain_text).join("") || "(untitled)";

          const endDate = props["End Date"]?.date?.start || null;
          const statusText = props["Status"]?.rich_text?.map(t => t.plain_text).join("") || null;

          matches.push({ title, endDate, statusText });
          if (matches.length >= 25) break;
        }
      }

      hasMore = data.has_more;
      startCursor = data.next_cursor;

      if (debug && matches.length >= 25) break;
    }

    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");

    return res.status(200).json(
      debug
        ? { count, range, matches }
        : { count }
    );
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
