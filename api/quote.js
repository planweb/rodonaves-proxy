function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

const BRAZIL_STATE_CODES = {
  acre: "AC",
  alagoas: "AL",
  amapa: "AP",
  amazonas: "AM",
  bahia: "BA",
  ceara: "CE",
  "distrito federal": "DF",
  "espirito santo": "ES",
  goias: "GO",
  maranhao: "MA",
  "mato grosso": "MT",
  "mato grosso do sul": "MS",
  "minas gerais": "MG",
  para: "PA",
  paraiba: "PB",
  parana: "PR",
  pernambuco: "PE",
  piaui: "PI",
  "rio de janeiro": "RJ",
  "rio grande do norte": "RN",
  "rio grande do sul": "RS",
  rondonia: "RO",
  roraima: "RR",
  "santa catarina": "SC",
  "sao paulo": "SP",
  sergipe: "SE",
  tocantins: "TO",
};

function normalizeText(value) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function normalizeState(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (normalized.length === 2) return normalized.toUpperCase();
  return BRAZIL_STATE_CODES[normalized] || null;
}

function normalizeZip(value) {
  return (value || "").replace(/\D/g, "");
}

function buildRodonavesAddress(address, fallbackZip) {
  const city = (address?.city || "").trim();
  const state = normalizeState(address?.province);
  const zipCode = normalizeZip(address?.zipcode || address?.postal_code) || fallbackZip;

  if (!city || !state || !zipCode) return null;

  return {
    ZipCode: zipCode,
    TypeAddress: null,
    Address: (address?.address || "").trim() || city,
    Number: (address?.number || "").trim() || "S/N",
    Supplement: (address?.floor || "").trim() || null,
    District: (address?.locality || "").trim() || city,
    City: city,
    UnitFederation: state,
    TaxIdRegistration: normalizeZip(address?.tax_id_registration) || null,
    LocSit: null,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  const startTime = Date.now();

  try {
    const {
      username,
      password,
      cnpj,
      origin_zip,
      dest_zip,
      total_weight,
      total_value,
      total_volumes,
      packs,
      origin_address,
      destination_address,
    } = req.body;

    if (!username || !password || !origin_zip || !dest_zip) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const authBody = `auth_type=DEV&grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

    // Step 1: Get tokens in parallel
    const [dneTokenRes, quotTokenRes] = await Promise.all([
      fetchWithTimeout("https://dne-api.rte.com.br/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: authBody,
      }),
      fetchWithTimeout("https://quotation-apigateway.rte.com.br/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: authBody,
      }),
    ]);

    if (!dneTokenRes.ok || !quotTokenRes.ok) {
      console.error("Token error:", dneTokenRes.status, quotTokenRes.status);
      return res.status(401).json({ success: false, error: "Authentication failed" });
    }

    const [dneTokenData, quotTokenData] = await Promise.all([dneTokenRes.json(), quotTokenRes.json()]);
    console.log(`Tokens acquired in ${Date.now() - startTime}ms`);

    // Step 2: Get city IDs in parallel
    const originZip = origin_zip.replace(/\D/g, "");
    const destZip = dest_zip.replace(/\D/g, "");

    const [originCityRes, destCityRes] = await Promise.all([
      fetchWithTimeout(`https://dne-api.rte.com.br/api/cities/byzipcode?zipCode=${originZip}`, {
        headers: { Authorization: `Bearer ${dneTokenData.access_token}` },
      }),
      fetchWithTimeout(`https://dne-api.rte.com.br/api/cities/byzipcode?zipCode=${destZip}`, {
        headers: { Authorization: `Bearer ${dneTokenData.access_token}` },
      }),
    ]);

    if (!originCityRes.ok || !destCityRes.ok) {
      return res.status(400).json({ success: false, error: "City lookup failed" });
    }

    const originCity = await originCityRes.json();
    const destCity = await destCityRes.json();

    const originCityId = originCity?.CityId || originCity?.Id || originCity?.id || originCity?.cityId;
    const destCityId = destCity?.CityId || destCity?.Id || destCity?.id || destCity?.cityId;

    if (!originCityId || !destCityId) {
      return res.status(400).json({ success: false, error: "Could not resolve city IDs" });
    }

    console.log(`Cities resolved in ${Date.now() - startTime}ms: origin=${originCityId} dest=${destCityId}`);

    // Step 3: Quotation
    const quotationBody = {
      OriginCityId: originCityId,
      OriginZipCode: originZip,
      DestinationCityId: destCityId,
      DestinationZipCode: destZip,
      TotalWeight: total_weight,
      EletronicInvoiceValue: total_value,
      CustomerTaxIdRegistration: (cnpj || "").replace(/\D/g, ""),
      ReceiverCpfcnpj: "00669274127",
      ReceiverCpfcnp: "00669274127",
      ContactName: "Cliente",
      ContactPhoneNumber: "11999999999",
      TotalPackages: packs?.reduce((sum, p) => sum + (p.AmountPackages || 1), 0) || total_volumes || 1,
      Packs: packs || [{ AmountPackages: 1, Weight: Math.max(total_weight, 0.3), Length: 20, Height: 20, Width: 20 }],
      ...(buildRodonavesAddress(origin_address, originZip)
        ? { PickupAddress: buildRodonavesAddress(origin_address, originZip) }
        : {}),
      ...(buildRodonavesAddress(destination_address, destZip)
        ? { DestinationAddress: buildRodonavesAddress(destination_address, destZip) }
        : {}),
    };

    const quotRes = await fetchWithTimeout("https://quotation-apigateway.rte.com.br/api/v1/gera-cotacao", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${quotTokenData.access_token}`,
      },
      body: JSON.stringify(quotationBody),
    });

    if (!quotRes.ok) {
      const errText = await quotRes.text();
      console.error("Quotation error:", quotRes.status, errText);
      return res.status(quotRes.status).json({ success: false, error: `Quotation API error: ${quotRes.status}`, details: errText });
    }

    const quotData = await quotRes.json();
    console.log(`Quote completed in ${Date.now() - startTime}ms`);

    return res.status(200).json({ success: true, data: quotData });
  } catch (err) {
    console.error("Error:", err, `elapsed: ${Date.now() - startTime}ms`);
    const message = err?.name === "AbortError" ? "Request timeout" : err?.message || "Unknown error";
    return res.status(500).json({ success: false, error: message });
  }
}
