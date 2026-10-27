# Local TLS test identity

`localhost-cert.pem` and its public test-only `localhost-key.pem` are disposable fixtures, not credentials for any deployed service. The certificate covers localhost and both loopback addresses; generated on 2026-10-26 with `openssl req -x509 -newkey rsa:2048 -nodes -days 3650` and a subjectAltName extension.

Tests trust this certificate only through a per-request `ca`. They do not alter the system trust store or disable certificate validation. Production relay connections never load these files. Renew the fixture before it expires in 2036.
