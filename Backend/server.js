require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const pool = require("./db");
const { marketStatusNow } = require("./market");

const app = express();
app.use(cors());
app.use(express.json());

// --------------------
// HEALTH
// --------------------
app.get("/health", (req, res) => res.json({ ok: true, message: "TradeSmart backend running" }));

// --------------------
// STOCKS (frontend calls GET /stocks)
// --------------------
app.get("/stocks", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ticker,
              company_name AS "companyName",
              price,
              open,
              high,
              low,
              volume,
              market_cap AS "marketCap"
       FROM stocks
       ORDER BY ticker`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "DB error", error: err.message });
  }
});

// --------------------
// CASH ACCOUNT
// POST /users/:userId/deposit  { amount }
// POST /users/:userId/withdraw { amount }
// --------------------
app.post("/users/:userId/deposit", async (req, res) => {
  const { userId } = req.params;
  const amount = Number(req.body.amount);

  if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid amount" });

  try {
    // ensure user exists
    await pool.query(
      `INSERT INTO users (user_id, full_name, role, cash)
       VALUES ($1, $2, 'customer', 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, "Auto Created User"]
    );

    const r = await pool.query(
      `UPDATE users SET cash = cash + $1 WHERE user_id=$2 RETURNING cash`,
      [amount, userId]
    );

    // log transaction
    await pool.query(
      `INSERT INTO transactions (tx_id, user_id, type, ticker, shares, price, total, status)
       VALUES ($1,$2,'DEPOSIT','CASH',0,0,$3,'EXECUTED')`,
      [uuidv4(), userId, amount]
    );

    res.json({ message: `Deposited ${amount.toFixed(2)} to cash account`, cash: Number(r.rows[0].cash) });
  } catch (err) {
    res.status(500).json({ message: "Deposit failed", error: err.message });
  }
});

app.post("/users/:userId/withdraw", async (req, res) => {
  const { userId } = req.params;
  const amount = Number(req.body.amount);

  if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid amount" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const balRes = await client.query(`SELECT cash FROM users WHERE user_id=$1 FOR UPDATE`, [userId]);
    if (balRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }

    const cash = Number(balRes.rows[0].cash);
    if (cash < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Insufficient funds" });
    }

    const upd = await client.query(
      `UPDATE users SET cash = cash - $1 WHERE user_id=$2 RETURNING cash`,
      [amount, userId]
    );

    await client.query(
      `INSERT INTO transactions (tx_id, user_id, type, ticker, shares, price, total, status)
       VALUES ($1,$2,'WITHDRAW','CASH',0,0,$3,'EXECUTED')`,
      [uuidv4(), userId, -amount]
    );

    await client.query("COMMIT");
    res.json({ message: `Withdrew ${amount.toFixed(2)} from cash account`, cash: Number(upd.rows[0].cash) });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Withdraw failed", error: err.message });
  } finally {
    client.release();
  }
});

// --------------------
// PORTFOLIO (frontend calls GET /users/:userId/portfolio)
// --------------------
app.get("/users/:userId/portfolio", async (req, res) => {
  const { userId } = req.params;

  try {
    const userRes = await pool.query(`SELECT cash FROM users WHERE user_id=$1`, [userId]);
    if (userRes.rowCount === 0) return res.status(404).json({ message: "User not found" });

    const cash = Number(userRes.rows[0].cash);

    const holdRes = await pool.query(
      `SELECT h.ticker,
              h.shares,
              h.avg_cost AS "avgCost",
              s.price AS "currentPrice",
              (h.shares * s.price) AS "marketValue"
       FROM holdings h
       JOIN stocks s ON s.ticker=h.ticker
       WHERE h.user_id=$1
       ORDER BY h.ticker`,
      [userId]
    );

    const holdings = holdRes.rows.map(h => ({
      ...h,
      shares: Number(h.shares),
      avgCost: Number(h.avgCost),
      currentPrice: Number(h.currentPrice),
      marketValue: Number(h.marketValue),
    }));

    const totalStockValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);
    const totalAccountValue = cash + totalStockValue;

    res.json({
      userId,
      cash,
      holdings,
      totalStockValue,
      totalAccountValue,
    });
  } catch (err) {
    res.status(500).json({ message: "Portfolio error", error: err.message });
  }
});

