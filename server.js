import express from "express";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

const db = new Database("db.sqlite");

// --- DB init ---
db.exec(`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sale_price REAL NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'حبة',
  min_stock REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
  qty REAL NOT NULL CHECK (qty > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT UNIQUE NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','bank','deferred')),
  total REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty REAL NOT NULL CHECK (qty > 0),
  price REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  original_amount REAL NOT NULL,
  remaining_amount REAL NOT NULL,
  sale_id INTEGER,
  due_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('OPEN','PARTIAL','PAID','OVERDUE')) DEFAULT 'OPEN',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS debt_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  debt_id INTEGER NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','bank')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (debt_id) REFERENCES debts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS whatsapp_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_phone TEXT NOT NULL,
  debt_id INTEGER,
  message TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT DEFAULT 'SENT',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (debt_id) REFERENCES debts(id) ON DELETE SET NULL
);
`);

// --- helpers ---
function toISODateTime(d = new Date()) {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function getStock(productId) {
  const inQty = db
    .prepare("SELECT COALESCE(SUM(qty),0) s FROM stock_movements WHERE product_id=? AND type='IN'")
    .get(productId).s;
  const outQty = db
    .prepare("SELECT COALESCE(SUM(qty),0) s FROM stock_movements WHERE product_id=? AND type='OUT'")
    .get(productId).s;
  return Number(inQty) - Number(outQty);
}

function requireE164(phone) {
  // بسيط: لازم يبدأ بـ + وأرقام
  if (!/^\+\d{8,15}$/.test(phone)) {
    const err = new Error("رقم الهاتف لازم يكون بصيغة دولية E.164 مثل +968xxxxxxxx");
    err.status = 400;
    throw err;
  }
}

// --- Products ---
app.post("/api/products", (req, res, next) => {
  try {
    const { sku, name, sale_price = 0, unit = "حبة", min_stock = 0 } = req.body;
    if (!sku || !name) return res.status(400).json({ error: "sku و name مطلوبين" });

    const stmt = db.prepare(
      "INSERT INTO products (sku, name, sale_price, unit, min_stock) VALUES (?,?,?,?,?)"
    );
    const info = stmt.run(String(sku).trim(), String(name).trim(), Number(sale_price), unit, Number(min_stock));
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "رقم الصنف sku موجود مسبقاً" });
    next(e);
  }
});

app.get("/api/products", (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const rows = q
    ? db.prepare("SELECT * FROM products WHERE sku LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT 100")
        .all(`%${q}%`, `%${q}%`)
    : db.prepare("SELECT * FROM products ORDER BY id DESC LIMIT 100").all();

  const data = rows.map(r => ({ ...r, stock: getStock(r.id) }));
  res.json(data);
});

// --- Stock IN ---
app.post("/api/stock/in", (req, res, next) => {
  try {
    const { product_id, qty, note, created_at } = req.body;
    if (!product_id || !qty) return res.status(400).json({ error: "product_id و qty مطلوبين" });

    db.prepare("INSERT INTO stock_movements (product_id, type, qty, note, created_at) VALUES (?,?,?,?,?)")
      .run(Number(product_id), "IN", Number(qty), note || null, created_at || toISODateTime());
    res.json({ ok: true, stock: getStock(Number(product_id)) });
  } catch (e) {
    next(e);
  }
});

