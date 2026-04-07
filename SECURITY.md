# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Please report vulnerabilities by emailing **security@linchkit.dev**.

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 1 week
- **Fix or mitigation:** depends on severity, typically within 2 weeks for critical issues

## Scope

The following are in scope:
- `@linchkit/core` — engines, pipeline, types
- `@linchkit/cli` — CLI commands
- `@linchkit/cap-*` — official capability packages
- SQL injection, XSS, authentication bypass, authorization issues

Out of scope:
- Third-party dependencies (report upstream)
- Issues in demo/example code only
