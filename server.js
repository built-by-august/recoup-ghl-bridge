import express from 'express';

const PORT = process.env.PORT || 3000;
const GHL_API_TOKEN = process.env.GHL_API_TOKEN || '';
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || '';
const GHL_API_BASE = (process.env.GHL_API_BASE || 'https://rest.gohighlevel.com/v1').replace(/\/+$/, '');

const GHL_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${GHL_API_TOKEN}`,
  Version: '2021-07-28',
};

const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID || '';
const GHL_STAGE_LEAD = process.env.GHL_STAGE_LEAD || '';
const GHL_STAGE_AUDIT_BOOKED = process.env.GHL_STAGE_AUDIT_BOOKED || '';
const GHL_STAGE_AUDIT_DELIVERED = process.env.GHL_STAGE_AUDIT_DELIVERED || '';
const GHL_STAGE_PILOT_PROPOSED = process.env.GHL_STAGE_PILOT_PROPOSED || '';
const GHL_STAGE_BUILD_ACTIVE = process.env.GHL_STAGE_BUILD_ACTIVE || '';
const GHL_STAGE_PARTNER = process.env.GHL_STAGE_PARTNER || '';

function warnMissingEnv() {
  if (!GHL_API_TOKEN) console.error('MISSING ENV: GHL_API_TOKEN');
  if (!GHL_LOCATION_ID) console.error('MISSING ENV: GHL_LOCATION_ID');
}

async function ghlPost(path, body) {
  const url = `${GHL_API_BASE}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: GHL_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = data ? JSON.stringify(data) : `${resp.status} ${resp.statusText}`;
    throw new Error(`GHL ${path} ${resp.status}: ${msg}`);
  }
  return data;
}

async function ghlPut(path, body) {
  const url = `${GHL_API_BASE}${path}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: GHL_HEADERS,
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = data ? JSON.stringify(data) : `${resp.status} ${resp.statusText}`;
    throw new Error(`GHL ${path} ${resp.status}: ${msg}`);
  }
  return data;
}

function validateLeadPayload(body) {
  const errors = [];
  if (!body.email && !body.phone) errors.push('email or phone is required');
  if (!body.name) errors.push('name is required');
  return errors;
}

function mapCustomFields(body) {
  const fields = [];
  if (body.business_type) fields.push({ key: 'business_type', value: body.business_type });
  if (body.waste_signals) fields.push({ key: 'waste_signals', value: Array.isArray(body.waste_signals) ? body.waste_signals.join(', ') : body.waste_signals });
  if (body.estimated_waste_usd != null) fields.push({ key: 'estimated_waste_$_month', value: String(body.estimated_waste_usd) });
  if (body.company_size) fields.push({ key: 'company_size', value: body.company_size });
  if (body.audit_date) fields.push({ key: 'audit_date', value: body.audit_date });
  if (body.audit_notes_url) fields.push({ key: 'audit_notes_url', value: body.audit_notes_url });
  return fields;
}

const app = express();

app.use(express.json({ limit: '100kb' }));

app.get('/', (_req, res) => {
  res.json({
    service: 'recoup-ghl-bridge',
    endpoints: ['GET /health', 'POST /webhook/lead', 'POST /webhook/ghl'],
    env: {
      ghl_token_set: !!GHL_API_TOKEN,
      location_id_set: !!GHL_LOCATION_ID,
      pipeline_id_set: !!GHL_PIPELINE_ID,
      stage_lead_set: !!GHL_STAGE_LEAD,
      ghl_api_base: GHL_API_BASE,
    },
  });
});

app.get('/health', (_req, res) => {
  const ok = !!(GHL_API_TOKEN && GHL_LOCATION_ID);
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    ghl_token_set: !!GHL_API_TOKEN,
    location_id_set: !!GHL_LOCATION_ID,
  });
});

app.post('/webhook/lead', async (req, res) => {
  warnMissingEnv();

  const validationErrors = validateLeadPayload(req.body);
  if (validationErrors.length > 0) {
    return res.status(400).json({ error: 'validation failed', details: validationErrors });
  }

  const { name, email, phone, website, notes: rawNotes, ...rest } = req.body;

  try {
    const contactPayload = { locationId: GHL_LOCATION_ID, name };
    if (email) contactPayload.email = email;
    if (phone) contactPayload.phone = phone;
    if (website) contactPayload.website = website;

    const contact = await ghlPost('/contacts/upsert', contactPayload);
    const contactId = contact.contact?.id;

    if (!contactId) {
      throw new Error('contact upsert returned no ID');
    }

    if (rawNotes) {
      const notesText = typeof rawNotes === 'string' ? rawNotes : JSON.stringify(rawNotes);
      await ghlPost(`/contacts/${contactId}/notes`, {
        body: notesText,
        userId: null,
      });
    }

    const customFields = mapCustomFields(req.body);
    if (customFields.length > 0) {
      await Promise.all(
        customFields.map((field) =>
          ghlPost(`/contacts/${contactId}/customFields`, field)
        )
      );
    }

    const opportunityPayload = {
      locationId: GHL_LOCATION_ID,
      contactId,
      name,
      status: 'open',
      monetaryValue: rest.estimated_waste_usd || 0,
    };
    if (GHL_PIPELINE_ID) opportunityPayload.pipelineId = GHL_PIPELINE_ID;
    if (GHL_STAGE_LEAD) opportunityPayload.pipelineStageId = GHL_STAGE_LEAD;

    const opportunity = await ghlPost('/opportunities/', opportunityPayload);

    res.status(200).json({
      ok: true,
      contactId,
      opportunityId: opportunity.id || opportunity.opportunity?.id || null,
    });
  } catch (err) {
    console.error('webhook/lead error:', err.message);
    res.status(502).json({ error: 'upstream request failed', detail: err.message });
  }
});

app.post('/webhook/ghl', async (req, res) => {
  const event = req.body;
  console.log('GHL webhook received:', JSON.stringify({ type: event.type, data: event }));
  res.status(200).json({ ok: true });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err.message);
  res.status(500).json({ error: 'internal server error' });
});

app.listen(PORT, () => {
  console.log(`recoup-ghl-bridge listening on :${PORT}`);
  warnMissingEnv();
});
