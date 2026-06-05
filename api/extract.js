// ============================================================
// /api/extract.js — Vercel Serverless Function
// Proxy sécurisé vers l'API Anthropic.
// La clé API reste côté serveur (jamais exposée au navigateur).
// ============================================================

const EXTRACT_PROMPT = `You are extracting a starting list from a roller speed skating race.

OUTPUT FORMAT — CRITICAL:
Return ONLY a valid JSON array. No preamble. No explanation. No markdown fences. The very first character of your response MUST be "[" and the last "]".

Each entry must be: {"bib": number, "name": "FAMILYNAME Firstname", "club": "club name", "nat": "3-letter code", "cat": "Senior|Junior|Veteran|Youth"}

RULES:
- "bib" = the start number / dossard (column "Dos" or similar). Must be a number.
- "name" = family name in CAPS + first name. If columns "Nom" and "Prénom" exist, format as "NOM Prénom".
- "club" = the team/club name. Strip any category prefix like "SEH-", "JUH-", "VEH-", "DAH-". Keep the readable club name (e.g. "MANAO - FR SKATE WORLD TEAM", "ROLLER SPORT REZE", "TEAM JG"). This is the TACTICAL TEAM.
- "nat" = nationality as 3-letter IOC code. For French federation races, default to "FRA". If a club name explicitly mentions a country (e.g. "ESPAGNE", "Sobre Ruedas" = Spanish), use that country's code (ESP, ITA, etc.).
- "cat" = category derived from the prefix if present: SEH/SEF = "Senior", JUH/JUF = "Junior", VEH/VEF = "Veteran", CAH/CAF/MIH/MIF/BEH = "Youth". If unknown, use "Senior".
- Skip header rows and any row that is clearly not an athlete.

Return only the JSON array.`;

export default async function handler(req, res) {
  // CORS (utile si tu testes depuis un autre domaine)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Clé API absente. Ajoute ANTHROPIC_API_KEY dans les variables d'environnement Vercel."
    });
  }

  try {
    const { imageData, mediaType, pdfData, text } = req.body || {};

    const userContent = [];
    if (imageData) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData }
      });
      userContent.push({ type: 'text', text: EXTRACT_PROMPT });
    } else if (pdfData) {
      userContent.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdfData }
      });
      userContent.push({ type: 'text', text: EXTRACT_PROMPT });
    } else if (text) {
      userContent.push({ type: 'text', text: `${EXTRACT_PROMPT}\n\nTEXT TO PARSE:\n\n${text}` });
    } else {
      return res.status(400).json({ error: 'Ni image, ni PDF, ni texte fourni.' });
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await anthropicRes.json();

    if (data?.error) {
      return res.status(502).json({ error: `Anthropic: ${data.error.message || data.error.type}` });
    }

    const textResp = data?.content?.map(c => c.text || '').join('') || '';
    if (!textResp) {
      return res.status(502).json({ error: 'Réponse vide du modèle.' });
    }

    // Extraction robuste du tableau JSON
    let clean = textResp.replace(/```json|```/g, '').trim();
    const first = clean.indexOf('[');
    const last = clean.lastIndexOf(']');
    if (first >= 0 && last > first) clean = clean.slice(first, last + 1);

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(502).json({ error: 'JSON invalide renvoyé par le modèle.', raw: textResp.slice(0, 500) });
    }

    if (!Array.isArray(parsed)) {
      return res.status(502).json({ error: 'Format inattendu (pas un tableau).' });
    }

    const skaters = parsed
      .map((p, i) => ({
        id: i + 1,
        bib: Number(p.bib) || 0,
        name: p.name || `Patineur ${i + 1}`,
        club: p.club || '',
        nat: (p.nat || 'FRA').toUpperCase(),
        cat: p.cat || 'Senior'
      }))
      .filter(p => p.bib > 0);

    return res.status(200).json({ skaters });
  } catch (err) {
    return res.status(500).json({ error: `Erreur serveur: ${err.message}` });
  }
}
