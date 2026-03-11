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

/* ------------------ DB INIT ------------------ */

db.exec(`

PRAGMA foreign_keys = ON;

/* المنتجات */
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sale_price REAL NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'حبة',
  min_stock REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* حركة المخزون */
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IN','OUT')),
  qty REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

/* المبيعات */
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT UNIQUE NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  payment_method TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* عناصر الفاتورة */
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
);

/* المصاريف */
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ------------------ البيع اليومي الجديد ------------------ */

CREATE TABLE IF NOT EXISTS daily_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  phone TEXT,
  product_name TEXT,
  qty_received REAL DEFAULT 0,
  qty_sold REAL DEFAULT 0,
  remaining REAL DEFAULT 0,
  total REAL DEFAULT 0,
  percentage REAL DEFAULT 0,
  profit REAL DEFAULT 0,
  sale_date TEXT
);

`);

/* ------------------ Helpers ------------------ */

function toISODateTime(d = new Date()) {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function getStock(productId) {
  const inQty = db.prepare(
    "SELECT COALESCE(SUM(qty),0) s FROM stock_movements WHERE product_id=? AND type='IN'"
  ).get(productId).s;

  const outQty = db.prepare(
    "SELECT COALESCE(SUM(qty),0) s FROM stock_movements WHERE product_id=? AND type='OUT'"
  ).get(productId).s;

  return Number(inQty) - Number(outQty);
}

/* ------------------ Products ------------------ */

app.post("/api/products",(req,res)=>{

const {sku,name,sale_price=0,unit="حبة"}=req.body;

const info=db.prepare(`
INSERT INTO products
(sku,name,sale_price,unit)
VALUES(?,?,?,?)
`).run(sku,name,sale_price,unit)

res.json({id:info.lastInsertRowid})

})

app.get("/api/products",(req,res)=>{

const rows=db.prepare(`
SELECT * FROM products
ORDER BY id DESC
`).all()

const data=rows.map(r=>({
...r,
stock:getStock(r.id)
}))

res.json(data)

})

/* ------------------ Stock IN ------------------ */

app.post("/api/stock/in",(req,res)=>{

const {product_id,qty,note}=req.body

db.prepare(`
INSERT INTO stock_movements
(product_id,type,qty,note)
VALUES(?,?,?,?)
`).run(product_id,"IN",qty,note)

res.json({ok:true})

})

/* ------------------ البيع اليومي ------------------ */

/* إضافة بيع يومي */

app.post("/api/daily-sales",(req,res)=>{

const {
name,
phone,
product_name,
qty_received=0,
qty_sold=0,
percentage=0
}=req.body

const received=Number(qty_received)
const sold=Number(qty_sold)

const remaining=received-sold
const total=sold
const profit=total*(percentage/100)

db.prepare(`
INSERT INTO daily_sales
(name,phone,product_name,qty_received,qty_sold,remaining,total,percentage,profit,sale_date)
VALUES(?,?,?,?,?,?,?,?,?,?)
`).run(
name,
phone,
product_name,
received,
sold,
remaining,
total,
percentage,
profit,
toISODateTime()
)

res.json({ok:true})

})

/* جدول البيع اليومي */

app.get("/api/daily-sales",(req,res)=>{

const rows=db.prepare(`
SELECT * FROM daily_sales
ORDER BY sale_date DESC
`).all()

res.json(rows)

})

/* مجموع البيع */

app.get("/api/daily-sales-summary",(req,res)=>{

const row=db.prepare(`
SELECT
SUM(total) as total_sales,
SUM(profit) as total_profit,
SUM(remaining) as remaining_stock
FROM daily_sales
`).get()

res.json(row)

})

/* المتبقي من الأصناف */

app.get("/api/daily-sales-remaining",(req,res)=>{

const rows=db.prepare(`
SELECT
product_name,
SUM(remaining) as remaining
FROM daily_sales
GROUP BY product_name
`).all()

res.json(rows)

})

/* ------------------ Expenses ------------------ */

app.post("/api/expenses",(req,res)=>{

const {category,amount,note}=req.body

db.prepare(`
INSERT INTO expenses
(category,amount,note,created_at)
VALUES(?,?,?,?)
`).run(category,amount,note,toISODateTime())

res.json({ok:true})

})

/* ------------------ Server ------------------ */

const port = Number(process.env.PORT || 3000);

app.listen(port, () => {
console.log("Server running http://localhost:"+port)
});