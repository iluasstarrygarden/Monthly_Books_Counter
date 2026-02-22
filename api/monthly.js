export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    // PST = -480, PDT = -420
    const TZ_OFFSET_MINUTES = Number(process.env.NOTION_TZ_OFFSET_MINUTES ?? -480);

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    // --- helpers ---
    // Convert a Date -> "local" time by applying offset minutes, then extract Y/M safely.
    function getLocalParts(dateUtc, offsetMinutes) {
      const localMs = dateUtc.getTime() + offsetMinutes * 60_000;
      const d = new Date(localMs);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; // month 0-11
    }

    // Build month range [start, end) in UTC ISO, based on the user's offset.
    function getMonthRangeUtcISO(nowUtc, offsetMinutes) {
      // Allow forcing a month for testing:
      // /api/monthly?year=2026&month=2   (month is 1-12)
      const qYear = req.query?.year ? Number(req.query.year) : null;
      const qMonth1 = req.query?.month ? Number(req.query.month) : null;

      let y, m;
      if (qYear && qMonth1 && qMonth1 >= 1 && qMonth1 <= 12) {
        y = qYear;
        m = qMonth1 - 1;
      } else {
        ({ y, m } = getLocalParts(nowUtc, offsetMinutes));
      }

      const localStartAsUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0));
      const localEndAsUtc = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));

      const startUtc = new Date(localStartAsUtc.getTime() - offsetMinutes * 60_000);
      const endUtc = new Date(localEndAsUtc.getTime() - offsetMinutes * 60_000);

      return { startISO: startUtc.toISOString(), endISO: endUtc.toISOString(), y, m };
    }

    const now = new Date();
    const { startISO, endISO, y, m } = getMonthRangeUtcISO(now, TZ_OFFSET_MINUTES);

    // Strict AND:
    // - Status contains 📘 (counts both 📘 and 📘✨ ARC)
    // - End Date is within the month window
    const filter = {
      and: [
        {
          property: "Status",
          rich_text: { contains: "📘" }
        },
        {
          property: "End Date",
          date: {
            on_or_after: startISO,
            before: endISO
          }
        }
      ]
    };

    let count = 0;
    let hasMore = true;
    let startCursor = undefined;

    // Collect matches for debug
    const matches = [];
    const debugMode = req.query?.debug === "1";

    while (hasMore) {
      const body = { page_size: 100, filter };
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

      const results = data.results ?? [];
      count += results.length;

      if (debugMode) {
        for (const page of results) {
          const props = page.properties || {};
          const titleProp = Object.values(props).find((p) => p?.type === "title");
          const title =
            titleProp?.title?.map((t) => t.plain_text).join("") ||
            page.id;

          const endDate = props["End Date"]?.date?.start ?? null;
          const endDateEnd = props["End Date"]?.date?.end ?? null;

          const statusText =
            props["Status"]?.rich_text?.map((t) => t.plain_text).join("") ?? null;

          // cap the debug list so response doesn't get huge
          if (matches.length < 50) {
            matches.push({
              title,
              status: statusText,
              end_date_start: endDate,
              end_date_end: endDateEnd
            });
          }
        }
      }

      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    res.setHeader("Cache-Control", "no-store");

    if (debugMode) {
      return res.status(200).json({
        count,
        tz_offset_minutes: TZ_OFFSET_MINUTES,
        month: `${y}-${String(m + 1).padStart(2, "0")}`,
        startISO,
        endISO,
        notes: "Matches = Status contains 📘 AND End Date within [startISO, endISO)",
        matches
      });
    }

    return res.status(200).json({ count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
