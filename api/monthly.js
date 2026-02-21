export default async function handler(req, res) {
  try {
    const NOTION_TOKEN = process.env.NOTION_TOKEN;
    const DATABASE_ID = process.env.NOTION_DATABASE_ID;

    // PST = -480, PDT = -420
    const TZ_OFFSET_MINUTES = Number(process.env.NOTION_TZ_OFFSET_MINUTES ?? -480);

    // If your date property name ever changes, set:
    // END_DATE_PROP=End Date
    const END_DATE_PROP = process.env.END_DATE_PROP ?? "End Date";

    if (!NOTION_TOKEN || !DATABASE_ID) {
      return res.status(500).json({ error: "Missing Notion env vars" });
    }

    function getLocalParts(dateUtc, offsetMinutes) {
      const localMs = dateUtc.getTime() + offsetMinutes * 60_000;
      const d = new Date(localMs);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() };
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

    const filter = {
      and: [
        {
          property: "Status",
          rich_text: { contains: "📘" } // counts 📘 and 📘✨ ARC
        },
        {
          property: END_DATE_PROP,
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

    // Collect sample matches for debug (title + end date)
    const debugMatches = [];

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

      // Grab up to 25 entries for debug so we can see WHAT is being counted
      if (req.query?.debug === "1" && debugMatches.length < 25) {
        for (const page of results) {
          const props = page.properties ?? {};

          // Title property: usually the database title field (unknown key),
          // so we search for the first "title" type property.
          let title = "(Untitled)";
          for (const key of Object.keys(props)) {
            if (props[key]?.type === "title") {
              const parts = props[key].title ?? [];
              title = parts.map(t => t.plain_text).join("") || "(Untitled)";
              break;
            }
          }

          const endDate = props[END_DATE_PROP]?.date?.start ?? null;

          debugMatches.push({
            title,
            endDate
          });

          if (debugMatches.length >= 25) break;
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
        end_date_property: END_DATE_PROP,
        filter_explainer: "Status contains 📘 AND End Date within month",
        sample_matches: debugMatches
      });
    }

    return res.status(200).json({ count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
