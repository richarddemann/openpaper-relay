# Add an institutional site

The browser adapter opens a DOI or article URL and follows a PDF link or button using your institutional session. For an API that searches by DOI/title and returns several versions, use [ADDING_SOURCES.md](ADDING_SOURCES.md) instead.

Each entry in `sites.local.json` is a small declarative adapter. No credentials or cookies belong in this file.

## 1. Identify the normal browser path

Using your ordinary browser, record the hostname—not the full signed URL—for each step:

1. Library landing page.
2. DOI/OpenURL resolver.
3. SSO identity provider reached during login.
4. Publisher landing page.
5. PDF host or publisher CDN.
6. Any hostname serving JavaScript or styles required for the download control.

Enter each exact hostname under `allowedNetworkHosts`. `publisher.example.com` does not automatically permit `pdf.publisher.example.com`; list both. Do not add broad shared domains unless the exact host is required.

Set the hosts accepted for article URLs and PDF downloads:

- `allowedPaperUrlHosts`: publisher landing-page hosts a caller may supply directly. Do not include SSO, resolver, library, analytics, or generic static-resource hosts.
- `allowedPdfHosts`: origins allowed to return the final PDF response or blob-backed download.

Both lists must be subsets of `allowedNetworkHosts`. A DOI still starts only at the configured resolver template.

## 2. Configure the resolver

`doiUrlTemplate` must be an HTTPS URL containing `{doi}`. Typical patterns include:

```text
https://resolver.example.edu/openurl?rft_id=info:doi/{doi}
https://login.proxy.example.edu/login?url=https://doi.org/{doi}
```

The template host and `startUrl` host must both be in `allowedNetworkHosts`.

Install the browser once before logging in:

```bash
npx playwright install chromium
```

## 3. Configure login detection

`loginUrlPatterns` are case-insensitive fragments seen only when authentication is required, such as `/saml`, `/login`, or `/authorize`. `loginPageSelectors` should identify a visible login control, usually `input[type=password]`.

Do not add logic that fills passwords, approves push prompts, copies one-time codes, solves CAPTCHAs, or suppresses the institution's security checks. The expected recovery is:

```bash
npm run login -- <site_id>
```

## 4. Configure PDF controls

Use Playwright selectors:

- `pdfLinkSelectors` for anchors with an `href`.
- `pdfClickSelectors` for JavaScript buttons that trigger a PDF response or browser download.

Prefer specific selectors exposed by the site, for example:

```json
"pdfLinkSelectors": ["a[data-test='pdf-link']", "a:has-text('Download PDF')"],
"pdfClickSelectors": ["button[data-action='download-pdf']"]
```

Avoid generic selectors such as `a`, `button`, or text that appears in unrelated navigation.

## 5. Troubleshoot

First run `npm run login -- <site_id>`. If a page is incomplete or a redirect fails, use the browser's address bar and developer tools to identify the exact missing hostname, decide whether it is necessary and trustworthy, then add only that hostname.

If the page loads but returns `not_found`, inspect the PDF link/button and update the selectors. If clicking it opens an HTML viewer, add that viewer's exact host and a selector for its eventual PDF control.

Do not respond to failures by allowing all subdomains, disabling URL validation, exposing a generic proxy, or copying session cookies into configuration.

## Multiple sites

Add another object to `sites`. Each site gets its own persistent Chromium profile under the private state directory and its own explicit host policy. The MCP caller must select a configured `site_id` for every fetch.
