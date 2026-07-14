// netlify/functions/shipping-rate.js
//
// Cotiza envío real usando la API de Envia.com (multi-paquetería).
// El ENVIA_TOKEN nunca va en el frontend: se lee de una variable de entorno
// configurada en Netlify (Site settings → Environment variables).
//
// Frontend llama a: POST /.netlify/functions/shipping-rate
// Body: { "postalCode": "55075", "cart": { "pilates": 2, "pack4": 1 } }
//
// Respuesta: { ok: true, cost, carrier, service, deliveryEstimate }
//         o: { ok: false, error }  → el frontend debe hacer fallback al estimado fijo por zona.

const ENVIA_BASE = process.env.ENVIA_ENV === 'test'
  ? 'https://api-test.envia.com'
  : 'https://api.envia.com';

// ─────────────────────────────────────────────────────────────
// Códigos postales de zona cercana (Satélite / Naucalpan / Atizapán) con
// tarifa de envío fija, sin consultar Postali ni Envia.
// ─────────────────────────────────────────────────────────────
const FIXED_RATE_POSTAL_CODES = new Set([
  '53100', // Ciudad Satélite / Circuito Médicos / Zona Azul / Zona Comercial
  '53140', // Boulevares
  '53150', // La Alteña
  '53300', // Parque de la Ciudadela / Los Remedios
  '53120', // Jardines de Satélite
  '53125', // Lomas Verdes 4a. Sección
  '53126', // Lomas Verdes
  '52930', // Bosque de Esmeralda, Club de Golf Chiluca, Hacienda de Valle Esmeralda, Lomas de Esmeralda, Rancho Blanco, Residencial Chiluca, Villas de la Hacienda
  '52937', // Club de Golf Valle Escondido, Prado Largo, Valle Escondido
  '52938', // Condado de Sayavedra, Fincas de Sayavedra
  '52990', // Calacoaya
  '52977'  // Lomas de Atizapán
]);
const FIXED_RATE_COST = 45;

// ─────────────────────────────────────────────────────────────
// TODO (Mafer): reemplaza estos datos con la dirección real desde
// donde se envían los pedidos de Marea. Son necesarios para cotizar.
// ─────────────────────────────────────────────────────────────
const ORIGIN = {
  name: 'Mafer — Marea Grip Socks',
  company: 'Marea',
  phone: '+52 5621385605',
  email: 'hola@marea.mx',        // TODO: confirmar correo real si es distinto
  street: 'Querétaro 58, Residencial Calacoaya, Lote 3',
  city: 'Atizapán de Zaragoza',
  state: 'MEX',                  // Estado de México
  country: 'MX',
  postalCode: '52990'
};

// Perfiles de paquete — igual que PACKAGE_SPECS en el frontend
const PACKAGE_SPECS = {
  1: { weight: 0.15, length: 20, width: 12, height: 4 },
  2: { weight: 0.30, length: 20, width: 12, height: 6 },
  3: { weight: 0.45, length: 20, width: 12, height: 8 },
  pack4: { weight: 0.60, length: 20, width: 18, height: 8 }
};

// Paqueterías a comparar — se descubren dinámicamente desde tu cuenta de Envia (ver getActiveCarriers).
// Este respaldo solo se usa si esa consulta llega a fallar.
const FALLBACK_CARRIERS = ['estafeta', 'fedex', 'dhl', 'ups', 'paquetexpress', 'ampm', 'afimex'];

async function getActiveCarriers(token) {
  try {
    const res = await fetch('https://queries.envia.com/carrier?country_code=MX', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      console.error('[shipping-rate] No se pudo obtener lista de paqueterías, status:', res.status);
      return FALLBACK_CARRIERS;
    }
    const data = await res.json();
    const active = (data.data || []).filter((c) => c.active).map((c) => c.name);
    if (active.length === 0) {
      console.error('[shipping-rate] La cuenta no devolvió paqueterías activas, usando respaldo');
      return FALLBACK_CARRIERS;
    }
    console.log('[shipping-rate] Paqueterías activas encontradas:', active);
    return active;
  } catch (err) {
    console.error('[shipping-rate] Error consultando paqueterías activas:', err.message);
    return FALLBACK_CARRIERS;
  }
}

// Mapeo de nombre de estado (como lo devuelve la API de códigos postales) a código de 2-3 letras que pide Envia.
const MX_STATE_CODES = {
  'Aguascalientes': 'AG', 'Baja California': 'BC', 'Baja California Sur': 'BS',
  'Campeche': 'CM', 'Chiapas': 'CS', 'Chihuahua': 'CH', 'Ciudad de México': 'CX',
  'Coahuila': 'CO', 'Colima': 'CL', 'Durango': 'DG', 'Guanajuato': 'GT',
  'Guerrero': 'GR', 'Hidalgo': 'HG', 'Jalisco': 'JA', 'México': 'MEX',
  'Michoacán': 'MI', 'Morelos': 'MO', 'Nayarit': 'NA', 'Nuevo León': 'NL',
  'Oaxaca': 'OA', 'Puebla': 'PU', 'Querétaro': 'QA', 'Quintana Roo': 'QR',
  'San Luis Potosí': 'SL', 'Sinaloa': 'SI', 'Sonora': 'SO', 'Tabasco': 'TB',
  'Tamaulipas': 'TM', 'Tlaxcala': 'TL', 'Veracruz': 'VE', 'Yucatán': 'YU', 'Zacatecas': 'ZA'
};

