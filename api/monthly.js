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
    function getLocalParts(dateUtc, offsetMinutes) {
      const localMs = dateUtc.getTime() + offsetMinutes * 60_000;
      const d = new Date(localMs);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
    }

    function getMonthRangeUtcISO(nowUtc, offsetMinutes) {
      const { y, m } = getLocalParts(nowUtc, offsetMinutes);

      // local month boundary expressed as UTC, then convert back to real UTC
      const localStartAsUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0));
      const localEndAsUtc = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));

      const startUtc = new Date(localStartAsUtc.getTime() - offsetMinutes * 60_000);
      const endUtc = new Date(localEndAsUtc.getTime() - offsetMinutes * 60_000);

      return { startISO: startUtc.toISOString(), endISO: endUtc.toISOString(), y, m };
    }

    const now = new Date();
    const { startISO, endISO, y, m } = getMonthRangeUtcISO(now, TZ_OFFSET_MINUTES);

    // ✅ Status rules:
    // - Regular finished = exactly "📘"
    // - ARC finished = starts_with "📘✨ ARC" (so it matches "📘✨ ARC — Due Dec 15" too)
    const statusFilter = {
      or: [
        { property: "Status", rich_text: { equals: "📘" } },
        { property: "Status", rich_text: { starts_with: "📘✨ ARC" } }
      ]
    };

    // ✅ Date rules:
    // - MUST have End Date
    // - End Date must be within this month window
    const endDateFilter = {
      and: [
        { property: "End Date", date: { is_not_empty: true } },
        {
          property: "End Date",
          date: { on_or_after: startISO, before: endISO }
        }
      ]
    };

    // ✅ Strict AND: (Status is finished) AND (End Date is in month)
    const filter = {
      and: [statusFilter, endDateFilter]
    };

    let count = 0;
    let hasMore = true;
    let startCursor = undefined;

    // For debug mode we’ll collect matches so we can SEE which fields Notion is returning.
    const matches = [];

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

      const results = data.results || [];
      count += results.length;

      // Collect debug info from the actual properties
      if (req.query?.debug === "1") {
        for (const page of results) {
          const props = page.properties || {};
          const titleProp = props.Name || props.Title || props.title || null;

          const title =
            titleProp?.title?.map(t => t.plain_text).join("") ||
            titleProp?.rich_text?.map(t => t.plain_text).join("") ||
            "(untitled)";

          const statusText =
            props.Status?.rich_text?.map(t => t.plain_text).join("") ??
            props.Status?.title?.map(t => t.plain_text).join("") ??
            props.Status?.select?.name ??
            "(no status)";

          const endDate = props["End Date"]?.date?.start ?? null;
          const startDate = props["Start Date"]?.date?.start ?? null;

          matches.push({
            title,
            status: statusText,
            start_date: startDate,
            end_date: endDate
          });
        }
      }

      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    res.setHeader("Cache-Control", "no-store");

    if (req.query?.debug === "1") {
      return res.status(200).json({
        count,
        tz_offset_minutes: TZ_OFFSET_MINUTES,
        month: `${y}-${String(m + 1).padStart(2, "0")}`,
        startISO,
        endISO,
        notes:
          "Counts pages where Status is finished (📘 or 📘✨ ARC...) AND End Date is within the month range.",
        matches
      });
    }

    return res.status(200).json({ count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
