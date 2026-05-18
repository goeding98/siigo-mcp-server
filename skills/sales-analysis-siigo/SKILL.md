# sales-analysis-siigo

Analiza ingresos por tipo de servicio veterinario desde Siigo API (marzo–mayo 2026).

## Instrucciones

### 1. Autenticar con Siigo

```bash
SIIGO_TOKEN=$(curl -s -X POST "https://api.siigo.com/auth" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"${SIIGO_USERNAME}\", \"access_key\": \"${SIIGO_ACCESS_KEY}\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
```

### 2. Obtener facturas del período (marzo–mayo 2026)

```bash
INVOICES=$(curl -s "https://api.siigo.com/v1/invoices?start_date=2026-03-01&end_date=2026-05-31&page_size=100" \
  -H "Authorization: Bearer ${SIIGO_TOKEN}" \
  -H "Partner-Id: ${SIIGO_PARTNER_ID:-ClaudeAgent}" \
  -H "Content-Type: application/json")
```

### 3. Obtener productos/servicios del catálogo

```bash
PRODUCTS=$(curl -s "https://api.siigo.com/v1/products?page_size=200" \
  -H "Authorization: Bearer ${SIIGO_TOKEN}" \
  -H "Partner-Id: ${SIIGO_PARTNER_ID:-ClaudeAgent}" \
  -H "Content-Type: application/json")
```

### 4. Agrupar ingresos por categoría de servicio

```bash
python3 << 'EOF'
import json

SERVICE_MAP = {
    'peluqueria': 'Estética / Grooming',
    'grooming': 'Estética / Grooming',
    'consulta': 'Consulta Veterinaria',
    'cirugia': 'Cirugía',
    'cirug': 'Cirugía',
    'vacuna': 'Vacunas',
    'desparasit': 'Desparasitación',
    'laparotomia': 'Cirugía Mayor',
    'esteriliz': 'Esterilización',
    'castraci': 'Castración',
    'limpieza': 'Limpieza Dental',
    'radiograf': 'Imagenología',
    'laboratorio': 'Laboratorio',
    'ecograf': 'Imagenología',
    'hospitali': 'Hospitalización',
}

def categorize(text):
    t = (text or '').lower()
    for key, cat in SERVICE_MAP.items():
        if key in t:
            return cat
    return 'Otros Servicios'

import subprocess
invoices_raw = subprocess.getoutput('echo "$INVOICES"')

try:
    data = json.loads(invoices_raw)
    items = data.get('results', data.get('data', []))

    revenue_by_service = {}
    for invoice in items:
        if invoice.get('status') not in ('Activo', 'PAID', 'Pagado', 'Active'):
            continue
        for item in invoice.get('items', []):
            desc = item.get('description', item.get('name', ''))
            ref = item.get('code', item.get('reference', ''))
            cat = categorize(ref or desc)
            qty = float(item.get('quantity', 1))
            price = float(item.get('unit_value', item.get('price', 0)))
            total = qty * price

            if cat not in revenue_by_service:
                revenue_by_service[cat] = {'revenue': 0, 'count': 0}
            revenue_by_service[cat]['revenue'] += total
            revenue_by_service[cat]['count'] += int(qty)

    sorted_services = sorted(revenue_by_service.items(), key=lambda x: x[1]['revenue'], reverse=True)
    grand_total = sum(v['revenue'] for _, v in sorted_services)

    print("=" * 60)
    print("  ANÁLISIS DE VENTAS POR SERVICIO  |  Mar–May 2026")
    print("=" * 60)
    print(f"  {'Servicio':<28} {'Ingresos':>14} {'%':>6} {'Unid':>6}")
    print("-" * 60)
    for service, vals in sorted_services:
        pct = (vals['revenue'] / grand_total * 100) if grand_total > 0 else 0
        print(f"  {service:<28} ${vals['revenue']:>12,.0f} {pct:>5.1f}% {vals['count']:>5}")
    print("-" * 60)
    print(f"  {'TOTAL':<28} ${grand_total:>12,.0f}")
    print("=" * 60)
except Exception as e:
    print(f"Error: {e}")
    print("Raw:", invoices_raw[:300])
EOF
```

## Variables de entorno requeridas

- `SIIGO_USERNAME`
- `SIIGO_ACCESS_KEY`
- `SIIGO_PARTNER_ID` (default: ClaudeAgent)

## Período analizado

- Fijo: 2026-03-01 → 2026-05-31
- Agrupa por 13 categorías de servicio veterinario
