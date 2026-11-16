import type {PairRecord} from '../../src/lib/pair-record/index.js';

/**
 * Throwaway self-signed certificates and keys for TLS tests. They protect nothing and are valid for
 * 100 years, so tests never depend on an `openssl` binary or on the date.
 */

export const DEVICE_CERT = `-----BEGIN CERTIFICATE-----
MIIBeDCCAR6gAwIBAgIURx5AirDF6oKfQr+W5o/krqZ8wPowCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWYXBwaXVtLWlvcyB0ZXN0IGRldmljZTAgFw0yNjExMTAxNDQ4
NTVaGA8yMTI2MTAxNzE0NDg1NVowITEfMB0GA1UEAwwWYXBwaXVtLWlvcyB0ZXN0
IGRldmljZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABG48iVFHQ5k9hsOewKuQ
c1hnLIWorQL1NGrxJGsJmiQea0ZHiaSxmSWHKZm8rmPjn65PDQ43HsC3opPveJXX
YWijMjAwMB0GA1UdDgQWBBQNkPZt4mtUPx8+m1IBVfXfW73H1TAPBgNVHRMBAf8E
BTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIG9Mtq0PEcHviXv1s8kKJVJzmxVuC/Se
Mo+FEWg3cG3NAiEA7japEPud2CEQJG96euEOF1QkZT7ozKQc02ZO293HWZk=
-----END CERTIFICATE-----
`;

export const DEVICE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgSSWJsC88unT3Tqms
PB+Jqq/eA6HWuuy7ZMpRk+nGvBqhRANCAARuPIlRR0OZPYbDnsCrkHNYZyyFqK0C
9TRq8SRrCZokHmtGR4mksZklhymZvK5j45+uTw0ONx7At6KT73iV12Fo
-----END PRIVATE KEY-----
`;

export const OTHER_CERT = `-----BEGIN CERTIFICATE-----
MIIBdjCCARygAwIBAgIUIvbJV9j7f9qPM2bD0Kp7bUjxTIYwCgYIKoZIzj0EAwIw
IDEeMBwGA1UEAwwVYXBwaXVtLWlvcyB0ZXN0IG90aGVyMCAXDTI2MTExMDE0NDg1
NVoYDzIxMjYxMDE3MTQ0ODU1WjAgMR4wHAYDVQQDDBVhcHBpdW0taW9zIHRlc3Qg
b3RoZXIwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAREXjT7ydNR7mfwO3vbbNBZ
WODiwDls4X6pu3XqIz8PrthMONPAePgR/jVKKOzsjnvomyc3LYkl9H6GwOIYXRfO
ozIwMDAdBgNVHQ4EFgQUqnzVDdblfIBzGfPeTNwsZW7QW58wDwYDVR0TAQH/BAUw
AwEB/zAKBggqhkjOPQQDAgNIADBFAiEAxKgPUokn7NkMCEfZXpve81y/FhN7Qq8l
mvDRa0vAQjcCIFvQ9zYJyYWSsUXCrDkc1wFfQpjmKoHp7ojvcWQxNXnk
-----END CERTIFICATE-----
`;

export const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgE++2H+uGigtkty2R
gVFmVL5FesTVD/sDXIBAXR3dJVuhRANCAAREXjT7ydNR7mfwO3vbbNBZWODiwDls
4X6pu3XqIz8PrthMONPAePgR/jVKKOzsjnvomyc3LYkl9H6GwOIYXRfO
-----END PRIVATE KEY-----
`;

/** A complete pair record whose host identity is OTHER_CERT and whose device presents DEVICE_CERT. */
export const PAIR_RECORD: PairRecord = {
  HostID: 'host-id',
  SystemBUID: 'system-buid',
  HostCertificate: OTHER_CERT,
  HostPrivateKey: OTHER_KEY,
  DeviceCertificate: DEVICE_CERT,
  RootCertificate: null,
  RootPrivateKey: null,
  WiFiMACAddress: null,
  EscrowBag: null,
};
