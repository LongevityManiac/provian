/**
 * PINNED PUBLIC ROOTS, ONE SET PER SCHEME (Trust Layer build §2.9, ).
 *
 * Admission is "did a non-actor key sign this, against a public root" — pinned per SCHEME, never
 * per manufacturer, model, or device (no catalog of witnesses). Every root here is a vendor-
 * published certificate whose fingerprint is pinned beside it and re-verified by the suite (a
 * swapped PEM goes RED). The two JWT schemes (GCP Confidential Space, Azure Attestation) publish
 * their signing keys over TLS at a fixed issuer; their "root" is that issuer + key endpoint.
 */
import { parseCertificate, certFingerprintSha256 } from './x509';
import type { X509Certificate } from 'crypto';

export type HardwareScheme =
  | 'tpm2_quote'
  | 'apple_app_attest'
  | 'aws_nitro'
  | 'gcp_confidential_space'
  | 'azure_attestation'
  | 'nvidia_cc';

export const HARDWARE_SCHEMES: readonly HardwareScheme[] = [
  'tpm2_quote', 'apple_app_attest', 'aws_nitro', 'gcp_confidential_space', 'azure_attestation', 'nvidia_cc',
];

export function isHardwareScheme(v: unknown): v is HardwareScheme {
  return typeof v === 'string' && (HARDWARE_SCHEMES as readonly string[]).includes(v);
}

/** AWS Nitro Enclaves Root-G1 (https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip). */
export const AWS_NITRO_ROOT_G1_PEM = `-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----`;
export const AWS_NITRO_ROOT_G1_FINGERPRINT = '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';

/** Apple App Attestation Root CA (https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem). */
export const APPLE_APP_ATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;
export const APPLE_APP_ATTEST_ROOT_FINGERPRINT = '1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932';

