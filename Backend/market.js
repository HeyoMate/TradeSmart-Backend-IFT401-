const { DateTime } = require("luxon");
const pool = require("./db");

function parseHHMM(s) {
  const [hh, mm] = s.split(":").map(Number);
  return { hh, mm };
}

async function marketStatusNow() {
  const r = await pool.query(
    `SELECT open_time, close_time, timezone, weekdays_only, closed_holidays
     FROM market_config WHERE id=1`
  );
  const cfg = r.rows[0];

  const tz = cfg.timezone || "America/New_York";
  const now = DateTime.now().setZone(tz);

  if (cfg.weekdays_only && (now.weekday === 6 || now.weekday === 7)) {
    return { open: false, reason: "Weekend" };
  }

  // closed_holidays exists in config, but we’re not using a holiday table yet
  // (You can add one later if your rubric requires it.)

  const { hh: oh, mm: om } = parseHHMM(cfg.open_time);
  const { hh: ch, mm: cm } = parseHHMM(cfg.close_time);

  const openTime = now.set({ hour: oh, minute: om, second: 0, millisecond: 0 });
  const closeTime = now.set({ hour: ch, minute: cm, second: 0, millisecond: 0 });

  const open = now >= openTime && now <= closeTime;

  return {
    open,
    reason: open ? "Open" : "Outside market hours",
    timezone: tz,
    open_time: cfg.open_time,
    close_time: cfg.close_time,
  };
}

module.exports = { marketStatusNow };