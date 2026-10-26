"""
Local SMTP catcher for development - see exactly what SurveyKart sends.

    python3 scripts/dev_smtp_sink.py            # listens on 127.0.0.1:1025
    python3 scripts/dev_smtp_sink.py --port 2525

Then either put this in `.env`:

    BEACON_SMTP_HOST=127.0.0.1
    BEACON_SMTP_PORT=1025
    BEACON_SMTP_TLS=none
    BEACON_SMTP_FROM=SurveyKart <no-reply@localhost>
    # leave BEACON_SMTP_USER / BEACON_SMTP_PASSWORD empty - the sink has no AUTH

...or open **Admin -> Account desk -> Mail & invitations**, save host `127.0.0.1`,
port `1025`, security `None`, a from-address, and leave user/password blank.

Every message is printed to this terminal, and nothing leaves the machine.  Use it to
check invitations, reminders, team invites and demo-request alerts without a real
mailbox.  Stop it with Ctrl+C; delete `data/mail.json` (or press "Clear" in the admin
panel) to go back to an unconfigured mail setup.

This is a development tool: it accepts every message, keeps no queue and does not
implement AUTH or TLS.
"""

from __future__ import annotations

import argparse
import datetime
import socketserver
import sys


class _Handler(socketserver.StreamRequestHandler):
    """The smallest SMTP server that can accept a message from smtplib."""

    def _reply(self, line: bytes) -> None:
        self.wfile.write(line + b"\r\n")
        self.wfile.flush()

    def handle(self) -> None:
        self._reply(b"220 surveykart-sink ESMTP")
        sender, recipients, data_mode, body = "", [], False, []
        while True:
            line = self.rfile.readline()
            if not line:
                return
            if data_mode:
                if line.strip() == b".":
                    data_mode = False
                    self._print_message(sender, recipients, b"".join(body))
                    body = []
                    self._reply(b"250 2.0.0 OK: queued (local sink)")
                else:
                    body.append(line)
                continue
            command = line.strip().decode("utf-8", "replace")
            verb = command.split(" ", 1)[0].upper()
            if verb in ("EHLO", "HELO"):
                self.wfile.write(b"250-surveykart-sink\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n")
                self.wfile.flush()
            elif verb == "MAIL":
                sender = command.split(":", 1)[-1].strip().strip("<>")
                self._reply(b"250 2.1.0 Sender OK")
            elif verb == "RCPT":
                recipients.append(command.split(":", 1)[-1].strip().strip("<>"))
                self._reply(b"250 2.1.5 Recipient OK")
            elif verb == "DATA":
                data_mode = True
                self._reply(b"354 End data with <CR><LF>.<CR><LF>")
            elif verb == "RSET":
                sender, recipients, body = "", [], []
                self._reply(b"250 2.0.0 Reset")
            elif verb == "NOOP":
                self._reply(b"250 2.0.0 OK")
            elif verb == "QUIT":
                self._reply(b"221 2.0.0 Bye")
                return
            else:
                # AUTH and anything else we do not implement
                self._reply(b"502 5.5.1 Command not implemented")

    def _print_message(self, sender: str, recipients: list[str], payload: bytes) -> None:
        stamp = datetime.datetime.now().strftime("%H:%M:%S")
        print(f"\n{'=' * 78}\n[{stamp}] message from {sender or '(unknown)'} "
              f"to {', '.join(recipients) or '(no recipient)'}\n{'-' * 78}")
        sys.stdout.write(payload.decode("utf-8", "replace"))
        if not payload.endswith(b"\n"):
            sys.stdout.write("\n")
        print(f"{'=' * 78}\n", flush=True)


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser(description="Print SurveyKart e-mails instead of sending them.")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=1025, help="port (default 1025)")
    args = ap.parse_args()
    try:
        server = _Server((args.host, args.port), _Handler)
    except OSError as exc:
        print(f"Could not listen on {args.host}:{args.port} - {exc}", file=sys.stderr)
        return 1
    print(f"SurveyKart SMTP sink listening on {args.host}:{args.port}")
    print("Point BEACON_SMTP_HOST/PORT here (TLS=none, no user/password). Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
