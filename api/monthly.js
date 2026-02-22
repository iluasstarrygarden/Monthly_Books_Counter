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

    function getMonthRangeUtc(nowUtc, offsetMinutes) {
      const { y, m } = getLocalParts(nowUtc, offsetMinutes);

      // “Local month start” represented in UTC, then convert to real UTC by subtracting offset
      const localStartAsUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0));
      const localEndAsUtc = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));

      const startUtc = new Date(localStartAsUtc.getTime() - offsetMinutes * 60_000);
      const endUtc = new Date(localEndAsUtc.getTime() - offsetMinutes * 60_000);

      return { startUtc, endUtc, y, m };
    }

    const now = new Date();
    const { startUtc, endUtc, y, m } = getMonthRangeUtc(now, TZ_OFFSET_MINUTES);

    // 1) Ask Notion only for “Finished” (Status contains 📘)
    //    We'll enforce the month filter locally for maximum reliability.
    const filter = {
      property: "Status",
      rich_text: { contains: "📘" } // counts 📘 and 📘✨ ARC — Due Dec 15
    };

    let finishedThisMonth = 0;
    let hasMore = true;
    let startCursor = undefined;

    const matches = []; // for debug

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

      for (const page of data.results ?? []) {
        const props = page.properties ?? {};

        // Read End Date safely
        const endDateObj = props["End Date"]?.date;
        const endStart = endDateObj?.start ? new Date(endDateObj.start) : null;

        // STRICT rule: must have BOTH
        // - Status contains 📘 (already filtered by Notion)
        // - End Date exists AND falls inside month window
        if (!endStart || Number.isNaN(endStart.getTime())) continue;

        if (endStart >= startUtc && endStart < endUtc) {
          finishedThisMonth += 1;

          if (req.query?.debug === "1") {
            matches.push({
              title: props["Name"]?.title?.[0]?.plain_text ?? "(untitled)",
              end_date_start: endDateObj.start,
              end_date_end: endDateObj.end ?? null
            });
          }
        }
      }

      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    res.setHeader("Cache-Control", "no-store");

    if (req.query?.debug === "1") {
      return res.status(200).json({
        count: finishedThisMonth,
        tz_offset_minutes: TZ_OFFSET_MINUTES,
        month: `${y}-${String(m + 1).padStart(2, "0")}`,
        startISO: startUtc.toISOString(),
        endISO: endUtc.toISOString(),
        notes: "Counted pages where Status contains 📘 AND End Date is within this month (filtered locally).",
        matches
      });
    }

    return res.status(200).json({ count: finishedThisMonth });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