async function resolveLocation(postalCode) {
  try {
    const res = await fetch(`https://postali.app/api/v1/mx/cp/${postalCode}`);
    if (!res.ok) return null;
    const data = await res.json();
    return { estado: data.estado, municipio: data.municipio, stateCode: MX_STATE_CODES[data.estado] || 'CX' };
  } catch {
    return null;
  }
}

function buildPackages(cart) {
  const packages = [];
  const pack4Qty = cart.pack4 || 0;
  const individualQty = Object.entries(cart)
    .filter(([id]) => id !== 'pack4')
    .reduce((sum, [, qty]) => sum + qty, 0);

  if (individualQty > 0) {
    // Usa el perfil de caja según cuántos pares individuales van juntos.
    // Para más de 3, se aproxima agrupando en cajas de 3.
    if (individualQty <= 3) {
      const spec = PACKAGE_SPECS[individualQty];
      packages.push(packageFromSpec(spec, 1));
    } else {
      const boxesOf3 = Math.floor(individualQty / 3);
      const remainder = individualQty % 3;
      if (boxesOf3 > 0) packages.push(packageFromSpec(PACKAGE_SPECS[3], boxesOf3));
      if (remainder > 0) packages.push(packageFromSpec(PACKAGE_SPECS[remainder], 1));
    }
  }

  if (pack4Qty > 0) {
    packages.push(packageFromSpec(PACKAGE_SPECS.pack4, pack4Qty));
  }

  return packages;
}

function packageFromSpec(spec, amount) {
  return {
    type: 'box',
    content: 'Grip socks',
    amount,
    declaredValue: 249 * amount,
    weight: spec.weight,
    weightUnit: 'KG',
    lengthUnit: 'CM',
    dimensions: { length: spec.length, width: spec.width, height: spec.height }
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  const token = process.env.ENVIA_TOKEN;
  if (!token) {
    console.error('[shipping-rate] ENVIA_TOKEN no configurado');
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'ENVIA_TOKEN no configurado en el servidor' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    console.error('[shipping-rate] Body inválido:', event.body);
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Body inválido' }) };
  }

  const { postalCode, cart } = body;
  console.log('[shipping-rate] Request:', { postalCode, cart, envBase: ENVIA_BASE });

  if (!/^\d{5}$/.test(postalCode || '')) {
    console.error('[shipping-rate] CP inválido:', postalCode);
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Código postal inválido' }) };
  }
  if (!cart || Object.keys(cart).length === 0) {
    console.error('[shipping-rate] Carrito vacío');
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Carrito vacío' }) };
  }

  // Zona cercana con tarifa fija: se responde de inmediato, sin llamar a Postali ni a Envia.
  if (FIXED_RATE_POSTAL_CODES.has(postalCode)) {
    console.log('[shipping-rate] CP en zona de tarifa fija:', postalCode);
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        cost: FIXED_RATE_COST,
        carrier: 'Envío local Marea',
        service: 'Tarifa fija zona cercana',
        deliveryEstimate: null,
        municipio: null,
        estado: null
      })
    };
  }

  const packages = buildPackages(cart);
  console.log('[shipping-rate] Packages:', JSON.stringify(packages));

  const carriersToQuote = await getActiveCarriers(token);

  const location = await resolveLocation(postalCode);
  if (!location) {
    console.error('[shipping-rate] No se pudo resolver ubicación para CP:', postalCode);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'Código postal no encontrado' }) };
  }
  console.log('[shipping-rate] Location:', location);

  const destination = {
    name: 'Cliente Marea',
    phone: '+52 0000000000',
    street: 'N/A',
    city: location.municipio || location.estado,
    state: location.stateCode,
    country: 'MX',
    postalCode
  };

  const ratePromises = carriersToQuote.map((carrier) =>
    fetch(`${ENVIA_BASE}/ship/rate/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        origin: ORIGIN,
        destination,
        packages,
        shipment: { type: 1, carrier }
      })
    })
      .then(async (r) => {
        const json = await r.json().catch(() => null);
        if (!r.ok) {
          console.error(`[shipping-rate] Envia respondió ${r.status} para carrier=${carrier}:`, JSON.stringify(json));
        }
        return json;
      })
      .catch((err) => {
        console.error(`[shipping-rate] Fetch falló para carrier=${carrier}:`, err.message);
        return null;
      })
  );

  try {
    const results = await Promise.allSettled(ratePromises);
    const rates = results
      .filter((r) => r.status === 'fulfilled' && r.value && r.value.data && r.value.data.length)
      .flatMap((r) => r.value.data)
      .sort((a, b) => parseFloat(a.totalPrice) - parseFloat(b.totalPrice));

    if (rates.length === 0) {
      console.error('[shipping-rate] Sin cotizaciones. Resultados crudos:', JSON.stringify(results));
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'Sin cotizaciones disponibles para ese código postal' }) };
    }

    const best = rates[0];
    console.log('[shipping-rate] Mejor cotización:', best);
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        cost: Math.round(parseFloat(best.totalPrice)),
        carrier: best.carrier,
        service: best.serviceDescription || best.service,
        deliveryEstimate: best.deliveryEstimate || null,
        municipio: location.municipio,
        estado: location.estado
      })
    };
  } catch (err) {
    console.error('[shipping-rate] Error inesperado:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Error consultando Envia.com' }) };
  }
};