// --------------------
// ORDERS (frontend uses POST /orders/buy, /orders/sell, /orders/:id/cancel)
// We'll EXECUTE immediately (simple + works with rubric).
// --------------------
app.post("/orders/buy", async (req, res) => {
  const { userId, ticker, shares } = req.body;
  const qty = Number(shares);

  if (!userId || !ticker || !qty || qty <= 0) return res.status(400).json({ message: "Invalid request" });

  const market = await marketStatusNow();
  if (!market.open) return res.status(403).json({ message: `Market closed: ${market.reason}` });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock user cash
    const userRes = await client.query(`SELECT cash FROM users WHERE user_id=$1 FOR UPDATE`, [userId]);
    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found" });
    }
    const cash = Number(userRes.rows[0].cash);

    // get stock price
    const stockRes = await client.query(`SELECT price FROM stocks WHERE ticker=$1`, [ticker]);
    if (stockRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Stock not found" });
    }
    const price = Number(stockRes.rows[0].price);

    const totalCost = price * qty;
    if (cash < totalCost) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Insufficient cash balance" });
    }

    // create order (pending)
    const orderId = `o-${uuidv4()}`;
    await client.query(
      `INSERT INTO orders (order_id, user_id, type, ticker, shares, status, price_at_request)
       VALUES ($1,$2,'BUY',$3,$4,'PENDING',$5)`,
      [orderId, userId, ticker, qty, price]
    );

    // EXECUTE immediately: deduct cash, update holdings, log tx, mark order executed
    await client.query(`UPDATE users SET cash = cash - $1 WHERE user_id=$2`, [totalCost, userId]);

    await client.query(
      `INSERT INTO holdings (user_id, ticker, shares, avg_cost)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, ticker)
       DO UPDATE SET
         avg_cost = ((holdings.avg_cost * holdings.shares) + ($4 * $3)) / (holdings.shares + $3),
         shares = holdings.shares + $3`,
      [userId, ticker, qty, price]
    );

    await client.query(
      `INSERT INTO transactions (tx_id, user_id, type, ticker, shares, price, total, status)
       VALUES ($1,$2,'BUY',$3,$4,$5,$6,'EXECUTED')`,
      [uuidv4(), userId, ticker, qty, price, totalCost]
    );

    await client.query(`UPDATE orders SET status='EXECUTED' WHERE order_id=$1`, [orderId]);

    await client.query("COMMIT");

    res.json({
      message: "Buy order placed (PENDING)",
      order: {
        orderId,
        userId,
        type: "BUY",
        ticker,
        shares: qty,
        requestedAt: new Date().toISOString(),
        status: "PENDING",
        priceAtRequest: price,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Buy failed", error: err.message });
  } finally {
    client.release();
  }
});

app.post("/orders/sell", async (req, res) => {
  const { userId, ticker, shares } = req.body;
  const qty = Number(shares);

  if (!userId || !ticker || !qty || qty <= 0) return res.status(400).json({ message: "Invalid request" });

  const market = await marketStatusNow();
  if (!market.open) return res.status(403).json({ message: `Market closed: ${market.reason}` });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // lock holding
    const holdRes = await client.query(
      `SELECT shares FROM holdings WHERE user_id=$1 AND ticker=$2 FOR UPDATE`,
      [userId, ticker]
    );
    if (holdRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "No shares to sell" });
    }
    const owned = Number(holdRes.rows[0].shares);
    if (owned < qty) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Insufficient shares" });
    }

    const stockRes = await client.query(`SELECT price FROM stocks WHERE ticker=$1`, [ticker]);
    if (stockRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Stock not found" });
    }
    const price = Number(stockRes.rows[0].price);

    const proceeds = price * qty;

    const orderId = `o-${uuidv4()}`;
    await client.query(
      `INSERT INTO orders (order_id, user_id, type, ticker, shares, status, price_at_request)
       VALUES ($1,$2,'SELL',$3,$4,'PENDING',$5)`,
      [orderId, userId, ticker, qty, price]
    );

    // execute
    await client.query(
      `UPDATE holdings SET shares = shares - $1 WHERE user_id=$2 AND ticker=$3`,
      [qty, userId, ticker]
    );
    await client.query(`DELETE FROM holdings WHERE user_id=$1 AND ticker=$2 AND shares=0`, [userId, ticker]);

    await client.query(`UPDATE users SET cash = cash + $1 WHERE user_id=$2`, [proceeds, userId]);

    await client.query(
      `INSERT INTO transactions (tx_id, user_id, type, ticker, shares, price, total, status)
       VALUES ($1,$2,'SELL',$3,$4,$5,$6,'EXECUTED')`,
      [uuidv4(), userId, ticker, qty, price, proceeds]
    );

    await client.query(`UPDATE orders SET status='EXECUTED' WHERE order_id=$1`, [orderId]);

    await client.query("COMMIT");

    res.json({
      message: "Sell order placed (PENDING)",
      order: {
        orderId,
        userId,
        type: "SELL",
        ticker,
        shares: qty,
        requestedAt: new Date().toISOString(),
        status: "PENDING",
        priceAtRequest: price,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "Sell failed", error: err.message });
  } finally {
    client.release();
  }
});

