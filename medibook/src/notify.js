// Booking events are logged and, if NOTIFY_WEBHOOK_URL is set, POSTed as JSON.
// Point the webhook at Zapier / Make / n8n / your own service to send SMS, WhatsApp
// or email confirmations and to sync with an existing calendar or EHR.

export function createNotifier({ webhookUrl = process.env.NOTIFY_WEBHOOK_URL, log = console.log } = {}) {
  return function notify(event) {
    const { type, clinic, appointment, details } = event;
    log(`[notify] ${type} ${clinic.slug} ${details.confirmation_code} ${details.when} (${details.doctor})`);
    if (!webhookUrl) return;
    const body = {
      type,
      clinic: { slug: clinic.slug, name: clinic.name, phone: clinic.phone, timezone: clinic.timezone },
      appointment: {
        ...details,
        start_at: appointment.start_at,
        end_at: appointment.end_at,
        patient_phone: appointment.patient_phone,
        patient_email: appointment.patient_email,
      },
      sent_at: new Date().toISOString(),
    };
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    }).catch((err) => console.error('[notify] webhook failed:', err.message));
  };
}
