const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// AIRTABLE CONFIG
// ============================================================
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE  = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = 'Tickets';
const AIRTABLE_URL   = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;

const airtableHeaders = {
  Authorization: `Bearer ${AIRTABLE_TOKEN}`,
  'Content-Type': 'application/json',
};

// ============================================================
// EMAIL TRANSPORTER (Gmail)
// ============================================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'A.S.P Ticketing API is live ✓' });
});

// ============================================================
// PROCESS TICKET — called by landing page after payment
// ============================================================
app.post('/process-ticket', async (req, res) => {
  const { reference, name, email, phone } = req.body;
  console.log('Received /process-ticket:', { reference, name, email, phone });

  if (!reference || !email || !name) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }

  try {
    // 1. Verify payment with Paystack
    console.log('Verifying with Paystack...');
    const paystackRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    const txData = paystackRes.data.data;
    console.log('Paystack status:', txData.status, '| Amount (kobo):', txData.amount);

    if (txData.status !== 'success') {
      return res.status(402).json({ status: 'error', message: 'Payment not confirmed by Paystack' });
    }

    // 2. Check for duplicate
    const exists = await ticketExists(reference);
    if (exists) {
      console.log('Duplicate ticket request for reference:', reference);
      return res.json({ status: 'duplicate', message: 'Ticket already issued' });
    }

    const amountGHS = txData.amount / 100;

    // 3. Process and issue ticket
    await processAndIssueTicket({ reference, amountGHS, email, phone, name });

    res.json({ status: 'success', message: 'Ticket issued and sent!' });

  } catch (err) {
    console.error('process-ticket error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============================================================
// PAYSTACK WEBHOOK — failsafe if browser closes after payment
// ============================================================
app.post('/webhook', async (req, res) => {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).send('Invalid signature');
  }

  const { event, data } = req.body;
  if (event !== 'charge.success') return res.sendStatus(200);

  console.log('Webhook received for reference:', data.reference);

  try {
    const exists = await ticketExists(data.reference);
    if (exists) return res.sendStatus(200);

    const name  = extractMeta(data, 'full_name')    || `${data.customer.first_name || ''} ${data.customer.last_name || ''}`.trim();
    const phone = extractMeta(data, 'phone_number') || data.customer.phone || '';

    await processAndIssueTicket({
      reference: data.reference,
      amountGHS: data.amount / 100,
      email: data.customer.email,
      phone,
      name,
    });
  } catch (err) {
    console.error('Webhook error:', err.message);
  }

  res.sendStatus(200);
});

// ============================================================
// CHECK-IN — staff door app
// ============================================================
app.get('/checkin', async (req, res) => {
  const { ticketId, staffKey } = req.query;

  if (staffKey !== process.env.STAFF_KEY) {
    return res.status(401).json({ status: 'unauthorized' });
  }

  try {
    const record = await findTicketRecord(ticketId);

    if (!record) {
      return res.json({ status: 'not_found', message: 'INVALID TICKET' });
    }

    if (record.fields['Status'] === 'USED') {
      return res.json({
        status: 'already_used',
        message: 'TICKET ALREADY SCANNED',
        name: record.fields['Name'],
        ticketType: record.fields['Ticket Type'],
      });
    }

    // Mark as USED
    await axios.patch(`${AIRTABLE_URL}/${record.id}`, {
      fields: {
        Status: 'USED',
        'Check-In Time': new Date().toISOString(),
      },
    }, { headers: airtableHeaders });

    return res.json({
      status: 'success',
      message: 'VALID — ADMIT',
      name: record.fields['Name'],
      ticketType: record.fields['Ticket Type'],
      ticketId,
    });

  } catch (err) {
    console.error('Checkin error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============================================================
// VERIFY — read-only lookup for staff
// ============================================================
app.get('/verify', async (req, res) => {
  const { ticketId } = req.query;
  try {
    const record = await findTicketRecord(ticketId);
    if (!record) return res.json({ found: false });
    return res.json({
      found: true,
      name: record.fields['Name'],
      ticketType: record.fields['Ticket Type'],
      status: record.fields['Status'],
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============================================================
// CORE LOGIC
// ============================================================
async function processAndIssueTicket({ reference, amountGHS, email, phone, name }) {
  const ticketType = amountGHS >= Number(process.env.VIP_AMOUNT) ? 'VIP' : 'Regular';
  const ticketId   = generateTicketId(ticketType, reference);
  const qrData     = `${name} | ${ticketId} | ${ticketType.toUpperCase()}`;

  console.log(`Issuing ticket: ${ticketId} | ${ticketType} | ${email}`);

  await saveTicketToAirtable({ name, email, phone, ticketType, ticketId, reference, qrData, amountGHS });
  await sendTicketEmail({ name, email, ticketType, ticketId, qrData, reference, amountGHS });

  console.log(`✓ Ticket issued and emailed: ${ticketId} → ${email}`);
}

function generateTicketId(type, reference) {
  const suffix = reference.slice(-5).toUpperCase();
  const rand   = Math.floor(100 + Math.random() * 900);
  const prefix = type === 'VIP' ? 'VIP' : 'REG';
  return `${prefix}-ASP-${suffix}-${rand}`;
}

// ============================================================
// AIRTABLE FUNCTIONS
// ============================================================
async function saveTicketToAirtable({ name, email, phone, ticketType, ticketId, reference, qrData, amountGHS }) {
  const response = await axios.post(AIRTABLE_URL, {
    fields: {
      Timestamp:         new Date().toISOString(),
      Name:              name,
      Email:             email,
      Phone:             phone,
      'Ticket Type':     ticketType.toUpperCase(),
      'Ticket ID':       ticketId,
      'Transaction Ref': reference,
      'Amount (GHS)':    amountGHS,
      'QR Data':         qrData,
      Status:            'UNUSED',
      'Check-In Time':   '',
    },
  }, { headers: airtableHeaders });

  console.log('Saved to Airtable:', response.data.id);
  return response.data;
}

async function ticketExists(reference) {
  try {
    const response = await axios.get(AIRTABLE_URL, {
      headers: airtableHeaders,
      params: {
        filterByFormula: `{Transaction Ref} = '${reference}'`,
        maxRecords: 1,
      },
    });
    return response.data.records.length > 0;
  } catch {
    return false;
  }
}

async function findTicketRecord(ticketId) {
  const response = await axios.get(AIRTABLE_URL, {
    headers: airtableHeaders,
    params: {
      filterByFormula: `{Ticket ID} = '${ticketId}'`,
      maxRecords: 1,
    },
  });
  return response.data.records[0] || null;
}

// ============================================================
// EMAIL
// ============================================================
async function sendTicketEmail({ name, email, ticketType, ticketId, qrData, reference, amountGHS }) {
  const isVip  = ticketType === 'VIP';
  const accent = isVip ? '#C9A84C' : '#888888';
  const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrData)}&bgcolor=0A0A0A&color=C9A84C&qzone=2`;

  const html = `
<!DOCTYPE html><html><body style="margin:0;background:#0A0A0A;font-family:'Courier New',monospace;">
<table width="100%" style="padding:40px 20px;"><tr><td align="center">
<table width="560" style="max-width:560px;width:100%;">
  <tr><td style="text-align:center;padding:0 0 24px;">
    <h1 style="font-family:Georgia,serif;font-size:52px;color:#F2EDE4;margin:0;letter-spacing:-0.02em;">A.S.P</h1>
    <p style="font-size:10px;letter-spacing:0.25em;color:${accent};text-transform:uppercase;margin:8px 0 0;">
      ${isVip ? '&#x2736; VIP Experience &#x2736;' : 'General Entry'}</p>
  </td></tr>
  <tr><td style="background:#141414;border:1px solid ${accent}44;">
    <table width="100%"><tr>
      <td style="padding:32px;vertical-align:top;width:55%;">
        <p style="font-size:9px;letter-spacing:0.2em;color:#666;margin:0 0 4px;text-transform:uppercase;">Guest</p>
        <p style="font-size:20px;color:#F2EDE4;font-family:Georgia,serif;margin:0 0 20px;">${name}</p>
        <p style="font-size:9px;color:#666;margin:0 0 4px;text-transform:uppercase;">Ticket Type</p>
        <p style="font-size:14px;color:${accent};font-weight:bold;margin:0 0 20px;">${ticketType.toUpperCase()}</p>
        <p style="font-size:9px;color:#666;margin:0 0 4px;text-transform:uppercase;">Date</p>
        <p style="font-size:14px;color:#F2EDE4;margin:0 0 20px;">${process.env.EVENT_DATE} · ${process.env.EVENT_TIME}</p>
        <p style="font-size:9px;color:#666;margin:0 0 4px;text-transform:uppercase;">Amount Paid</p>
        <p style="font-size:14px;color:#F2EDE4;margin:0 0 20px;">GHS ${amountGHS}.00</p>
        <p style="font-size:9px;color:#666;margin:0 0 4px;text-transform:uppercase;">Ticket ID</p>
        <p style="font-size:14px;color:${accent};font-weight:bold;letter-spacing:0.1em;margin:0;">${ticketId}</p>
      </td>
      <td style="padding:32px;text-align:center;vertical-align:middle;">
        <img src="${qrUrl}" width="160" height="160" style="display:block;margin:0 auto;border:2px solid ${accent}44;">
        <p style="font-size:9px;color:#555;margin:12px 0 0;letter-spacing:0.1em;text-transform:uppercase;">Scan at entry</p>
      </td>
    </tr></table>
    <p style="text-align:center;font-size:10px;color:#444;padding:14px 32px;border-top:1px dashed ${accent}33;margin:0;">
      ${process.env.EVENT_LOCATION} &nbsp;·&nbsp; Ref: ${reference.slice(-8).toUpperCase()}
    </p>
  </td></tr>
  <tr><td style="padding:28px 0;text-align:center;">
    <p style="font-size:13px;color:#888;line-height:1.8;margin:0;">
      Hey ${name.split(' ')[0]}, your ticket is confirmed.<br>
      Show the QR code at the door for entry.<br>
      <span style="font-size:11px;color:#555;">Non-transferable. One entry only.</span>
    </p>
  </td></tr>
  <tr><td style="border-top:1px solid #1f1f1f;padding:24px 0;text-align:center;">
    <p style="font-size:9px;letter-spacing:0.2em;color:#444;text-transform:uppercase;margin:0;">A.S.P · Questions? Reply to this email</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  await transporter.sendMail({
    from: `"A.S.P" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `Your Ticket — A.S.P (${ticketId})`,
    text: `Ticket ID: ${ticketId} | ${ticketType.toUpperCase()} | ${process.env.EVENT_DATE}`,
    html,
  });

  console.log('Email sent to:', email);
}

function extractMeta(data, key) {
  const fields = (data.metadata?.custom_fields) || [];
  const field = fields.find(f => f.variable_name === key);
  return field?.value || '';
}

// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`A.S.P Ticketing API running on port ${PORT}`));