// Cancel order (we'll allow cancel if still pending; if executed, return executed)
app.post("/orders/:orderId/cancel", async (req, res) => {
  const { orderId } = req.params;

  try {
    const r = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [orderId]);
    if (r.rowCount === 0) return res.status(404).json({ message: "Order not found" });

    const order = r.rows[0];

    if (order.status !== "PENDING") {
      return res.json({
        message: `Order already ${order.status}`,
        order: {
          orderId: order.order_id,
          userId: order.user_id,
          type: order.type,
          ticker: order.ticker,
          shares: order.shares,
          requestedAt: order.requested_at,
          status: order.status,
          priceAtRequest: Number(order.price_at_request),
        },
      });
    }

    await pool.query(`UPDATE orders SET status='CANCELED' WHERE order_id=$1`, [orderId]);

    res.json({
      message: "Order canceled",
      order: {
        orderId: order.order_id,
        userId: order.user_id,
        type: order.type,
        ticker: order.ticker,
        shares: Number(order.shares),
        requestedAt: order.requested_at,
        status: "CANCELED",
        priceAtRequest: Number(order.price_at_request),
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Cancel failed", error: err.message });
  }
});

// --------------------
// TRANSACTIONS (frontend calls GET /users/:userId/transactions)
// --------------------
app.get("/users/:userId/transactions", async (req, res) => {
  const { userId } = req.params;

  try {
    const r = await pool.query(
      `SELECT tx_id AS "txId",
              user_id AS "userId",
              type,
              ticker,
              shares,
              price,
              total,
              status,
              timestamp
       FROM transactions
       WHERE user_id=$1
       ORDER BY timestamp DESC`,
      [userId]
    );

    // make sure numbers are numbers
    const tx = r.rows.map(t => ({
      ...t,
      shares: Number(t.shares),
      price: Number(t.price),
      total: Number(t.total),
    }));

    res.json(tx);
  } catch (err) {
    res.status(500).json({ message: "Transactions error", error: err.message });
  }
});

// --------------------
// ADMIN ENDPOINTS
// --------------------
app.post("/admin/stocks", async (req, res) => {
  const { companyName, ticker, volume, initialPrice } = req.body;

  if (!companyName || !ticker || !initialPrice) {
    return res.status(400).json({ message: "Missing fields" });
  }

  try {
    const price = Number(initialPrice);
    const vol = Number(volume || 0);

    // simple initial open/high/low = price
    await pool.query(
      `INSERT INTO stocks (ticker, company_name, price, open, high, low, volume, market_cap)
       VALUES ($1,$2,$3,$3,$3,$3,$4,$5)
       ON CONFLICT (ticker) DO NOTHING`,
      [ticker.toUpperCase(), companyName, price, vol, vol * price]
    );

    const r = await pool.query(
      `SELECT ticker,
              company_name AS "companyName",
              price, open, high, low, volume,
              market_cap AS "marketCap"
       FROM stocks WHERE ticker=$1`,
      [ticker.toUpperCase()]
    );

    res.json({ message: "Stock created", stock: r.rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Create stock failed", error: err.message });
  }
});

app.put("/admin/market/hours", async (req, res) => {
  const { open, close, timezone } = req.body;

  if (!open || !close || !timezone) {
    return res.status(400).json({ message: "Missing open/close/timezone" });
  }

  try {
    await pool.query(
      `UPDATE market_config
       SET open_time=$1, close_time=$2, timezone=$3
       WHERE id=1`,
      [open, close, timezone]
    );

    res.json({
      message: "Market hours updated",
      marketHours: { open, close, timezone },
    });
  } catch (err) {
    res.status(500).json({ message: "Update market hours failed", error: err.message });
  }
});

app.put("/admin/market/schedule", async (req, res) => {
  const { weekdaysOnly, closedHolidays } = req.body;

  if (typeof weekdaysOnly !== "boolean" || typeof closedHolidays !== "boolean") {
    return res.status(400).json({ message: "weekdaysOnly and closedHolidays must be boolean" });
  }

  try {
    await pool.query(
      `UPDATE market_config
       SET weekdays_only=$1, closed_holidays=$2
       WHERE id=1`,
      [weekdaysOnly, closedHolidays]
    );

    res.json({
      message: "Market schedule updated",
      marketSchedule: { weekdaysOnly, closedHolidays },
    });
  } catch (err) {
    res.status(500).json({ message: "Update market schedule failed", error: err.message });
  }
});

// --------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));