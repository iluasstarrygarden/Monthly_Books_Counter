export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    // PST = -480, PDT = -420
    // If you want it stable all year, keep -480.
    const TZ_OFFSET_MINUTES = Number(process.env.NOTION_TZ_OFFSET_MINUTES ?? -480);

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    // ---- Helpers ----
    function getLocalParts(dateUtc, offsetMinutes) {
      const localMs = dateUtc.getTime() + offsetMinutes * 60_000;
      const d = new Date(localMs);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() };
    }

    function getMonthRangeUtc(nowUtc, offsetMinutes) {
      const { y, m } = getLocalParts(nowUtc, offsetMinutes);

      // Build local month boundaries as UTC, then shift back to real UTC by subtracting offset
      const localStartAsUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0));
      const localEndAsUtc = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));

      const startUtc = new Date(localStartAsUtc.getTime() - offsetMinutes * 60_000);
      const endUtc = new Date(localEndAsUtc.getTime() - offsetMinutes * 60_000);

      return { startUtc, endUtc, y, m };
    }

    // Notion date can be:
    // - "2026-02-20" (date-only)
    // - "2026-02-20T19:22:00.000-08:00" (datetime)
    // Convert both into a UTC millisecond timestamp, treating date-only as local midnight.
    function notionDateToUtcMs(dateStr, offsetMinutes) {
      if (!dateStr) return null;

      // datetime
      if (dateStr.includes("T")) {
        const ms = Date.parse(dateStr);
        return Number.isFinite(ms) ? ms : null;
      }

      // date-only: interpret as local midnight -> convert to UTC by subtracting offset
      const [yy, mm, dd] = dateStr.split("-").map(Number);
      if (!yy || !mm || !dd) return null;

      const localMidnightAsUtc = Date.UTC(yy, mm - 1, dd, 0, 0, 0);
      const utcMs = localMidnightAsUtc - offsetMinutes * 60_000;
      return utcMs;
    }

    const now = new Date();
    const { startUtc, endUtc, y, m } = getMonthRangeUtc(now, TZ_OFFSET_MINUTES);

    // ---- Query Notion (broad but safe), then enforce month filter locally ----
    // We query:
    // - Status equals 📘 OR starts_with 📘✨ ARC
    // - End Date is not empty
    const filter = {
      and: [
        {
          or: [
            { property: "Status", rich_text: { equals: "📘" } },
            { property: "Status", rich_text: { starts_with: "📘✨ ARC" } }
          ]
        },
        { property: "End Date", date: { is_not_empty: true } }
      ]
    };

    let counted = 0;
    let hasMore = true;
    let startCursor = undefined;

    const debugMatches = [];
    const startMs = startUtc.getTime();
    const endMs = endUtc.getTime();

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

      for (const page of results) {
        const props = page.properties || {};

        // Title
        const titleProp = Object.values(props).find(p => p?.type === "title");
        const title = titleProp?.title?.map(t => t.plain_text).join("") || "(untitled)";

        // Status text
        const status = props["Status"]?.rich_text?.map(t => t.plain_text).join("") ?? "";

        // End date
        const endDateStr = props["End Date"]?.date?.start ?? null;
        const endMsVal = endDateStr ? notionDateToUtcMs(endDateStr, TZ_OFFSET_MINUTES) : null;

        const inThisMonth =
          endMsVal != null &&
          endMsVal >= startMs &&
          endMsVal < endMs;

        if (req.query?.debug === "1") {
          debugMatches.push({
            title,
            status,
            end_date_start: endDateStr,
            end_date_ms: endMsVal,
            in_this_month: inThisMonth
          });
        }

        if (inThisMonth) counted += 1;
      }

      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    res.setHeader("Cache-Control", "no-store");

    // Version stamp so you can confirm you're hitting THIS code
    const version = "monthly-v3-local-month-filter";

    if (req.query?.debug === "1") {
      return res.status(200).json({
        version,
        count: counted,
        tz_offset_minutes: TZ_OFFSET_MINUTES,
        month: `${y}-${String(m + 1).padStart(2, "0")}`,
        startISO: startUtc.toISOString(),
        endISO: endUtc.toISOString(),
        notes:
          'Counts pages where Status is exactly "📘" OR starts_with "📘✨ ARC", AND End Date exists, AND End Date falls inside this month (enforced in JS).',
        matches: debugMatches
      });
    }

    return res.status(200).json({ count: counted, version });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
