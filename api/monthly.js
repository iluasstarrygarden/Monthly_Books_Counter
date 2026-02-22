export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    // PST = -480, PDT = -420
    const TZ_OFFSET_MINUTES = Number(process.env.NOTION_TZ_OFFSET_MINUTES ?? -480);

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    function getLocalParts(dateUtc, offsetMinutes) {
      const localMs = dateUtc.getTime() + offsetMinutes * 60_000;
      const d = new Date(localMs);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
    }

    function getMonthRangeUtcISO(nowUtc, offsetMinutes) {
      const { y, m } = getLocalParts(nowUtc, offsetMinutes);

      const localStartAsUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0));
      const localEndAsUtc = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));

      const startUtc = new Date(localStartAsUtc.getTime() - offsetMinutes * 60_000);
      const endUtc = new Date(localEndAsUtc.getTime() - offsetMinutes * 60_000);

      return { startISO: startUtc.toISOString(), endISO: endUtc.toISOString(), y, m };
    }

    const now = new Date();
    const { startISO, endISO, y, m } = getMonthRangeUtcISO(now, TZ_OFFSET_MINUTES);

    // STRICT finished statuses only
    const FINISHED_VALUES = ["📘", "📘✨ ARC"];

    const filter = {
      and: [
        {
          or: FINISHED_VALUES.map((val) => ({
            property: "Status",
            rich_text: { equals: val }
          }))
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

      count += (data.results?.length || 0);

      if (req.query?.debug === "1") {
        for (const page of data.results || []) {
          const props = page.properties || {};
          const titleProp = Object.values(props).find((p) => p?.type === "title");
          const title = titleProp?.title?.[0]?.plain_text ?? "(untitled)";
          const status = props["Status"]?.rich_text?.map((t) => t.plain_text).join("") ?? "";
          const end = props["End Date"]?.date?.start ?? null;
          matches.push({ title, status, end });
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
        finished_values: FINISHED_VALUES,
        matches
      });
    }

    return res.status(200).json({ count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