// --- Sales (creates OUT movements automatically) ---
app.post("/api/sales", (req, res, next) => {
  const tx = db.transaction(() => {
    const { items, payment_method, paid = 0, customer_name, customer_phone, due_date } = req.body;

    if (!Array.isArray(items) || items.length === 0) throw Object.assign(new Error("items مطلوب"), { status: 400 });
    if (!["cash", "bank", "deferred"].includes(payment_method)) throw Object.assign(new Error("payment_method غير صحيح"), { status: 400 });

    if (payment_method === "deferred") {
      if (!customer_name || !customer_phone) throw Object.assign(new Error("اسم العميل ورقم الهاتف مطلوبين للدين المؤجل"), { status: 400 });
      requireE164(customer_phone);
    }

    // price ثابت من المنتج (لا تعديل من الواجهة)
    let total = 0;
    const normalized = items.map(it => {
      const p = db.prepare("SELECT * FROM products WHERE id=?").get(Number(it.product_id));
      if (!p) throw Object.assign(new Error("منتج غير موجود"), { status: 404 });

      const qty = Number(it.qty);
      if (!(qty > 0)) throw Object.assign(new Error("qty غير صحيح"), { status: 400 });

      const stock = getStock(p.id);
      if (qty > stock) throw Object.assign(new Error(`المخزون لا يكفي للصنف ${p.name} (المتوفر ${stock})`), { status: 400 });

      const price = Number(p.sale_price);
      total += price * qty;
      return { product_id: p.id, qty, price };
    });

    const invoice_no = "INV-" + Date.now();
    const saleInfo = db.prepare(
      "INSERT INTO sales (invoice_no, customer_name, customer_phone, payment_method, total, paid) VALUES (?,?,?,?,?,?)"
    ).run(invoice_no, customer_name || null, customer_phone || null, payment_method, total, Number(paid));

    const saleId = saleInfo.lastInsertRowid;

    const itemStmt = db.prepare("INSERT INTO sale_items (sale_id, product_id, qty, price) VALUES (?,?,?,?)");
    const outStmt = db.prepare("INSERT INTO stock_movements (product_id, type, qty, note) VALUES (?,?,?,?)");

    for (const it of normalized) {
      itemStmt.run(saleId, it.product_id, it.qty, it.price);
      outStmt.run(it.product_id, "OUT", it.qty, `Sale#${invoice_no}`);
    }

    // create debt if deferred
    if (payment_method === "deferred") {
      const remaining = Math.max(0, total - Number(paid || 0));
      const status = remaining === 0 ? "PAID" : (Number(paid || 0) > 0 ? "PARTIAL" : "OPEN");
      db.prepare(
        "INSERT INTO debts (customer_name, customer_phone, original_amount, remaining_amount, sale_id, due_date, status) VALUES (?,?,?,?,?,?,?)"
      ).run(customer_name, customer_phone, total, remaining, saleId, due_date || null, status);
    }

    return { sale_id: saleId, invoice_no, total };
  });

  try {
    const result = tx();
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// --- Debts ---
app.get("/api/debts", (req, res) => {
  const q = (req.query.q || "").toString().trim();
  const rows = q
    ? db.prepare("SELECT * FROM debts WHERE customer_name LIKE ? OR customer_phone LIKE ? ORDER BY id DESC LIMIT 200")
        .all(`%${q}%`, `%${q}%`)
    : db.prepare("SELECT * FROM debts ORDER BY id DESC LIMIT 200").all();
  res.json(rows);
});

app.post("/api/debts/:id/pay", (req, res, next) => {
  try {
    const debtId = Number(req.params.id);
    const { amount, payment_method } = req.body;
    if (!amount || !payment_method) return res.status(400).json({ error: "amount و payment_method مطلوبين" });
    if (!["cash", "bank"].includes(payment_method)) return res.status(400).json({ error: "payment_method غير صحيح" });

    const debt = db.prepare("SELECT * FROM debts WHERE id=?").get(debtId);
    if (!debt) return res.status(404).json({ error: "الدين غير موجود" });

    const pay = Number(amount);
    const remaining = Math.max(0, Number(debt.remaining_amount) - pay);

    const status = remaining === 0 ? "PAID" : "PARTIAL";

    const t = db.transaction(() => {
      db.prepare("INSERT INTO debt_payments (debt_id, amount, payment_method) VALUES (?,?,?)")
        .run(debtId, pay, payment_method);
      db.prepare("UPDATE debts SET remaining_amount=?, status=? WHERE id=?")
        .run(remaining, status, debtId);
    });
    t();

    res.json({ ok: true, remaining, status });
  } catch (e) {
    next(e);
  }
});

// --- WhatsApp send (Cloud API) ---
app.post("/api/whatsapp/send-debt/:id", async (req, res, next) => {
  try {
    const debtId = Number(req.params.id);
    const debt = db.prepare("SELECT * FROM debts WHERE id=?").get(debtId);
    if (!debt) return res.status(404).json({ error: "الدين غير موجود" });

    requireE164(debt.customer_phone);

    const WA_TOKEN = process.env.WA_TOKEN;
    const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
    const FROM_NAME = process.env.WA_FROM_NAME || "المحل";

    if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) {
      return res.status(500).json({ error: "إعدادات واتساب غير مكتملة في .env" });
    }

    // رسالة نصية (قد تعمل داخل 24 ساعة من آخر تفاعل مع العميل، وإلا قد تحتاج Template)
    const message = `السلام عليكم ${debt.customer_name}
تذكير: لديك دين مؤجل بقيمة متبقية ${debt.remaining_amount}.
${FROM_NAME}`;

    const url = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to: debt.customer_phone.replace("+", ""), // Cloud API غالبًا يتوقع رقم بدون +
      type: "text",
      text: { body: message }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(400).json({ error: "فشل إرسال واتساب", details: data });
    }

    const providerMessageId = data?.messages?.[0]?.id || null;

    db.prepare("INSERT INTO whatsapp_logs (customer_phone, debt_id, message, provider_message_id, status) VALUES (?,?,?,?,?)")
      .run(debt.customer_phone, debtId, message, providerMessageId, "SENT");

    res.json({ ok: true, provider_message_id: providerMessageId });
  } catch (e) {
    next(e);
  }
});

// --- Reports (from-to) ---
app.get("/api/reports/inputs", (req, res) => {
  const { from, to } = req.query;
  const rows = db.prepare(`
    SELECT sm.created_at, p.sku, p.name, sm.qty, sm.note
    FROM stock_movements sm
    JOIN products p ON p.id = sm.product_id
    WHERE sm.type='IN'
      AND datetime(sm.created_at) BETWEEN datetime(?) AND datetime(?)
    ORDER BY sm.created_at DESC
  `).all(from, to);
  res.json(rows);
});

app.get("/api/reports/sales", (req, res) => {
  const { from, to } = req.query;
  const rows = db.prepare(`
    SELECT invoice_no, created_at, payment_method, total, paid, customer_name, customer_phone
    FROM sales
    WHERE datetime(created_at) BETWEEN datetime(?) AND datetime(?)
    ORDER BY created_at DESC
  `).all(from, to);
  res.json(rows);
});

app.get("/api/reports/expenses", (req, res) => {
  const { from, to } = req.query;
  const rows = db.prepare(`
    SELECT created_at, category, amount, note
    FROM expenses
    WHERE datetime(created_at) BETWEEN datetime(?) AND datetime(?)
    ORDER BY created_at DESC
  `).all(from, to);
  res.json(rows);
});

app.get("/api/reports/stock", (req, res) => {
  // رصيد المخزون "حتى تاريخ"
  const { until } = req.query;
  const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();

  const inStmt = db.prepare(`
    SELECT COALESCE(SUM(qty),0) s FROM stock_movements
    WHERE product_id=? AND type='IN' AND datetime(created_at) <= datetime(?)
  `);
  const outStmt = db.prepare(`
    SELECT COALESCE(SUM(qty),0) s FROM stock_movements
    WHERE product_id=? AND type='OUT' AND datetime(created_at) <= datetime(?)
  `);

  const rows = products.map(p => {
    const inQty = Number(inStmt.get(p.id, until).s);
    const outQty = Number(outStmt.get(p.id, until).s);
    return { sku: p.sku, name: p.name, unit: p.unit, stock: inQty - outQty, min_stock: p.min_stock };
  });

  res.json(rows);
});

// --- Expenses create ---
app.post("/api/expenses", (req, res) => {
  const { category, amount, note, created_at } = req.body;
  if (!category || !amount) return res.status(400).json({ error: "category و amount مطلوبين" });
  db.prepare("INSERT INTO expenses (category, amount, note, created_at) VALUES (?,?,?,?)")
    .run(String(category), Number(amount), note || null, created_at || toISODateTime());
  res.json({ ok: true });
});

// --- error handler ---
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Server error" });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Server running: http://localhost:${port}`));
