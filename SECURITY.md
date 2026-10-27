# Security Policy

Japanese Novel runs entirely on your machine. The extension makes no network requests. Besides
its bundled Language Server, the only process it starts is the browser that opens the built HTML
for Print / Save as PDF, when the `jpnov.layout.print.browser` setting names one; otherwise the
OS default browser opens it. Nothing you write is sent anywhere unless you build the manuscript
and share the output yourself.

You may, however, open a manuscript written by someone else. The extension declares support for
[Workspace Trust](https://code.visualstudio.com/docs/editor/workspace-trust) in untrusted
workspaces, so opening a `.jpnov` or `.jpbook` file you did not write is a supported use case.
This policy is written against that threat model: a crafted manuscript or book file must not
cause the extension to read or write files you did not ask it to, execute script in the
preview, or produce HTML or EPUB output that does anything beyond displaying the text.

## Supported Versions

Only the latest release receives security fixes. It is published on the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=asagirimihatsu.jpnov),
with the same VSIX attached to the corresponding
[GitHub release](https://github.com/japanese-novel/vscode-jpnov/releases). These are the only
official distribution channels. Older releases are not patched, so please keep the extension up
to date. Reports against the `main` branch are also welcome.

## Reporting a Vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/japanese-novel/vscode-jpnov/security/advisories/new).
Reports may be written in Japanese or English. 日本語での報告も歓迎します。

> [!IMPORTANT]
> **Please do not disclose vulnerabilities through public issues, discussions, or pull requests.**
> **脆弱性については、公開のイシュー、ディスカッション、またはプルリクエストを通じて開示しないでください。**

A helpful report includes:

- A description of the vulnerability and its impact.
- The extension version, the VS Code (or VSCodium) version, and the operating system.
- Steps to reproduce, including a minimal sample file where applicable.

Use placeholder text in any sample. Please do not attach unpublished manuscripts, and do not
include credentials or other sensitive data unless the report cannot be made without them.

This project is maintained by a volunteer and does not offer a bug bounty.

## Scope

This policy covers the extension and its bundled Language Server as distributed through the
channels above, including:

- Parsing of `.jpnov` and `.jpbook` files.
- The preview and book list webviews.
- HTML, EPUB, and text output produced by the build.
- File access, path resolution, and the output directory setting.
- Communication between the extension client and the Language Server.
- Third-party dependencies bundled into the VSIX.

The website [jpnov.com](https://jpnov.com), built from the `website/` directory of this
repository and served as static pages, is also in scope.

Examples of relevant vulnerabilities include reading or writing files beyond what the user
requested, script from a manuscript executing in a webview or in the built HTML or EPUB,
manuscript contents being exposed to any destination the user did not choose, and any injection
vulnerability with a demonstrable security impact.

The following are out of scope:

- Vulnerabilities in VS Code, VSCodium, Node.js, browsers, or EPUB readers. Please report these
  upstream.
- Manuscripts that merely slow down or crash the extension. These are ordinary bugs; see below.
- Automated scanner results with no demonstrated impact on this extension.

Rendering defects, formatting errors, and other bugs without security implications should be
reported through [GitHub Issues](https://github.com/japanese-novel/vscode-jpnov/issues).

## Response and Disclosure

Reports are acknowledged within seven days where possible. Time to a fix depends on the severity
of the issue and on the availability of a single volunteer maintainer. Fixes are shipped as a
new release and documented in a GitHub Security Advisory for this repository, crediting the
reporter unless they prefer otherwise.

Please keep the details private until that release is available. Ninety days from
acknowledgment is a reasonable upper bound; if more time is needed, you will be told why before
then.
