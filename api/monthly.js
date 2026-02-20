// /api/monthly.js

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Returns { start: "YYYY-MM-DD", endExclusive: "YYYY-MM-DD" } for the month,
 * calculated in a user-defined timezone offset (minutes).
 *
 * Example offsets:
 *  -480 = UTC-8 (Pacific Standard)
 *  -300 = UTC-5 (Eastern Standard)
 *
 * You can set NOTION_TZ_OFFSET_MINUTES in Vercel env vars.
 */
function monthRangeISOWithOffset(now = new Date(), offsetMinutes = 0) {
  // Shift "now" into the desired local time by adding the offset
  const shifted = new Date(now.getTime() + offsetMinutes * 60 * 1000);

  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth(); // 0-11 in shifted "local"

  const start = `${y}-${pad2(m + 1)}-01`;

  // next month (in shifted "local")
  const nextMonth = new Date(Date.UTC(y, m + 1, 1));
  const endExclusive = `${nextMonth.getUTCFullYear()}-${pad2(nextMonth.getUTCMonth() + 1)}-01`;

  return { start, endExclusive };
}

export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    // Timezone offset (minutes). You can override via query while testing.
    // Example: /api/monthly?tz=-480
    const tzFromQuery = req.query.tz != null ? Number(req.query.tz) : null;
    const tzFromEnv = process.env.NOTION_TZ_OFFSET_MINUTES != null
      ? Number(process.env.NOTION_TZ_OFFSET_MINUTES)
      : null;

    // Default to Pacific (-480) if nothing set (change if you want)
    const tzOffsetMinutes = Number.isFinite(tzFromQuery)
      ? tzFromQuery
      : (Number.isFinite(tzFromEnv) ? tzFromEnv : -480);

    // Optional override month/year for testing:
    // /api/monthly?year=2026&month=2&tz=-480  (month 1-12)
    const year = req.query.year ? Number(req.query.year) : null;
    const month = req.query.month ? Number(req.query.month) : null;

    let range;
    if (year && month && month >= 1 && month <= 12) {
      // Create the month boundaries in the desired "local" timezone,
      // but express them as ISO dates (YYYY-MM-DD) for Notion filtering.
      const start = `${year}-${pad2(month)}-01`;
      const next = new Date(Date.UTC(year, month, 1)); // month is 1-12 -> next month
      const endExclusive = `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-01`;
      range = { start, endExclusive };
    } else {
      range = monthRangeISOWithOffset(new Date(), tzOffsetMinutes);
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
            // Status is TEXT (rich_text). Count anything containing 📘
            // This includes both:
            //  - 📘
            //  - 📘✨ ARC
            { property: "Status", rich_text: { contains: "📘" } },

            // STRICT month filter: End Date must exist AND fall in this month
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
          if (matches.length >= 50) break;
        }
      }

      hasMore = data.has_more;
      startCursor = data.next_cursor;

      if (debug && matches.length >= 50) break;
    }

    // Keep cache short while you're building/debugging
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");

    return res.status(200).json(
      debug
        ? { count, range, tzOffsetMinutes, matches }
        : { count }
    );
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