/** NVIDIA Device Identity CA (nvtrust local_gpu_verifier/src/verifier/certs/verifier_device_root.pem). */
export const NVIDIA_DEVICE_IDENTITY_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICCzCCAZCgAwIBAgIQLTZwscoQBBHB/sDoKgZbVDAKBggqhkjOPQQDAzA1MSIw
IAYDVQQDDBlOVklESUEgRGV2aWNlIElkZW50aXR5IENBMQ8wDQYDVQQKDAZOVklE
SUEwIBcNMjExMTA1MDAwMDAwWhgPOTk5OTEyMzEyMzU5NTlaMDUxIjAgBgNVBAMM
GU5WSURJQSBEZXZpY2UgSWRlbnRpdHkgQ0ExDzANBgNVBAoMBk5WSURJQTB2MBAG
ByqGSM49AgEGBSuBBAAiA2IABA5MFKM7+KViZljbQSlgfky/RRnEQScW9NDZF8SX
gAW96r6u/Ve8ZggtcYpPi2BS4VFu6KfEIrhN6FcHG7WP05W+oM+hxj7nyA1r1jkB
2Ry70YfThX3Ba1zOryOP+MJ9vaNjMGEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8B
Af8EBAMCAQYwHQYDVR0OBBYEFFeF/4PyY8xlfWi3Olv0jUrL+0lfMB8GA1UdIwQY
MBaAFFeF/4PyY8xlfWi3Olv0jUrL+0lfMAoGCCqGSM49BAMDA2kAMGYCMQCPeFM3
TASsKQVaT+8S0sO9u97PVGCpE9d/I42IT7k3UUOLSR/qvJynVOD1vQKVXf0CMQC+
EY55WYoDBvs2wPAH1Gw4LbcwUN8QCff8bFmV4ZxjCRr4WXTLFHBKjbfneGSBWwA=
-----END CERTIFICATE-----`;

/**
 * Google Cloud "EK/AK CA Root" — issues the AK certificates every Compute Engine Shielded /
 * Confidential VM vTPM carries at NV 0x01c10000 (RSA) / 0x01c10002 (ECC)
 * (go-tpm-tools server/ca-certs/gcp_ek_ak_ca_root.crt). The `tpm2_quote` scheme's root set.
 */
export const GCE_EK_AK_CA_ROOT_PEM = `-----BEGIN CERTIFICATE-----
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
av16U4E=
-----END CERTIFICATE-----`;
/** sha256 of the published NVIDIA Device Identity CA DER (a literal, so a swapped PEM goes RED). */
export const NVIDIA_DEVICE_IDENTITY_CA_FINGERPRINT = '102bf659d5419614c9d8e6aecebc80454eb26b1df6a769ac720b9a690b167b48';

export const GCE_EK_AK_CA_ROOT_FINGERPRINT = '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2';

/** The current GCE intermediate, shipped so an AK chain that omits it still resolves (v3). */
export const GCE_EK_AK_CA_INTERMEDIATE_V3_PEM = `-----BEGIN CERTIFICATE-----
MIIHIjCCBQqgAwIBAgITZ2viLuozn1JgaG2giK96ZF5cPzANBgkqhkiG9w0BAQsF
ADB+MQswCQYDVQQGEwJVUzETMBEGA1UECBMKQ2FsaWZvcm5pYTEWMBQGA1UEBxMN
TW91bnRhaW4gVmlldzETMBEGA1UEChMKR29vZ2xlIExMQzEVMBMGA1UECxMMR29v
Z2xlIENsb3VkMRYwFAYDVQQDEw1FSy9BSyBDQSBSb290MCAXDTIyMDgyMzIyMjYy
OVoYDzIxMjIwNzA4MDU1NzIzWjCBhjELMAkGA1UEBhMCVVMxEzARBgNVBAgTCkNh
bGlmb3JuaWExFjAUBgNVBAcTDU1vdW50YWluIFZpZXcxEzARBgNVBAoTCkdvb2ds
ZSBMTEMxFTATBgNVBAsTDEdvb2dsZSBDbG91ZDEeMBwGA1UEAxMVRUsvQUsgQ0Eg
SW50ZXJtZWRpYXRlMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAoGMe
14Bhqh9kWnHW0VnqNl+Iake9KUANTgC12z+8ULqciIvDoiw0ezQ1fP/pwKhNRxcV
wP5+JgbJJluZw1lu1uV5trLs5yA/Er9CfVGX8CQF1TB7Zfv6Hf7hv7lv7eE986rd
a1oM55hJXEt0L3BvWfVpPibBloktSqqbSVzrBJrtSFi9P+Hhku6Bw6Zt1T/8/z6O
VdMbPNEhbPtCGFxmwyzKfb3wWU2YCIzZd7h53pV0ea1VJL3iGmRBJhC3Rkwvs3Qc
SZYYENft6x42jWSK/t2WrrZknP2Q67OFlhVL/gMo0NJ6bczovY03yRTnoDcN6YXK
qlc7iwPdUJn86jJHPL2s9KCWR/UDUGtb4PqZSaHQXA58N/tZSyQ48T0v+ar9CYVV
AIOV93VJDn13j0lZLax1bAkbzl0I7il1S+W2wEVx+K3WUf/29aBhRLZ3Ddkyj/Ta
8HxhMXpdOciddEXh2G4o/WaQAh3XCW8FGkKXjW8Ao7kBDBbpmCvlRvOtTBWetx9d
IOGzUkX53s3R1soUvMeZAP8208fe06+TOj+k7Mcn5qY1XuALzAKhZlR9hGw1pjKE
IUCKTJbfL+L2QDdP7OS2Kc2mBVQAcLu9PmaG++OZoVTlUrGd/6DBfKTEsN+aytWo
CRkJKu8kTWYyaMhXAYD1C4yp5xLQMKyFImNXumUCAwEAAaOCAYwwggGIMA4GA1Ud
DwEB/wQEAwIBBjAQBgNVHSUECTAHBgVngQUIATAPBgNVHRMBAf8EBTADAQH/MB0G
A1UdDgQWBBTpZnNUZ2Yb791lv+XoXOORC5sFUjAfBgNVHSMEGDAWgBRJ50pbVin1
nXm3pjA8A7KP5xTdTDCBjQYIKwYBBQUHAQEEgYAwfjB8BggrBgEFBQcwAoZwaHR0
cDovL3ByaXZhdGVjYS1jb250ZW50LTYyZDcxNzczLTAwMDAtMjFkYS04NTJlLWY0
ZjVlODBkNzc3OC5zdG9yYWdlLmdvb2dsZWFwaXMuY29tLzAzMmJmOWQzOWRiNGZh
MDZhYWRlL2NhLmNydDCBggYDVR0fBHsweTB3oHWgc4ZxaHR0cDovL3ByaXZhdGVj
YS1jb250ZW50LTYyZDcxNzczLTAwMDAtMjFkYS04NTJlLWY0ZjVlODBkNzc3OC5z
dG9yYWdlLmdvb2dsZWFwaXMuY29tLzAzMmJmOWQzOWRiNGZhMDZhYWRlL2NybC5j
cmwwDQYJKoZIhvcNAQELBQADggIBAJOunRNQRR4hxBRpzVWhAaSftC7mwvvys+p6
ZmUpbYAObjsaxRX+aucZF2jofS1VDPQy7j0aj8wTIhz0qv6jEvkMZH/E5fb2rC/S
Siqui51RwiTWi7Ry2XMuAbgG2suCirTL6O/iYed6vyJf07iysMK0o0bEeChEh3XP
QNrl+Dcdrff4fUG6SGGgx0IXWJHD9qqU895rYXCyFhJe+QCtPHg/HnYX//yGlm7x
hESYl0hgEVCITvu0YjNlKoBEiBMtHk0BHCeFkUm+pBydOjSl0BHUJs3UAJXuaYDp
/CjpnnYfRo8EF2Xy5/bCqFU+jrjYLz1xbOh28H4kNudZ3KV9jQoM+lDqmeM7rq79
r5ie1XfpC21tjxcAJktmxJP1hRpOtWoVtSJFLj05avqpDwt6AWDq2azquN7gjZFF
/vNB6fbK+w/Yi7ArSLyo2z18vABWNEiV032NG0jrXXYWoc6l8bfXUxwG6Ntkj2L8
p35ynxjR0mA73l7z920iBAl6rp15FfoR3LSzo1l+VaucnrWcnHow/kEFGqjtP8uE
mzQc5Rq+5Xd5/64jEcomGKNh+6b0gY3Y67q2NlrFa6Fo9vfzDwqdYSYzENb/PR3u
GFhkvoJzTWFXdsVypk0frMsX1chdbHOM4jzDNhHAbQNumH82E8avyKjepIf+EPC6
1pmPeRHX
-----END CERTIFICATE-----`;

/** GCP Confidential Space / Confidential VM attestation tokens: issuer + OIDC discovery (jwks_uri read from it). */
export const GCP_CONFIDENTIAL_ISSUER = 'https://confidentialcomputing.googleapis.com';
export const GCP_CONFIDENTIAL_OIDC_DISCOVERY = `${GCP_CONFIDENTIAL_ISSUER}/.well-known/openid-configuration`;

/** Azure Attestation: the issuer MUST be an `attest.azure.net` instance; its keys are served at `${iss}/certs`. */
export const AZURE_ATTESTATION_ISSUER_RE = /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.attest\.azure\.net$/i;

let cache: Map<string, X509Certificate[]> | null = null;
function parsedRoots(): Map<string, X509Certificate[]> {
  if (cache) return cache;
  const one = (pem: string): X509Certificate[] => { const c = parseCertificate(pem); return c ? [c] : []; };
  cache = new Map<string, X509Certificate[]>([
    ['aws_nitro', one(AWS_NITRO_ROOT_G1_PEM)],
    ['apple_app_attest', one(APPLE_APP_ATTEST_ROOT_PEM)],
    ['nvidia_cc', one(NVIDIA_DEVICE_IDENTITY_CA_PEM)],
    ['tpm2_quote', one(GCE_EK_AK_CA_ROOT_PEM)],
  ]);
  return cache;
}

/** The pinned X.509 root set for a certificate-chain scheme (empty for the JWT schemes). */
export function pinnedRootsFor(scheme: HardwareScheme): readonly X509Certificate[] {
  return parsedRoots().get(scheme) ?? [];
}

/**
 * The GCE intermediate the LIVE AK certificates chain through as of 2026-09-17 (serial
 * 810c77377ab97ccabab0c11be0eddba6ab3ff8, sha256 caec2771…; fetched from the leaf's AIA on the
 * Confidential VM `provian-tpm-proof`). Shipped beside v3 so a chain that carries only its leaf still
 * resolves. Never trusted as a root — it must itself chain to GCE_EK_AK_CA_ROOT_PEM.
 */
export const GCE_EK_AK_CA_INTERMEDIATE_2026_PEM = `-----BEGIN CERTIFICATE-----
MIIHIzCCBQugAwIBAgIUAIEMdzd6uXzKurDBG+Dt26arP/gwDQYJKoZIhvcNAQEL
BQAwfjELMAkGA1UEBhMCVVMxEzARBgNVBAgTCkNhbGlmb3JuaWExFjAUBgNVBAcT
DU1vdW50YWluIFZpZXcxEzARBgNVBAoTCkdvb2dsZSBMTEMxFTATBgNVBAsTDEdv
b2dsZSBDbG91ZDEWMBQGA1UEAxMNRUsvQUsgQ0EgUm9vdDAgFw0yNjA1MTkyMjIy
MjBaGA8yMTIyMDcwODA1NTcyM1owgYYxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpD
YWxpZm9ybmlhMRYwFAYDVQQHEw1Nb3VudGFpbiBWaWV3MRMwEQYDVQQKEwpHb29n
bGUgTExDMRUwEwYDVQQLEwxHb29nbGUgQ2xvdWQxHjAcBgNVBAMTFUVLL0FLIENB
IEludGVybWVkaWF0ZTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMu2
rPfkfRO7WRaMal5X7or7rJbEu0ymV0FFN9LSo+M+4+m0KVvYvsu/G5tMp2UwTOTY
HLhJ72nGn79SINaQWNQqFxiYl5+0HUXVDa1EI8qPcgpqIFH+9tGx3qYL76JVjMoZ
JpCnQPraYNXOvK1Vnm17gPEBLLZbh2toh3c/ZeEG8979i4uBFCE2u7i8Nh16/97N
vosJPe915vFTrxPwFuKtJZjIeimL1gwBmcltCE6dFh4WcfRmnXptoFG2ZZK2pz9X
/KVN4IPOm5PZ8L0lEZ+4vAO1SStbw2F5Qf6tQltDi4Ofv2a6NRm2UurmyqreUSyC
vkvg/dJ1GKX0szh4E8PrBsnBLZauXHr+xwtay35CFyqYs0gLfmcM31Cqcnc5uTj7
qZhyJJDc6IzY4Ti2wpWvxNlwE4DbnUuy7OvQzZ4SMkXUqFq4OjMcsJxHNjyyTSby
5NDTRcLp9C9BAj7W5s9S+cVq5OGmtd+jBImHXyUrfw5xspBLZ5tD1gi2swlQMdGP
Er+vFrt7U2LWkghETcwGEz4eNC0D4OZVIOyI7wIlF+Sq3Fn5jVmlY2MAEirjrC52
w+wOxOlb5wuFZkX7OxBgONYUuxr7Yk8yOSSyHGZWvf1bEZPN5N7IIaNLU/KsKQuL
we0DQfCfUy5K7IpXmj/1JAmtFKSqvXLxn29RAA4rAgMBAAGjggGMMIIBiDAOBgNV
HQ8BAf8EBAMCAQYwEAYDVR0lBAkwBwYFZ4EFCAEwDwYDVR0TAQH/BAUwAwEB/zAd
BgNVHQ4EFgQUVjTBCORkZub1UawjzXA6gdgsJa0wHwYDVR0jBBgwFoAUSedKW1Yp
9Z15t6YwPAOyj+cU3UwwgY0GCCsGAQUFBwEBBIGAMH4wfAYIKwYBBQUHMAKGcGh0
dHA6Ly9wcml2YXRlY2EtY29udGVudC02MmQ3MTc3My0wMDAwLTIxZGEtODUyZS1m
NGY1ZTgwZDc3Nzguc3RvcmFnZS5nb29nbGVhcGlzLmNvbS8wMzJiZjlkMzlkYjRm
YTA2YWFkZS9jYS5jcnQwgYIGA1UdHwR7MHkwd6B1oHOGcWh0dHA6Ly9wcml2YXRl
Y2EtY29udGVudC02MmQ3MTc3My0wMDAwLTIxZGEtODUyZS1mNGY1ZTgwZDc3Nzgu
c3RvcmFnZS5nb29nbGVhcGlzLmNvbS8wMzJiZjlkMzlkYjRmYTA2YWFkZS9jcmwu
Y3JsMA0GCSqGSIb3DQEBCwUAA4ICAQBo975MNElonvxS4flpRB5ykii3otWMMA1x
t1xca3gzapU6QjF6yfQliDdhoI3NaWSaLyWRrMtaa8WfUwr8kpwUukCAnftNQqzy
hE0obgjmMLLbSxIhVTTjlCJyFshD7Hic1xY1r0/QrC+HkzJKeFMIl8vmAPT98sxT
SmFY9FmQUeur+IXXwvMIFGhzshqo3gXNVxYw7DyBf/ey3jEV/jQQQqSvrR7O5vEV
ECXa9hlQkeq6ueZdPvkEY840b4zk9oDI6JzGTTSkbigCDzIRN+vCNuB+0JWKYmKi
qLh+Lia9l0qNhsZf3SxMbglJJM0spFmFMfYWig/Cx90+BEMv468T1M8iMWSPim8R
72w8zoDWQIkYm7h5M/9ie7OzVen6lr1BlNuOENEciG/6tkoLPuyQJNexJdGC/DMQ
0GeJnoznVUDY/OX9Td49gQEqr3wF8bxBC/nSd1EZKyWVoCwuVDGj5MOlOoHH8kkD
kBfEFfIAdyZLRWUJ/oJBuMgBHlcWM1NVGsaA8w4hJi0M6aI/cXg+uA2H0zVEbrH4
ht8HwCCkG9taS2hjtOJkygXJmHfP3F6XIs19FCUyqDm6eKZzcuhF1759W1CPeu1o
1PQogxY5EuNryG+pkxadqGHV0N0gr8PQr8xeiSkUnH+nUfyXY3CJKpFpKwxkp6aq
g+eZMkMkLg==
-----END CERTIFICATE-----`;

/** Well-known intermediates shipped for convenience (never trusted as roots). */
export function shippedIntermediatesFor(scheme: HardwareScheme): readonly X509Certificate[] {
  if (scheme === 'tpm2_quote') {
    return [GCE_EK_AK_CA_INTERMEDIATE_V3_PEM, GCE_EK_AK_CA_INTERMEDIATE_2026_PEM].map((pem) => parseCertificate(pem)).filter((c): c is X509Certificate => c !== null);
  }
  return [];
}

/** Every pinned root with its expected fingerprint — the suite re-derives each from the PEM (RED on a swap). */
export const PINNED_ROOT_FINGERPRINTS: ReadonlyArray<{ scheme: HardwareScheme; pem: string; fingerprint: string; subject: string }> = [
  { scheme: 'aws_nitro', pem: AWS_NITRO_ROOT_G1_PEM, fingerprint: AWS_NITRO_ROOT_G1_FINGERPRINT, subject: 'CN=aws.nitro-enclaves' },
  { scheme: 'apple_app_attest', pem: APPLE_APP_ATTEST_ROOT_PEM, fingerprint: APPLE_APP_ATTEST_ROOT_FINGERPRINT, subject: 'CN=Apple App Attestation Root CA' },
  { scheme: 'nvidia_cc', pem: NVIDIA_DEVICE_IDENTITY_CA_PEM, fingerprint: NVIDIA_DEVICE_IDENTITY_CA_FINGERPRINT, subject: 'CN=NVIDIA Device Identity CA' },
  { scheme: 'tpm2_quote', pem: GCE_EK_AK_CA_ROOT_PEM, fingerprint: GCE_EK_AK_CA_ROOT_FINGERPRINT, subject: 'CN=EK/AK CA Root' },
];

/** The root set a verifier uses: the pinned set, unless a test context overrides that scheme. */
export function rootsForScheme(scheme: HardwareScheme, ctx: { rootsOverride?: Partial<Record<HardwareScheme, readonly X509Certificate[]>> }): readonly X509Certificate[] {
  return ctx.rootsOverride?.[scheme] ?? pinnedRootsFor(scheme);
}
