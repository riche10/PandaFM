# Security

PandaFM is self-hosted software that holds your music server credentials and
listening history, so security reports are very welcome.

## Reporting a vulnerability

Please report privately through GitHub's **Report a vulnerability** button
(Security → Advisories) on this repository rather than in a public issue.
Include the version, how to reproduce it, and the impact you see.

## Supported versions

Fixes go into the latest release. Please upgrade before reporting.

## How PandaFM protects things

The design (owner account, sessions, device tokens, CSRF, setup token, trusted
proxies, how the music server password is encrypted, what anonymous health
checks reveal) is described in [docs/security.md](docs/security.md).
