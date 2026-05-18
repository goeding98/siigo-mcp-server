# sales-analysis-siigo

Ejecuta el siguiente script Python con bash y muestra el output tal como sale. No lo modifiques.

```bash
python3 << 'PYEOF'
import os, json, urllib.request
from datetime import date

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

SERVICE_MAP = {
    "peluqueria": "Estética / Grooming",
    "grooming":   "Estética / Grooming",
    "bath":       "Estética / Grooming",
    "consulta":   "Consulta Veterinaria",
    "revision":   "Consulta Veterinaria",
    "cirugia":    "Cirugía",
    "cirug":      "Cirugía",
    "vacuna":     "Vacunas",
    "desparasit": "Desparasitación",
    "laparotom":  "Cirugía Mayor",
    "esteriliz":  "Esterilización",
    "castrac":    "Castración",
    "limpieza":   "Limpieza Dental",
    "dental":     "Limpieza Dental",
    "radiograf":  "Imagenología",
    "ecograf":    "Imagenología",
    "laborator":  "Laboratorio",
    "hospitali":  "Hospitalización",
    "pension":    "Hospedaje / Pensión",
}

def categorize(text):
    t = (text or "").lower()
    for key, cat in SERVICE_MAP.items():
        if key in t:
            return cat
    return "Otros Servicios"

try:
    auth  = siigo_post("https://api.siigo.com/auth", {"username": username, "access_key": access_key})
    token = auth["access_token"]
except Exception as e:
    print(f"ERROR autenticando: {e}")
    exit(1)

START, END = "2026-03-01", "2026-05-31"
url = f"https://api.siigo.com/v1/invoices?start_date={START}&end_date={END}&page_size=100"

try:
    resp     = siigo_get(url, token)
    invoices = resp.get("results", resp.get("data", []))
except Exception as e:
    print(f"ERROR llamando a Siigo: {e}")
    exit(1)

revenue = {}
for inv in invoices:
    st = str(inv.get("status", "")).lower()
    if not any(x in st for x in ["activo", "active", "paid", "pagado", "emitida"]):
        continue
    for item in inv.get("items", []):
        desc  = item.get("description", item.get("name", ""))
        code  = item.get("code", item.get("reference", ""))
        cat   = categorize(code or desc)
        qty   = float(item.get("quantity", 1))
        price = float(item.get("unit_value", item.get("price", item.get("unit_price", 0))))
        total = qty * price
        if cat not in revenue:
            revenue[cat] = {"revenue": 0.0, "units": 0}
        revenue[cat]["revenue"] += total
        revenue[cat]["units"]   += int(qty)

if not revenue:
    print(f"Sin facturas con ítems en {START} → {END}.")
    print("Mostrando resumen por factura:")
    for inv in invoices[:10]:
        cliente = inv.get("customer", {}).get("name", "—")
        total   = float(inv.get("total", 0))
        fecha   = inv.get("date", "")[:10]
        print(f"  {fecha} | {cliente} | ${total:,.0f}")
    exit(0)

sorted_rev  = sorted(revenue.items(), key=lambda x: x[1]["revenue"], reverse=True)
grand_total = sum(v["revenue"] for _, v in sorted_rev)

print(f"## Análisis de Ventas por Servicio")
print(f"_Período: {START} → {END}_\n")
print("| # | Servicio | Ingresos (COP) | % del total | Unidades |")
print("|---|---|---|---|---|")
for i, (svc, vals) in enumerate(sorted_rev, 1):
    pct = vals["revenue"] / grand_total * 100 if grand_total > 0 else 0
    print(f"| {i} | {svc} | ${vals['revenue']:,.0f} | {pct:.1f}% | {vals['units']} |")
print(f"\n**Total período: ${grand_total:,.0f} COP** ({len(invoices)} facturas)")
PYEOF
```
