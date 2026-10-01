# vox-trust.github.io

Source of the Vox Trust website, <https://vox-trust.github.io>. Plain static HTML and CSS: no build step, no JavaScript on the landing pages, no third-party requests.

## Pages

The landing page is published in five languages:

- `index.html`: English
- `pt/index.html`: Portuguese (Brazil)
- `es/index.html`: Spanish
- `zh/index.html`: Simplified Chinese
- `ar/index.html`: Arabic (right-to-left)

Also here:

- `demo/`: the live demo. It runs the Rust core compiled to WebAssembly in your browser, verifies real sealed files, and uploads nothing. The landing pages link to it with `?lang=xx`, which the demo reads client-side.
- `404.html`, `sitemap.xml`, `robots.txt`, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `og.png`.

The project itself lives in [vox-trust/vox-trust](https://github.com/vox-trust/vox-trust).

Licensed under Apache-2.0; page text under CC BY 4.0.
