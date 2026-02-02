// ===== Storage helpers =====
const KEY = "acc_static_v1";

function loadDB() {
  const raw = localStorage.getItem(KEY);
  if (raw) return JSON.parse(raw);

  const db = {
    currency: "OMR", // ريال عماني
    products: [],         // {id, sku, name, price, unit}
    stockIns: [],         // {id, productId, qty, date, note}
    sales: [],            // {id, date, paymentMethod, customerName, customerPhone, items:[{productId, qty, price}], total, paid}
    debts: [],            // {id, date, customerName, customerPhone, original, remaining, saleId, dueDate, status, currency}
    debtPayments: [],     // {id, debtId, amount, date}
    ultramsg: { instanceId: "", token: "" }
  };

  localStorage.setItem(KEY, JSON.stringify(db));
  return db;
}

function saveDB(db) {
  localStorage.setItem(KEY, JSON.stringify(db));
}

function uid() { return Date.now() + Math.floor(Math.random()*1000); }

function nowISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseDT(s) { return new Date(s.replace(" ", "T")); }

// تحقق بسيط للهاتف (اختياري)
// هنا فقط نتأكد ليس فارغ. لو تبغى إلزام +968 قل لي.
function validatePhone(phone){
  phone = (phone||"").trim();
  if(!phone) throw new Error("رقم الهاتف مطلوب");
  return phone;
}

// ===== Business logic =====
function getProduct(db, productId) {
  return db.products.find(p => p.id === productId);
}

function stockInSumUntil(db, productId, until = null) {
  return db.stockIns
    .filter(m => m.productId === productId && (!until || parseDT(m.date) <= parseDT(until)))
    .reduce((s,m)=>s+Number(m.qty),0);
}

function soldSumUntil(db, productId, until = null) {
  let sum = 0;
  for (const s of db.sales) {
    if (until && parseDT(s.date) > parseDT(until)) continue;
    for (const it of s.items) {
      if (it.productId === productId) sum += Number(it.qty);
    }
  }
  return sum;
}

export function getStockNow(db, productId) {
  return stockInSumUntil(db, productId) - soldSumUntil(db, productId);
}

export function findProducts(db, q) {
  const t = (q||"").trim().toLowerCase();
  if (!t) return db.products;
  return db.products.filter(p =>
    p.sku.toLowerCase().includes(t) || p.name.toLowerCase().includes(t)
  );
}

export function addProduct(db, {sku,name,price,unit}) {
  sku = String(sku||"").trim();
  name = String(name||"").trim();
  if (!sku || !name) throw new Error("رقم الصنف والاسم مطلوبين");
  if (db.products.some(p => p.sku === sku)) throw new Error("رقم الصنف موجود مسبقًا");
  const p = { id: uid(), sku, name, price: Number(price||0), unit: unit||"حبة" };
  db.products.unshift(p);
  saveDB(db);
  return p;
}

export function addStockIn(db, {productId, qty, date, note}) {
  if (!productId) throw new Error("اختر الصنف");
  qty = Number(qty);
  if (!(qty>0)) throw new Error("الكمية غير صحيحة");
  const m = { id: uid(), productId, qty, date: date||nowISO(), note: note||"" };
  db.stockIns.unshift(m);
  saveDB(db);
  return m;
}

export function createSale(db, {items, paymentMethod, paid, customerName, customerPhone, dueDate}) {
  if (!items?.length) throw new Error("السلة فارغة");
  if (!["cash","bank","deferred"].includes(paymentMethod)) throw new Error("طريقة دفع غير صحيحة");

  // prices ثابتة من المنتج
  const normalized = items.map(it => {
    const p = getProduct(db, it.productId);
    if (!p) throw new Error("صنف غير موجود");
    const qty = Number(it.qty);
    if (!(qty>0)) throw new Error("كمية غير صحيحة");
    const stock = getStockNow(db, p.id);
    if (qty > stock) throw new Error(`المخزون لا يكفي للصنف ${p.name} (المتوفر ${stock})`);
    return { productId: p.id, qty, price: Number(p.price) };
  });

  const total = normalized.reduce((s,it)=>s + it.qty*it.price, 0);
  paid = Number(paid||0);

  if (paymentMethod === "deferred") {
    customerName = (customerName||"").trim();
    customerPhone = validatePhone(customerPhone);
    if (!customerName) throw new Error("اسم العميل مطلوب للدين المؤجل");
  }

  const sale = {
    id: uid(),
    date: nowISO(),
    paymentMethod,
    customerName: customerName||"",
    customerPhone: customerPhone||"",
    items: normalized,
    total,
    paid
  };
  db.sales.unshift(sale);

  // create debt if deferred
  if (paymentMethod === "deferred") {
    const remaining = Math.max(0, total - paid);
    const status = remaining === 0 ? "PAID" : (paid>0 ? "PARTIAL" : "OPEN");
    const debt = {
      id: uid(),
      date: sale.date,
      customerName,
      customerPhone,
      original: total,
      remaining,
      saleId: sale.id,
      dueDate: dueDate || "",
      status,
      currency: db.currency || "OMR"
    };
    db.debts.unshift(debt);
  }

  saveDB(db);
  return sale;
}

