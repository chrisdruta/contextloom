# Security Policy

## Reporting a vulnerability

Please report security issues via [GitHub Security Advisories](https://github.com/chrisdruta/contextloom/security/advisories/new) (private disclosure).

Do not open a public issue for vulnerabilities.

## Scope

ContextLoom is a read-only repository analyzer. Security-sensitive areas:

- Path traversal / workspace escape via link resolution
- Webview CSP and message protocol validation
- Hostile Markdown / YAML inputs (parser DoS, injection)
- Cache deserialization

We appreciate responsible disclosure and will credit reporters who wish to be named.
