# SMTP setup — invitations, survey launches and demo alerts

SurveyKart never depends on a mail server being reachable: every invitation and
reminder is written to the `invites` outbox with the personal link it carried, and a
status of `queued`. Configure SMTP when you want those messages actually delivered.

The **Admin → Account desk → Mail & invitations** panel writes the settings for you
(`data/mail.json`, permissions `0600`), tests the connection, and sends a real test
message. The same settings can be provided as environment variables, which take
precedence — useful on hosts where the filesystem is replaced on every deploy.

| Setting | Environment variable | `data/mail.json` key |
| --- | --- | --- |
| SMTP host | `BEACON_SMTP_HOST` | `host` |
| Port (587 STARTTLS, 465 SSL) | `BEACON_SMTP_PORT` | `port` |
| Username | `BEACON_SMTP_USER` | `user` |
| Password / API key | `BEACON_SMTP_PASSWORD` | `password` |
| From address | `BEACON_SMTP_FROM` | `from` |
| Security | `BEACON_SMTP_TLS` = `starttls` \| `ssl` \| `none` | `tls` |

Demo-request alerts (and any team notifications) go to `DEMO_NOTIFY_EMAIL`, which
falls back to `ADMIN_EMAILS`:

```bash
ADMIN_EMAILS=you@company.com
DEMO_NOTIFY_EMAIL=sales@company.com,you@company.com
```

## Checking it on localhost

1. **In the app** — `/admin/console` → **Mail & invitations**: the summary line says
   *not configured* (with the reason) or shows the host / from-address. **Verify** opens one
   connection and logs in; **Send test** delivers a real message to the address you type.
2. **By API** — `GET /api/admin/console/smtp` returns
   `{"smtp": {"configured": true|false, "host": …, "port": …, "tls": …, "from": …}}`
   (never the password). `POST /api/admin/console/smtp/test {"to": "you@example.com"}`
   returns `{ok: true}` and the message arrives, or a `{error, hint}` pair that names the
   cause (App Password, TLS/port mismatch, blocked egress).
3. **By file / environment** — `ls -l data/mail.json` (mode `0600`, written by the panel) or
   `env | grep BEACON_SMTP` in the shell that starts the app. Process environment wins.

### No real mailbox? Catch the mail locally

`scripts/dev_smtp_sink.py` is a small SMTP server that prints every message instead of
sending it — perfect for checking invitations and demo alerts without a provider:

```bash
python3 scripts/dev_smtp_sink.py --port 1025
```

Then set host `127.0.0.1`, port `1025`, security **None**, a from-address such as
`SurveyKart <research@localhost>`, and **leave user/password empty** (the sink has no AUTH).
Press **Send test** — the raw message appears in the sink's terminal. Launching a study
prints the personal `/survey/<slug>?rid=…` link the same way. Press **Clear** in the panel
(or delete `data/mail.json`) to return to an unconfigured setup.

## Provider recipes

### Gmail / Google Workspace (personal or small team)

1. Google Account → **Security** → turn on **2-Step Verification**.
2. **App passwords** → create one for “Mail / SurveyKart”. Copy the 16 characters.
3. Settings:

```bash
BEACON_SMTP_HOST=smtp.gmail.com
BEACON_SMTP_PORT=587
BEACON_SMTP_TLS=starttls
BEACON_SMTP_USER=you@yourdomain.com
BEACON_SMTP_PASSWORD=the 16-character app password
BEACON_SMTP_FROM=Research Team <you@yourdomain.com>
```

Google Workspace admins can also require **less secure apps be off** (correct) —
App Passwords work regardless. If your organisation blocks App Passwords, use a
Workspace SMTP relay (`smtp-relay.gmail.com`, port 587) or a transactional provider.

### Microsoft 365 / Outlook

```bash
BEACON_SMTP_HOST=smtp.office365.com
BEACON_SMTP_PORT=587
BEACON_SMTP_TLS=starttls
BEACON_SMTP_USER=you@company.com
BEACON_SMTP_PASSWORD=your password (or app password if MFA)
```

SMTP AUTH must be enabled for that mailbox: Microsoft 365 admin → **Active users →
Mail → Manage email apps → Authenticated SMTP**.

### SendGrid

```bash
BEACON_SMTP_HOST=smtp.sendgrid.net
BEACON_SMTP_PORT=587
BEACON_SMTP_TLS=starttls
BEACON_SMTP_USER=apikey          # literally the word apikey
BEACON_SMTP_PASSWORD=SG.xxxxxx   # the API key
BEACON_SMTP_FROM=research@yourdomain.com
```

### Amazon SES

```bash
BEACON_SMTP_HOST=email-smtp.eu-west-1.amazonaws.com   # your region
BEACON_SMTP_PORT=587
BEACON_SMTP_TLS=starttls
BEACON_SMTP_USER=AKIA...                              # SES SMTP username
BEACON_SMTP_PASSWORD=...                              # SES SMTP password
BEACON_SMTP_FROM=research@yourdomain.com
```

SES starts in the sandbox: verify both the sender and every recipient, or request
production access. The host must be allowed to make outbound connections on 587.

### Mailgun

```bash
BEACON_SMTP_HOST=smtp.mailgun.org
BEACON_SMTP_PORT=587
BEACON_SMTP_TLS=starttls
BEACON_SMTP_USER=postmaster@mg.yourdomain.com
BEACON_SMTP_PASSWORD=...
BEACON_SMTP_FROM=research@yourdomain.com
```

## Deliverability checklist

* **From address must be a real mailbox** on the sending domain; many providers
  reject a mismatch between `From` and the authenticated user.
* Add **SPF** (`v=spf1 include:...  ~all`) and **DKIM** for the sending domain. For
  Gmail/Workspace this is automatic; for SendGrid/SES/Mailgun copy the DNS records
  from the provider dashboard.
* Keep `Reply-To` realistic — replies should reach your team, not a no-reply box.
* Send a test from the admin panel before inviting 200 respondents.

## Troubleshooting

| Symptom in the admin panel | Cause | Fix |
| --- | --- | --- |
| `the SMTP server rejected the username/password` | Using the account password where an App Password is required, or SMTP AUTH disabled | Create an App Password / enable Authenticated SMTP |
| `the server closed the connection` | TLS/port mismatch | 465 + `ssl`, or 587 + `starttls` |
| `TLS handshake failed` | Wrong port for the mode, or a private CA on the host | Match the mode to the port; check the host's CA bundle |
| `[Errno 111] Connection refused` / timeout | Outbound SMTP blocked (many PaaS block port 25, some block all SMTP) | Use 465/587, or the provider's HTTP API via its SMTP endpoint; ask the host to unblock egress |
| `(535, b'5.7.8 ...')` from Google | App Password revoked or 2FA off | Recreate the App Password |
| Messages send but land in spam | Missing SPF/DKIM/DMARC | Publish the provider's DNS records; use a subdomain for platform mail |

## What happens without SMTP

Nothing breaks. Invites and reminders stay in the outbox (`/api/studio/invites`,
`/api/studio/invites.csv`), each with its personal link and a `queued` status, and
the Launch panel says “recorded in the invite log”. Demo requests are stored in
`demo_requests` and shown in **Account desk → Demo requests**; the panel marks the
notification as `notify:queued` until SMTP is configured.