// ✅ إنشاء دين يدوي (الحقول المطلوبة)
export function createManualDebt(db, { customerName, customerPhone, amount, dueDate }) {
  customerName = (customerName || "").trim();
  customerPhone = validatePhone(customerPhone);
  amount = Number(amount);

  if (!customerName) throw new Error("اسم الشخص مطلوب");
  if (!(amount > 0)) throw new Error("قيمة الدين غير صحيحة");

  const debt = {
    id: uid(),
    date: nowISO(),
    customerName,
    customerPhone,
    original: amount,
    remaining: amount,
    saleId: null,
    dueDate: dueDate || "",
    status: "OPEN",
    currency: db.currency || "OMR"
  };

  db.debts.unshift(debt);
  saveDB(db);
  return debt;
}

export function payDebt(db, {debtId, amount}) {
  const d = db.debts.find(x=>x.id===debtId);
  if (!d) throw new Error("الدين غير موجود");
  amount = Number(amount);
  if (!(amount>0)) throw new Error("المبلغ غير صحيح");

  const pay = { id: uid(), debtId, amount, date: nowISO() };
  db.debtPayments.unshift(pay);

  d.remaining = Math.max(0, Number(d.remaining) - amount);
  d.status = d.remaining === 0 ? "PAID" : "PARTIAL";

  saveDB(db);
  return d;
}

// ===== Reports =====
export function betweenDates(rowDate, from, to) {
  const d = parseDT(rowDate);
  return d >= parseDT(from) && d <= parseDT(to);
}

export function reportSales(db, from, to) {
  return db.sales.filter(s => betweenDates(s.date, from, to));
}

export function reportDebts(db, from, to) {
  return db.debts.filter(d => betweenDates(d.date, from, to));
}

// stock snapshot "حتى تاريخ"
export function reportStockUntil(db, until) {
  return db.products.map(p => {
    const inSum = stockInSumUntil(db, p.id, until);
    const outSum = soldSumUntil(db, p.id, until);
    return { sku: p.sku, name: p.name, unit: p.unit, stock: inSum - outSum };
  });
}

// ===== UltraMsg =====
// Endpoint: https://api.ultramsg.com/{{instance_id}}/messages/chat
// Fields: token,to,body
export async function ultramsgSendChat(db, {to, body}) {
  const { instanceId, token } = db.ultramsg || {};
  if (!instanceId || !token) throw new Error("أدخل instanceId و token في إعدادات UltraMsg أولاً");
  if (!to || !body) throw new Error("رقم الهاتف والرسالة مطلوبة");

  const url = `https://api.ultramsg.com/${encodeURIComponent(instanceId)}/messages/chat`;

  // غالباً form-urlencoded
  const form = new URLSearchParams();
  form.set("token", token);
  form.set("to", to);
  form.set("body", body);

  // ⚠️ قد تواجه CORS في المتصفح لأنك تعمل HTML فقط
  const r = await fetch(url, { method: "POST", body: form });
  const data = await r.json().catch(()=> ({}));
  if (!r.ok) throw new Error(data?.error || "فشل إرسال الرسالة (قد تكون مشكلة CORS أو بيانات UltraMsg)");
  return data;
}

export function getDB(){ return loadDB(); }
export function setUltraMsg(db, instanceId, token){
  db.ultramsg = { instanceId: (instanceId||"").trim(), token: (token||"").trim() };
  saveDB(db);
}
