# financial-snapshot-siigo

Ejecuta el siguiente script Python con bash y muestra el output tal como sale. No lo modifiques.

```bash
python3 << 'PYEOF'
import os, json, urllib.request, urllib.error
from datetime import date, datetime

username   = os.environ.get("SIIGO_USERNAME", "")
access_key = os.environ.get("SIIGO_ACCESS_KEY", "")
partner_id = os.environ.get("SIIGO_PARTNER_ID", "ClaudeAgent")

if not username or not access_key:
    print("ERROR: Faltan SIIGO_USERNAME o SIIGO_ACCESS_KEY en el environment.")
    exit(1)

def siigo_post(url, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def siigo_get(url, token):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Partner-Id": partner_id,
        "Content-Type": "application/json"
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def sum_paid(invoices):
    total = 0
    count = 0
    for inv in invoices:
        st = str(inv.get("status", "")).lower()
        if any(x in st for x in ["activo", "active", "paid", "pagado", "emitida"]):
            total += float(inv.get("total", 0))
            count += 1
    return total, count

try:
    auth = siigo_post("https://api.siigo.com/auth", {"username": username, "access_key": access_key})
    token = auth["access_token"]
except Exception as e:
    print(f"ERROR autenticando con Siigo: {e}")
    exit(1)

today = date.today()
month_start = today.replace(day=1).isoformat()
year_start  = today.replace(month=1, day=1).isoformat()
today_str   = today.isoformat()

if today.month == 1:
    lm_start = today.replace(year=today.year-1, month=12, day=1).isoformat()
    lm_end   = today.replace(year=today.year-1, month=12, day=31).isoformat()
else:
    import calendar
    lm_start = today.replace(month=today.month-1, day=1).isoformat()
    lm_last  = calendar.monthrange(today.year, today.month-1)[1]
    lm_end   = today.replace(month=today.month-1, day=lm_last).isoformat()

def fetch_invoices(start, end):
    url = f"https://api.siigo.com/v1/invoices?start_date={start}&end_date={end}&page_size=100"
    try:
        resp = siigo_get(url, token)
        return resp.get("results", resp.get("data", []))
    except Exception as e:
        print(f"  (advertencia: {e})")
        return []

mtd_inv  = fetch_invoices(month_start, today_str)
ytd_inv  = fetch_invoices(year_start, today_str)
lm_inv   = fetch_invoices(lm_start, lm_end)

mtd_rev, mtd_n = sum_paid(mtd_inv)
ytd_rev, ytd_n = sum_paid(ytd_inv)
lm_rev,  lm_n  = sum_paid(lm_inv)

growth = round((mtd_rev - lm_rev) / lm_rev * 100, 1) if lm_rev > 0 else 0
growth_sign = "+" if growth >= 0 else ""

print("## Snapshot Financiero — Dogspital")
print(f"_Generado: {today_str}_\n")
print("| Métrica | Valor | Facturas |")
print("|---|---|---|")
print(f"| **MTD Ingresos** | ${mtd_rev:,.0f} COP | {mtd_n} |")
print(f"| **YTD Ingresos** | ${ytd_rev:,.0f} COP | {ytd_n} |")
print(f"| Mes anterior | ${lm_rev:,.0f} COP | {lm_n} |")
print(f"| **Crecimiento MTD** | {growth_sign}{growth}% | — |")
print()

if mtd_inv:
    print("### Top facturas del mes")
    print("| Fecha | Cliente | Total |")
    print("|---|---|---|")
    sorted_inv = sorted(mtd_inv, key=lambda x: float(x.get("total",0)), reverse=True)[:5]
    for inv in sorted_inv:
        cliente = inv.get("customer", {}).get("name", inv.get("customer_name", "—"))
        fecha   = inv.get("date", inv.get("invoice_date", "—"))[:10]
        total   = float(inv.get("total", 0))
        print(f"| {fecha} | {cliente} | ${total:,.0f} |")
PYEOF
```
