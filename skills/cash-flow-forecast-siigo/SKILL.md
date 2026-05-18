# cash-flow-forecast-siigo

Analiza flujo de caja: cartera pendiente, vencida y DSO (Days Sales Outstanding) desde Siigo API.

## Instrucciones

### 1. Autenticar con Siigo

```bash
SIIGO_TOKEN=$(curl -s -X POST "https://api.siigo.com/auth" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"${SIIGO_USERNAME}\", \"access_key\": \"${SIIGO_ACCESS_KEY}\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
```

### 2. Obtener facturas de los últimos 90 días

```bash
START_DATE="2026-03-01"
END_DATE="2026-05-31"

INVOICES=$(curl -s "https://api.siigo.com/v1/invoices?start_date=${START_DATE}&end_date=${END_DATE}&page_size=100" \
  -H "Authorization: Bearer ${SIIGO_TOKEN}" \
  -H "Partner-Id: ${SIIGO_PARTNER_ID:-ClaudeAgent}" \
  -H "Content-Type: application/json")
```

### 3. Calcular métricas de cartera

```bash
python3 << 'EOF'
import json
from datetime import datetime, date

import subprocess
invoices_raw = subprocess.getoutput('echo "$INVOICES"')

try:
    data = json.loads(invoices_raw)
    items = data.get('results', data.get('data', []))
    today = date.today()

    pending = 0       # No pagadas, dentro del plazo
    overdue = 0       # No pagadas, vencidas (>30 días)
    paid_total = 0
    paid_days_sum = 0
    paid_count = 0
    unpaid_count = 0

    aging = {'0-15 días': 0, '16-30 días': 0, '31-60 días': 0, '60+ días': 0}

    for inv in items:
        total = float(inv.get('total', 0))
        inv_date_str = inv.get('date', inv.get('invoice_date', ''))
        status = inv.get('status', '')

        try:
            inv_date = datetime.strptime(inv_date_str[:10], '%Y-%m-%d').date()
        except:
            continue

        days_old = (today - inv_date).days
        is_paid = status in ('Pagado', 'PAID', 'Paid')

        if is_paid:
            paid_total += total
            paid_days_sum += days_old
            paid_count += 1
        else:
            unpaid_count += 1
            if days_old <= 30:
                pending += total
                if days_old <= 15:
                    aging['0-15 días'] += total
                else:
                    aging['16-30 días'] += total
            elif days_old <= 60:
                overdue += total
                aging['31-60 días'] += total
            else:
                overdue += total
                aging['60+ días'] += total

    dso = round(paid_days_sum / paid_count) if paid_count > 0 else 0
    total_outstanding = pending + overdue
    expected_30d = round(total_outstanding / 30) if total_outstanding > 0 else 0

    print("=" * 55)
    print("  CASH FLOW FORECAST  |  Mar–May 2026")
    print("=" * 55)
    print(f"  Cartera pendiente (≤30d):  ${pending:>12,.0f} COP")
    print(f"  Cartera vencida  (>30d):   ${overdue:>12,.0f} COP")
    print(f"  Total outstanding:         ${total_outstanding:>12,.0f} COP")
    print(f"  Recaudo estimado /día:     ${expected_30d:>12,.0f} COP")
    print(f"  DSO (días promedio cobro): {dso:>3} días")
    print()
    print("  AGING DE CARTERA")
    print("-" * 55)
    for bucket, amount in aging.items():
        bar = '█' * min(int(amount / max(total_outstanding, 1) * 30), 30)
        print(f"  {bucket:<15} ${amount:>12,.0f}  {bar}")
    print()
    print(f"  Facturas pagadas:  {paid_count}")
    print(f"  Facturas abiertas: {unpaid_count}")
    print("=" * 55)

except Exception as e:
    print(f"Error: {e}")
    print("Raw:", invoices_raw[:300])
EOF
```

## Variables de entorno requeridas

- `SIIGO_USERNAME`
- `SIIGO_ACCESS_KEY`
- `SIIGO_PARTNER_ID` (default: ClaudeAgent)

## Métricas calculadas

- **Pending**: facturas sin pagar con ≤30 días de antigüedad
- **Overdue**: facturas sin pagar con >30 días de antigüedad
- **DSO**: promedio de días entre emisión y pago (facturas pagadas)
- **Aging**: distribución de cartera en 4 buckets temporales
- **Recaudo estimado**: proyección diaria basada en outstanding total
