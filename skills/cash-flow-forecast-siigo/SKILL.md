# cash-flow-forecast-siigo

Ejecuta el siguiente script Python con bash y muestra el output tal como sale. No lo modifiques.

```bash
python3 << 'PYEOF'
import os, json, urllib.request
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

today = date.today()
pending, overdue, paid_total = 0.0, 0.0, 0.0
paid_days, paid_count, unpaid_count = 0, 0, 0
aging = {"0–15 días": 0.0, "16–30 días": 0.0, "31–60 días": 0.0, "60+ días": 0.0}

for inv in invoices:
    total  = float(inv.get("total", 0))
    status = str(inv.get("status", "")).lower()
    raw_date = inv.get("date", inv.get("invoice_date", ""))[:10]
    try:
        inv_date = datetime.strptime(raw_date, "%Y-%m-%d").date()
    except:
        continue
    days_old = (today - inv_date).days
    is_paid  = any(x in status for x in ["pagado", "paid", "cancelado", "anulado"])

    if is_paid:
        paid_total += total
        paid_days  += days_old
        paid_count += 1
    else:
        unpaid_count += 1
        if days_old <= 15:
            pending += total
            aging["0–15 días"] += total
        elif days_old <= 30:
            pending += total
            aging["16–30 días"] += total
        elif days_old <= 60:
            overdue += total
            aging["31–60 días"] += total
        else:
            overdue += total
            aging["60+ días"] += total

total_outstanding = pending + overdue
dso = round(paid_days / paid_count) if paid_count > 0 else 0
daily_forecast = round(total_outstanding / 30) if total_outstanding > 0 else 0

print(f"## Cash Flow Forecast — Dogspital")
print(f"_Período: {START} → {END} | Generado: {today.isoformat()}_\n")

print("### Resumen de Cartera")
print("| Concepto | Monto (COP) |")
print("|---|---|")
print(f"| Cartera corriente (≤30 días) | ${pending:,.0f} |")
print(f"| Cartera vencida (>30 días) | ${overdue:,.0f} |")
print(f"| **Total outstanding** | **${total_outstanding:,.0f}** |")
print(f"| Recaudo estimado/día | ${daily_forecast:,.0f} |")
print(f"| DSO (días promedio cobro) | {dso} días |")
print()

print("### Aging de Cartera")
print("| Antigüedad | Monto (COP) | % |")
print("|---|---|---|")
for bucket, amount in aging.items():
    pct = amount / total_outstanding * 100 if total_outstanding > 0 else 0
    print(f"| {bucket} | ${amount:,.0f} | {pct:.1f}% |")
print()

print("### Estadísticas")
print(f"- Facturas pagadas: **{paid_count}** (${paid_total:,.0f} COP)")
print(f"- Facturas abiertas: **{unpaid_count}**")
print(f"- Total facturas analizadas: **{len(invoices)}**")
PYEOF
```
