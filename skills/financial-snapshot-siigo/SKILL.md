# financial-snapshot-siigo

Obtén el snapshot financiero MTD/YTD de Siigo API con ingresos, margen y crecimiento.

## Instrucciones

Ejecuta los siguientes pasos en orden:

### 1. Autenticar con Siigo

```bash
SIIGO_TOKEN=$(curl -s -X POST "https://api.siigo.com/auth" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"${SIIGO_USERNAME}\", \"access_key\": \"${SIIGO_ACCESS_KEY}\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
echo "Token obtenido: ${SIIGO_TOKEN:0:20}..."
```

### 2. Obtener facturas del mes actual (MTD)

```bash
MONTH_START=$(date +%Y-%m-01)
TODAY=$(date +%Y-%m-%d)

MTD_INVOICES=$(curl -s "https://api.siigo.com/v1/invoices?start_date=${MONTH_START}&end_date=${TODAY}&page_size=100" \
  -H "Authorization: Bearer ${SIIGO_TOKEN}" \
  -H "Partner-Id: ${SIIGO_PARTNER_ID:-ClaudeAgent}" \
  -H "Content-Type: application/json")
```

### 3. Obtener facturas del año (YTD)

```bash
YEAR_START=$(date +%Y-01-01)

YTD_INVOICES=$(curl -s "https://api.siigo.com/v1/invoices?start_date=${YEAR_START}&end_date=${TODAY}&page_size=100" \
  -H "Authorization: Bearer ${SIIGO_TOKEN}" \
  -H "Partner-Id: ${SIIGO_PARTNER_ID:-ClaudeAgent}" \
  -H "Content-Type: application/json")
```

### 4. Obtener facturas del mes anterior (para crecimiento)

```bash
LAST_MONTH_START=$(date -d "$(date +%Y-%m-01) -1 month" +%Y-%m-%d 2>/dev/null || date -v-1m +%Y-%m-01)
LAST_MONTH_END=$(date -d "$(date +%Y-%m-01) -1 day" +%Y-%m-%d 2>/dev/null || date -v-1d -v"$(date +%m)"m +%Y-%m-%d)

LAST_MONTH_INVOICES=$(curl -s "https://api.siigo.com/v1/invoices?start_date=${LAST_MONTH_START}&end_date=${LAST_MONTH_END}&page_size=100" \
  -H "Authorization: Bearer ${SIIGO_TOKEN}" \
  -H "Partner-Id: ${SIIGO_PARTNER_ID:-ClaudeAgent}" \
  -H "Content-Type: application/json")
```

### 5. Calcular y mostrar métricas

Procesa los datos con Python para calcular:

```bash
python3 << 'EOF'
import json, os, sys

def sum_invoices(data):
    invoices = json.loads(data) if isinstance(data, str) else data
    items = invoices.get('results', invoices.get('data', []))
    paid = [i for i in items if i.get('status') in ('Activo', 'PAID', 'Pagado', 'Active')]
    return sum(float(i.get('total', 0)) for i in paid), len(paid)

import subprocess

mtd_raw = subprocess.getoutput('echo "$MTD_INVOICES"')
ytd_raw = subprocess.getoutput('echo "$YTD_INVOICES"')
lm_raw = subprocess.getoutput('echo "$LAST_MONTH_INVOICES"')

try:
    mtd_rev, mtd_count = sum_invoices(mtd_raw)
    ytd_rev, ytd_count = sum_invoices(ytd_raw)
    lm_rev, lm_count = sum_invoices(lm_raw)

    growth = round(((mtd_rev - lm_rev) / lm_rev * 100), 1) if lm_rev > 0 else 0

    print("=" * 50)
    print("  SNAPSHOT FINANCIERO - Dogspital")
    print("=" * 50)
    print(f"  MTD Ingresos:     ${mtd_rev:>12,.0f} COP  ({mtd_count} facturas)")
    print(f"  YTD Ingresos:     ${ytd_rev:>12,.0f} COP  ({ytd_count} facturas)")
    print(f"  Mes anterior:     ${lm_rev:>12,.0f} COP  ({lm_count} facturas)")
    print(f"  Crecimiento MTD:  {growth:>+.1f}%")
    print("=" * 50)
except Exception as e:
    print(f"Error procesando datos: {e}")
    print("MTD raw:", mtd_raw[:200])
EOF
```

## Variables de entorno requeridas

- `SIIGO_USERNAME` — Usuario API de Siigo (ej: gerencia@dogspital.com)
- `SIIGO_ACCESS_KEY` — Access key de Siigo
- `SIIGO_PARTNER_ID` — Partner-ID de la app (default: ClaudeAgent)

## Rango de fechas por defecto

- MTD: Primer día del mes actual → hoy
- YTD: 1 enero del año actual → hoy
- Crecimiento: comparado con el mes anterior completo
